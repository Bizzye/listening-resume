//! Process protocol shared with the Node adapter (`WasapiCaptureAdapter`): CLI arguments,
//! stdin commands and stdout line formats. Pure — no Windows dependencies — and unit-tested.
//!
//! stdout (one line each, flushed immediately):
//!   CHUNK:<absolute path>          chunk finalized
//!   LEVEL:<sys>,<mic>              every ~50 ms, 0..1 with 4 decimals (see `dsp::rms_to_level`)
//!   DEVICE:<sys>|<mic>|<changed>   on start (`both`) and whenever a source (re)opens or goes
//!                                  away (`sys` / `mic`: the source that changed). Older
//!                                  binaries sent only `DEVICE:<sys>|<mic>`; the Node parser
//!                                  accepts both forms.
//!   WARN:<message>                 non-fatal problem (device missing/lost → fell back, ...)
//!   DEVICES:<json>                 `--list-devices` only
//! stdin: `q`, `mute-sys`, `unmute-sys`, `mute-mic`, `unmute-mic`,
//!        `set-sys <name|@default|none>`, `set-mic <name|@default|none>`. EOF behaves like `q`.

use std::path::PathBuf;

/// Token that selects the OS default endpoint and follows it when it changes.
pub const DEFAULT_DEVICE: &str = "@default";

/// Which device a source should capture from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeviceSpec {
    /// Follow the Windows default endpoint (re-resolved live).
    Default,
    /// A specific endpoint, matched by friendly name.
    Named(String),
}

/// Parse a device argument. `None` means "no source" (`none`, case-insensitive).
/// The " (Loopback)" suffix shown by `--list-devices` display names is tolerated.
pub fn parse_device(raw: &str) -> Option<DeviceSpec> {
    let s = raw.trim();
    if s.eq_ignore_ascii_case("none") {
        return None;
    }
    if s.is_empty() || s.eq_ignore_ascii_case(DEFAULT_DEVICE) {
        return Some(DeviceSpec::Default);
    }
    let s = s.strip_suffix(" (Loopback)").unwrap_or(s);
    Some(DeviceSpec::Named(s.to_string()))
}

/// Discriminants double as indices into the mixer's slot array.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    System = 0,
    Mic = 1,
}

impl Source {
    pub fn label(self) -> &'static str {
        match self {
            Source::System => "system audio",
            Source::Mic => "microphone",
        }
    }
}

/// What a `DEVICE:` line is about (its third field), so the adapter can tell a line produced
/// by the source it just switched from one produced by the other source.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceChange {
    /// One source (re)opened or went away.
    Source(Source),
    /// Snapshot of both sources (the first line, after startup).
    Both,
}

