//! WASAPI system-audio + microphone capture.
//!
//! Captures system output via WASAPI loopback (no "Stereo Mix" or virtual cable needed),
//! optionally mixes a microphone, and writes 16-bit PCM WAV chunks at a fixed output format.
//! Both sources can be switched live, follow the Windows default endpoint (`@default`), and
//! report audio levels for the GUI's meters.
//!
//! Usage:
//!   wasapi-capture --list-devices
//!   wasapi-capture --play-tone [--device <name|@default>]
//!   wasapi-capture --output-dir <DIR> [--prefix <P>] [--chunk-seconds <N>]
//!                  [--sample-rate <HZ>] [--channels <1|2>]
//!                  [--device <name|@default|none>] [--mic <name|@default|none>] [--mic-volume <F>]
//!   wasapi-capture --meter-only [--device ...] [--mic ...]
//!
//! The stdout/stdin protocol is documented in `protocol.rs`.
//!
//! Layout: `dsp`, `protocol` and `control` (the engine's command/event state machine) are pure
//! and unit-tested without Windows deps; `sink` (WAV chunk writer) is unit-tested on a temp dir;
//! `devices`, `source` (one capture thread per source) and `engine` (wall-clock mixer) need COM.

// The pure modules are only exercised by tests off Windows.
#![cfg_attr(not(windows), allow(dead_code))]

mod control;
mod dsp;
mod protocol;

#[cfg(windows)]
mod devices;
#[cfg(windows)]
mod engine;
#[cfg(windows)]
mod sink;
#[cfg(windows)]
mod source;

use std::io::Write;

/// Write one protocol line to stdout and flush immediately: the Node adapter parses line by
/// line, and block-buffered stdout (it's a pipe) would delay LEVEL lines by seconds.
pub fn emit(line: &str) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

pub fn emit_warn(msg: &str) {
    eprintln!("WARN: {msg}");
    emit(&protocol::warn_line(msg));
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mode = match protocol::parse_args(&args) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("wasapi-capture: {e}");
            std::process::exit(2);
        }
    };
    std::process::exit(run(mode));
}

#[cfg(windows)]
fn run(mode: protocol::Mode) -> i32 {
    use protocol::Mode;
    if let Err(e) = wasapi::initialize_mta() {
        eprintln!("Failed to initialize COM: {e}");
        return 1;
    }
    match mode {
        Mode::ListDevices => {
            devices::list_devices();
            0
        }
        Mode::PlayTone(spec) => match devices::play_tone(&spec) {
            Ok(()) => 0,
            Err(e) => {
                eprintln!("Test tone failed: {e}");
                1
            }
        },
        Mode::Capture(args) => engine::run(args),
    }
}

#[cfg(not(windows))]
fn run(_mode: protocol::Mode) -> i32 {
    eprintln!("wasapi-capture is only supported on Windows");
    1
}