impl DeviceChange {
    pub fn tag(self) -> &'static str {
        match self {
            DeviceChange::Source(Source::System) => "sys",
            DeviceChange::Source(Source::Mic) => "mic",
            DeviceChange::Both => "both",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Command {
    Quit,
    Mute(Source, bool),
    /// `None` device = remove the source.
    SetDevice(Source, Option<DeviceSpec>),
}

/// Parse one stdin line. Unknown/empty lines → `Err` with a short reason (logged to stderr).
pub fn parse_command(line: &str) -> Result<Command, String> {
    let line = line.trim();
    let (verb, arg) = match line.split_once(char::is_whitespace) {
        Some((v, a)) => (v, a.trim()),
        None => (line, ""),
    };
    let no_arg = |c: Command| {
        if arg.is_empty() {
            Ok(c)
        } else {
            Err(format!("'{verb}' takes no argument"))
        }
    };
    match verb {
        "q" | "quit" => no_arg(Command::Quit),
        "mute-sys" => no_arg(Command::Mute(Source::System, true)),
        "unmute-sys" => no_arg(Command::Mute(Source::System, false)),
        "mute-mic" => no_arg(Command::Mute(Source::Mic, true)),
        "unmute-mic" => no_arg(Command::Mute(Source::Mic, false)),
        "set-sys" | "set-mic" if arg.is_empty() => Err(format!("'{verb}' needs a device")),
        "set-sys" => Ok(Command::SetDevice(Source::System, parse_device(arg))),
        "set-mic" => Ok(Command::SetDevice(Source::Mic, parse_device(arg))),
        "" => Err("empty command".into()),
        other => Err(format!("unknown command '{other}'")),
    }
}

// ---------------------------------------------------------------------------------------------
// Output lines
// ---------------------------------------------------------------------------------------------

/// Protocol lines are line-delimited; a stray newline inside a device name would desync the
/// parser, so collapse any control characters to spaces.
fn sanitize(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect()
}

pub fn level_line(sys: f32, mic: f32) -> String {
    let f = |v: f32| {
        if v.is_finite() {
            v.clamp(0.0, 1.0)
        } else {
            0.0
        }
    };
    format!("LEVEL:{:.4},{:.4}", f(sys), f(mic))
}

pub fn device_line(sys: Option<&str>, mic: Option<&str>, changed: DeviceChange) -> String {
    format!(
        "DEVICE:{}|{}|{}",
        sanitize(sys.unwrap_or("")),
        sanitize(mic.unwrap_or("")),
        changed.tag()
    )
}

pub fn warn_line(msg: &str) -> String {
    format!("WARN:{}", sanitize(msg))
}

pub fn chunk_line(path: &std::path::Path) -> String {
    format!("CHUNK:{}", path.display())
}

pub fn chunk_file_name(prefix: &str, index: u32) -> String {
    format!("{prefix}_{index:04}.wav")
}

// ---------------------------------------------------------------------------------------------
// CLI arguments
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct CaptureArgs {
    /// `None` only in meter-only mode.
    pub output_dir: Option<PathBuf>,
    pub prefix: String,
    pub chunk_seconds: f64,
    pub sample_rate: u32,
    pub channels: u16,
    /// `None` = no system-audio source (mic-only); normally `Default` or `Named`.
    pub system: Option<DeviceSpec>,
    /// `None` = no microphone.
    pub mic: Option<DeviceSpec>,
    pub mic_volume: f32,
    pub meter_only: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Mode {
    ListDevices,
    PlayTone(DeviceSpec),
    Capture(CaptureArgs),
}

pub const DEFAULT_SAMPLE_RATE: u32 = 16_000;
pub const DEFAULT_CHANNELS: u16 = 1;
pub const DEFAULT_CHUNK_SECONDS: f64 = 120.0;
pub const DEFAULT_MIC_VOLUME: f32 = 1.2;

fn flag_value<'a>(args: &'a [String], flag: &str) -> Result<Option<&'a str>, String> {
    match args.iter().position(|a| a == flag) {
        None => Ok(None),
        Some(i) => match args.get(i + 1) {
            Some(v) if !v.starts_with("--") || v.len() <= 2 => Ok(Some(v.as_str())),
            _ => Err(format!("{flag} requires a value")),
        },
    }
}

fn parse_num<T: std::str::FromStr>(args: &[String], flag: &str) -> Result<Option<T>, String> {
    flag_value(args, flag)?
        .map(|v| {
            v.trim()
                .parse::<T>()
                .map_err(|_| format!("invalid {flag}: '{v}'"))
        })
        .transpose()
}

/// Parse `argv[1..]`.
pub fn parse_args(args: &[String]) -> Result<Mode, String> {
    let has = |f: &str| args.iter().any(|a| a == f);

    if has("--list-devices") {
        return Ok(Mode::ListDevices);
    }
    if has("--play-tone") {
        let dev = flag_value(args, "--device")?
            .and_then(parse_device)
            .unwrap_or(DeviceSpec::Default);
        return Ok(Mode::PlayTone(dev));
    }

    let meter_only = has("--meter-only");
    let output_dir = flag_value(args, "--output-dir")?.map(PathBuf::from);
    if output_dir.is_none() && !meter_only {
        return Err("--output-dir is required (or use --meter-only)".into());
    }

    let chunk_seconds = parse_num::<f64>(args, "--chunk-seconds")?.unwrap_or(DEFAULT_CHUNK_SECONDS);
    if !(chunk_seconds.is_finite() && chunk_seconds > 0.0) {
        return Err(format!("invalid --chunk-seconds: {chunk_seconds}"));
    }
    let sample_rate = parse_num::<u32>(args, "--sample-rate")?.unwrap_or(DEFAULT_SAMPLE_RATE);
    if !(8_000..=192_000).contains(&sample_rate) {
        return Err(format!(
            "--sample-rate must be 8000..192000, got {sample_rate}"
        ));
    }
    let channels = parse_num::<u16>(args, "--channels")?.unwrap_or(DEFAULT_CHANNELS);
    if !(1..=2).contains(&channels) {
        return Err(format!("--channels must be 1 or 2, got {channels}"));
    }
    let mic_volume = parse_num::<f32>(args, "--mic-volume")?.unwrap_or(DEFAULT_MIC_VOLUME);
    if !mic_volume.is_finite() {
        return Err("invalid --mic-volume".into());
    }

    Ok(Mode::Capture(CaptureArgs {
        output_dir,
        prefix: flag_value(args, "--prefix")?.unwrap_or("chunk").to_string(),
        chunk_seconds,
        sample_rate,
        channels,
        // Omitted --device = follow the OS default.
        system: match flag_value(args, "--device")? {
            Some(v) => parse_device(v),
            None => Some(DeviceSpec::Default),
        },
        // Omitted --mic = no microphone (backwards compatible).
        mic: flag_value(args, "--mic")?.and_then(parse_device),
        mic_volume: mic_volume.clamp(0.0, 4.0),
        meter_only,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(s: &str) -> Vec<String> {
        s.split_whitespace().map(String::from).collect()
    }

    fn capture(s: &str) -> CaptureArgs {
        match parse_args(&argv(s)).unwrap() {
            Mode::Capture(c) => c,
            m => panic!("expected capture, got {m:?}"),
        }
    }

    // --- devices ---

    #[test]
    fn device_spec_parsing() {
        assert_eq!(parse_device("@default"), Some(DeviceSpec::Default));
        assert_eq!(parse_device("@DEFAULT"), Some(DeviceSpec::Default));
        assert_eq!(parse_device("  "), Some(DeviceSpec::Default));
        assert_eq!(parse_device("none"), None);
        assert_eq!(parse_device("None"), None);
        assert_eq!(
            parse_device(" Speakers (Realtek(R) Audio) "),
            Some(DeviceSpec::Named("Speakers (Realtek(R) Audio)".into()))
        );
        assert_eq!(
            parse_device("Speakers (Realtek(R) Audio) (Loopback)"),
            Some(DeviceSpec::Named("Speakers (Realtek(R) Audio)".into()))
        );
    }

    // --- commands ---

    #[test]
    fn parses_simple_commands() {
        assert_eq!(parse_command("q"), Ok(Command::Quit));
        assert_eq!(parse_command(" q \r"), Ok(Command::Quit));
        assert_eq!(
            parse_command("mute-sys"),
            Ok(Command::Mute(Source::System, true))
        );
        assert_eq!(
            parse_command("unmute-sys"),
            Ok(Command::Mute(Source::System, false))
        );
        assert_eq!(
            parse_command("mute-mic"),
            Ok(Command::Mute(Source::Mic, true))
        );
        assert_eq!(
            parse_command("unmute-mic"),
            Ok(Command::Mute(Source::Mic, false))
        );
    }

    #[test]
    fn parses_set_commands_with_spaces_in_names() {
        assert_eq!(
            parse_command("set-mic Microphone Array (Intel® Smart Sound)"),
            Ok(Command::SetDevice(
                Source::Mic,
                Some(DeviceSpec::Named(
                    "Microphone Array (Intel® Smart Sound)".into()
                ))
            ))
        );
        assert_eq!(
            parse_command("set-sys @default"),
            Ok(Command::SetDevice(
                Source::System,
                Some(DeviceSpec::Default)
            ))
        );
        assert_eq!(
            parse_command("set-mic none"),
            Ok(Command::SetDevice(Source::Mic, None))
        );
        assert_eq!(
            parse_command("set-sys\tnone"),
            Ok(Command::SetDevice(Source::System, None))
        );
    }

    #[test]
    fn rejects_bad_commands() {
        assert!(parse_command("").is_err());
        assert!(parse_command("set-mic").is_err());
        assert!(parse_command("set-sys   ").is_err());
        assert!(parse_command("q now").is_err());
        assert!(parse_command("explode").is_err());
    }

    // --- lines ---

    #[test]
    fn formats_lines() {
        assert_eq!(level_line(0.123456, 1.0), "LEVEL:0.1235,1.0000");
        assert_eq!(level_line(-1.0, f32::NAN), "LEVEL:0.0000,0.0000");
        assert_eq!(level_line(3.0, 0.0), "LEVEL:1.0000,0.0000");
        assert_eq!(
            device_line(Some("Speakers"), Some("Mic"), DeviceChange::Both),
            "DEVICE:Speakers|Mic|both"
        );
        assert_eq!(
            device_line(Some("Speakers"), None, DeviceChange::Source(Source::Mic)),
            "DEVICE:Speakers||mic"
        );
        assert_eq!(
            device_line(None, None, DeviceChange::Source(Source::System)),
            "DEVICE:||sys"
        );
        assert_eq!(
            device_line(Some("A\nB"), Some("C\rD"), DeviceChange::Both),
            "DEVICE:A B|C D|both"
        );
        assert_eq!(warn_line("bad\nthing"), "WARN:bad thing");
        assert_eq!(chunk_file_name("chunk", 7), "chunk_0007.wav");
        assert_eq!(
            chunk_line(std::path::Path::new("C:\\a\\b.wav")),
            "CHUNK:C:\\a\\b.wav"
        );
    }

    // --- args ---

    #[test]
    fn list_and_tone_modes() {
        assert_eq!(parse_args(&argv("--list-devices")), Ok(Mode::ListDevices));
        assert_eq!(
            parse_args(&argv("--play-tone")),
            Ok(Mode::PlayTone(DeviceSpec::Default))
        );
        assert_eq!(
            parse_args(&argv("--play-tone --device @default")),
            Ok(Mode::PlayTone(DeviceSpec::Default))
        );
        assert_eq!(
            parse_args(&[
                "--play-tone".into(),
                "--device".into(),
                "Fone de ouvido (JBL)".into()
            ]),
            Ok(Mode::PlayTone(DeviceSpec::Named(
                "Fone de ouvido (JBL)".into()
            )))
        );
    }

    #[test]
    fn capture_defaults() {
        let c = capture("--output-dir out");
        assert_eq!(c.output_dir, Some(PathBuf::from("out")));
        assert_eq!(c.prefix, "chunk");
        assert_eq!(c.chunk_seconds, 120.0);
        assert_eq!((c.sample_rate, c.channels), (16_000, 1));
        assert_eq!(c.system, Some(DeviceSpec::Default));
        assert_eq!(c.mic, None);
        assert_eq!(c.mic_volume, 1.2);
        assert!(!c.meter_only);
    }

    #[test]
    fn capture_full() {
        let c = capture(
            "--output-dir d --prefix p --chunk-seconds 2.5 --sample-rate 48000 --channels 2 \
             --device @default --mic @default --mic-volume 0.8",
        );
        assert_eq!(c.prefix, "p");
        assert_eq!(c.chunk_seconds, 2.5);
        assert_eq!((c.sample_rate, c.channels), (48_000, 2));
        assert_eq!(c.mic, Some(DeviceSpec::Default));
        assert_eq!(c.mic_volume, 0.8);
        let c = capture("--output-dir d --mic none --device none");
        assert_eq!((c.system, c.mic), (None, None));
        assert_eq!(capture("--output-dir d --mic-volume 99").mic_volume, 4.0);
    }

    #[test]
    fn meter_only_needs_no_output_dir() {
        let c = capture("--meter-only --device @default --mic @default");
        assert!(c.meter_only);
        assert_eq!(c.output_dir, None);
        assert_eq!(c.mic, Some(DeviceSpec::Default));
    }

    #[test]
    fn rejects_invalid_args() {
        for bad in [
            "",
            "--output-dir",
            "--output-dir --prefix x",
            "--output-dir d --chunk-seconds 0",
            "--output-dir d --chunk-seconds abc",
            "--output-dir d --sample-rate 100",
            "--output-dir d --channels 6",
            "--output-dir d --mic-volume nan",
            "--output-dir d --device",
        ] {
            assert!(parse_args(&argv(bad)).is_err(), "should reject: {bad:?}");
        }
    }
}
