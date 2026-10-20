//! One capture thread per source (system loopback or microphone).
//!
//! The thread owns all of its COM objects (they aren't `Send`), converts the device's native
//! format to the output format (decode → channel map → resample) and pushes f32 frames into a
//! `JitterBuffer` the mixer drains. The resampler's ratio is continuously nudged by the
//! buffer's drift controller, so the device clock can't slowly overfill or drain it. The
//! thread also supervises itself:
//! - `@default`: polls the OS default endpoint id (~1 s) and reopens when Windows switches it;
//! - named device missing / lost (unplugged) → `Warn` + fall back to `@default`, while
//!   re-checking the named device every few seconds and switching back (`Opened`) when it
//!   reappears;
//! - nothing to open (no device at all) → `Unavailable` + keep retrying quietly.
//!
//! The mixer never waits on this thread, so a failing source only ever means silence.

use crate::control::SourceEvent;
use crate::devices;
use crate::dsp::{decode_samples, map_channels, JitterBuffer, Resampler, SampleEncoding};
use crate::protocol::{DeviceSpec, Source};
use std::collections::{HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use wasapi::{AudioCaptureClient, AudioClient, Device, Direction, Handle, SampleType, ShareMode};

/// Format every source is converted to before reaching the mixer (= the WAV format).
#[derive(Debug, Clone, Copy)]
pub struct OutFormat {
    pub rate: u32,
    pub channels: usize,
}

/// Jitter-buffer fill the drift controller holds (also the priming level), and the hard
/// backlog bound (last resort; normally never reached).
const TARGET_FILL: Duration = Duration::from_millis(80);
const MAX_BACKLOG: Duration = Duration::from_secs(1);
/// How often `@default` sources check whether Windows' default endpoint changed.
const DEFAULT_POLL: Duration = Duration::from_secs(1);
/// Back-off between attempts when no device can be opened at all.
const RETRY: Duration = Duration::from_secs(2);
/// While fallen back to the default, how often to look for the requested named device again;
/// doubles (up to the max) while it is found but fails to open or keeps dropping out.
const RESTORE_RETRY: Duration = Duration::from_secs(3);
const RESTORE_RETRY_MAX: Duration = Duration::from_secs(30);
/// Delay before reopening a lost default endpoint; doubles while streams keep dying quickly.
const LOST_RETRY: Duration = Duration::from_millis(300);
const LOST_RETRY_MAX: Duration = Duration::from_secs(5);
/// A stream that dies sooner than this after opening counts as flapping (→ back off).
const QUICK_LOSS: Duration = Duration::from_secs(2);

pub struct SourceHandle {
    pub buffer: Arc<Mutex<JitterBuffer>>,
    stop: Arc<AtomicBool>,
    thread: JoinHandle<()>,
}

impl SourceHandle {
    pub fn spawn(
        source: Source,
        spec: DeviceSpec,
        fmt: OutFormat,
        notify: impl Fn(SourceEvent) + Send + 'static,
    ) -> Result<Self, String> {
        let frames = |d: Duration| (fmt.rate as f64 * d.as_secs_f64()) as usize;
        let buffer = Arc::new(Mutex::new(JitterBuffer::new(
            fmt.channels,
            fmt.rate,
            frames(TARGET_FILL),
            frames(MAX_BACKLOG),
        )));
        let stop = Arc::new(AtomicBool::new(false));
        let thread = {
            let (buffer, stop) = (buffer.clone(), stop.clone());
            std::thread::Builder::new()
                .name(format!("capture-{source:?}").to_lowercase())
                .spawn(move || supervise(source, spec, fmt, &buffer, &stop, &notify))
                .map_err(|e| format!("cannot start capture thread ({e})"))?
        };
        Ok(Self {
            buffer,
            stop,
            thread,
        })
    }

    /// Ask the thread to stop (it exits within ~100 ms) and hand back its join handle, so the
    /// caller never blocks the mixer waiting for it.
    pub fn stop(self) -> JoinHandle<()> {
        self.stop.store(true, Ordering::SeqCst);
        self.thread
    }
}

fn sleep_unless_stopped(stop: &AtomicBool, total: Duration) {
    let until = Instant::now() + total;
    while !stop.load(Ordering::SeqCst) && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn double(d: Duration, max: Duration) -> Duration {
    (d * 2).min(max)
}

enum StreamEnd {
    Stopped,
    DefaultChanged,
    /// The requested named device is back and already open: switch to it.
    Restored(Stream),
    Lost(String),
}

fn describe(label: &str, spec: &DeviceSpec) -> String {
    match spec {
        DeviceSpec::Named(n) => format!("{label} '{n}'"),
        DeviceSpec::Default => label.to_string(),
    }
}

fn open_spec(dir: &Direction, spec: &DeviceSpec, label: &str) -> Result<Stream, String> {
    let device =
        devices::resolve(dir, spec).map_err(|e| format!("{}: {e}", describe(label, spec)))?;
    Stream::open(&device).map_err(|e| {
        let name = device.get_friendlyname().unwrap_or_else(|_| "?".into());
        format!("could not open {label} '{name}' ({e})")
    })
}

fn supervise(
    source: Source,
    requested: DeviceSpec,
    fmt: OutFormat,
    buffer: &Mutex<JitterBuffer>,
    stop: &AtomicBool,
    notify: &dyn Fn(SourceEvent),
) {
    // Each thread using COM must initialize it (MTA, like the main thread).
    if let Err(e) = wasapi::initialize_mta() {
        notify(SourceEvent::Warn(format!(
            "{}: COM init failed ({e})",
            source.label()
        )));
        notify(SourceEvent::Unavailable);
        return;
    }
    let dir = devices::direction(source);
    let label = source.label();
    // Following the OS default because the requested named device is missing / failed / lost.
    let mut fallback = false;
    // Failures already reported since the last successful open (each is warned once).
    let mut warned: HashSet<String> = HashSet::new();
    let mut lost_retry = LOST_RETRY;
    let mut restore_retry = RESTORE_RETRY;
    // A stream opened ahead of time (named device restored) to switch to without a gap.
    let mut pending: Option<Stream> = None;

    while !stop.load(Ordering::SeqCst) {
        let following_default = fallback || requested == DeviceSpec::Default;
        let mut stream = match pending.take() {
            Some(s) => s,
            None => {
                let spec = if fallback {
                    &DeviceSpec::Default
                } else {
                    &requested
                };
                match open_spec(&dir, spec, label) {
                    Ok(s) => s,
                    Err(msg) => {
                        let first = warned.insert(msg.clone());
                        if matches!(spec, DeviceSpec::Named(_)) {
                            // Named device unavailable → try the default right away.
                            if first {
                                notify(SourceEvent::Warn(format!(
                                    "{msg}; falling back to the system default"
                                )));
                            }
                            fallback = true;
                        } else {
                            if first {
                                notify(SourceEvent::Warn(msg));
                                notify(SourceEvent::Unavailable);
                            }
                            sleep_unless_stopped(stop, RETRY);
                            // Nothing open at all: try the requested named device first again.
                            fallback = false;
                        }
                        continue;
                    }
                }
            }
        };
        warned.clear();
        if let Ok(mut b) = buffer.lock() {
            b.reset_drift(); // new device, new clock
        }
        eprintln!(
            "[{label}] opened '{}' ({} Hz, {} ch, {:?})",
            stream.name, stream.rate, stream.channels, stream.encoding
        );
        notify(SourceEvent::Opened(stream.name.clone()));

        let opened_at = Instant::now();
        let restore = if fallback { Some(&requested) } else { None };
        let end = stream.pump(
            &dir,
            following_default,
            restore,
            &mut restore_retry,
            fmt,
            buffer,
            stop,
        );
        if let Ok(b) = buffer.lock() {
            let stats = b.stats();
            eprintln!(
                "[{label}] '{}' closed: clock drift {:+.0} ppm; buffer totals: {} underruns, {} samples dropped",
                stream.name,
                b.drift_estimate() * 1e6,
                stats.underruns,
                stats.dropped_samples
            );
        }
        let quick = opened_at.elapsed() < QUICK_LOSS;
        let name = stream.name.clone();
        drop(stream); // releases the WASAPI clients before their event handle (see `Stream`)

        match end {
            StreamEnd::Stopped => break,
            StreamEnd::DefaultChanged => {
                eprintln!("[{label}] Windows default device changed, reopening");
            }
            StreamEnd::Restored(s) => {
                eprintln!("[{label}] '{}' is available again, switching back", s.name);
                fallback = false;
                pending = Some(s);
            }
            StreamEnd::Lost(e) => {
                let msg = format!("{label} '{name}' was lost ({e})");
                if following_default {
                    // The default endpoint went away; Windows usually promotes another one.
                    lost_retry = if quick {
                        double(lost_retry, LOST_RETRY_MAX)
                    } else {
                        LOST_RETRY
                    };
                    eprintln!("[{label}] {msg}; reopening the system default in {lost_retry:?}");
                    sleep_unless_stopped(stop, lost_retry);
                } else {
                    // Named device unplugged: default now, and look for it again later
                    // (backing off if it keeps dropping out right after coming back).
                    restore_retry = if quick {
                        double(restore_retry, RESTORE_RETRY_MAX)
                    } else {
                        RESTORE_RETRY
                    };
                    notify(SourceEvent::Warn(format!(
                        "{msg}; falling back to the system default"
                    )));
                    fallback = true;
                }
            }
        }
    }
}

/// Owns the event handle wasapi 0.14 creates for a stream: its `Handle` has no `Drop`, so
/// without this every (re)open leaked one kernel event object.
struct EventHandle {
    inner: Handle,
    raw: windows_sys::Win32::Foundation::HANDLE,
}

// `wasapi::Handle` is a plain wrapper around one Win32 `HANDLE`, but its field is private, so
// the value is read by copy. Guard the layout assumption at compile time.
const _: () = assert!(std::mem::size_of::<Handle>() == std::mem::size_of::<isize>());

impl EventHandle {
    fn new(inner: Handle) -> Self {
        // SAFETY: `Handle` consists of exactly one pointer-sized field (asserted above), so its
        // bytes are the raw handle value. `transmute_copy` only reads them; `inner` stays owned.
        let raw = unsafe { std::mem::transmute_copy::<Handle, isize>(&inner) };
        Self {
            inner,
            raw: raw as windows_sys::Win32::Foundation::HANDLE,
        }
    }

    fn wait(&self, timeout_ms: u32) {
        let _ = self.inner.wait_for_event(timeout_ms);
    }
}

impl Drop for EventHandle {
    fn drop(&mut self) {
        if !self.raw.is_null() {
            // SAFETY: we own the handle (wasapi never closes it) and close it exactly once.
            unsafe { windows_sys::Win32::Foundation::CloseHandle(self.raw) };
        }
    }
}

/// An open, started WASAPI capture stream.
///
/// Field order matters: fields drop in declaration order, so the capture/audio clients are
/// released before the event handle they signal is closed.
struct Stream {
    capture: AudioCaptureClient,
    client: AudioClient,
    event: EventHandle,
    name: String,
    /// Endpoint id (stable, unlike the friendly name), for default-change detection.
    id: Option<String>,
    rate: u32,
    channels: usize,
    encoding: SampleEncoding,
    block_align: usize,
}

impl Stream {
    fn open(device: &Device) -> Result<Self, Box<dyn std::error::Error>> {
        let mut client = device.get_iaudioclient()?;
        // Shared mode only accepts the engine's own mix format (else AUDCLNT_E_UNSUPPORTED_FORMAT);
        // we convert to the output format ourselves.
        let fmt = client.get_mixformat()?;
        let is_float = matches!(fmt.get_subformat(), Ok(SampleType::Float));
        let (def_period, _) = client.get_periods()?;
        // initialize_client() FIRST — required before SetEventHandle. The wasapi crate
        // initializes with AUDCLNT_STREAMFLAGS_EVENTCALLBACK, so set_get_eventhandle() must
        // follow before start_stream(). Capture direction on a *render* endpoint is what makes
        // the crate add AUDCLNT_STREAMFLAGS_LOOPBACK. Last arg = engine auto-conversion: off,
        // we open the mix format and convert ourselves.
        client.initialize_client(
            &fmt,
            def_period,
            &Direction::Capture,
            &ShareMode::Shared,
            false,
        )?;
        // Wrapped immediately, so an error below still closes it (the stream never started,
        // so nothing signals it afterwards).
        let event = EventHandle::new(client.set_get_eventhandle()?);
        let capture = client.get_audiocaptureclient()?;
        client.start_stream()?;
        Ok(Self {
            capture,
            client,
            event,
            name: device
                .get_friendlyname()
                .unwrap_or_else(|_| "Unknown".to_string()),
            id: device.get_id().ok(),
            rate: fmt.get_samplespersec(),
            channels: fmt.get_nchannels() as usize,
            encoding: SampleEncoding::from_format(is_float, fmt.get_bitspersample()),
            block_align: fmt.get_blockalign() as usize,
        })
    }

    /// Read until stopped, the device fails, the OS default changes (`watch_default`), or the
    /// `restore` device (requested named device, while fallen back) can be opened again.
    #[allow(clippy::too_many_arguments)]
    fn pump(
        &mut self,
        dir: &Direction,
        watch_default: bool,
        restore: Option<&DeviceSpec>,
        restore_retry: &mut Duration,
        fmt: OutFormat,
        buffer: &Mutex<JitterBuffer>,
        stop: &AtomicBool,
    ) -> StreamEnd {
        let mut resampler = Resampler::new(self.rate, fmt.rate, fmt.channels);
        let mut raw: VecDeque<u8> = VecDeque::new();
        let (mut decoded, mut mapped, mut resampled) = (Vec::new(), Vec::new(), Vec::new());
        let mut last_poll = Instant::now();
        let mut last_restore = Instant::now();
        // Only watch the default if we know which endpoint we opened.
        let watch_id = if watch_default { self.id.clone() } else { None };

        let end = loop {
            if stop.load(Ordering::SeqCst) {
                break StreamEnd::Stopped;
            }
            // Timeouts are normal: loopback delivers nothing — and fires no event — while the
            // system is silent. The mixer fills that gap with silence on its own clock.
            self.event.wait(100);

            // Drain every queued packet (one event can cover several). Errors here are how
            // WASAPI reports an invalidated device (unplugged / disabled).
            if let Err(e) = self.drain_packets(&mut raw) {
                break StreamEnd::Lost(e);
            }
            let whole = raw.len() - raw.len() % self.block_align.max(1);
            if whole > 0 {
                decoded.clear();
                mapped.clear();
                resampled.clear();
                let bytes = raw.make_contiguous();
                decode_samples(&bytes[..whole], self.encoding, &mut decoded);
                raw.drain(..whole);
                map_channels(&decoded, self.channels, fmt.channels, &mut mapped);
                resampler.process(&mapped, &mut resampled);
                if let Ok(mut b) = buffer.lock() {
                    b.push(&resampled);
                    // Drift compensation: keep the buffer at its target fill.
                    resampler.set_rate_adjust(b.rate_adjust());
                }
            }

            if let Some(id) = &watch_id {
                if last_poll.elapsed() >= DEFAULT_POLL {
                    last_poll = Instant::now();
                    if devices::default_id(dir).is_some_and(|cur| &cur != id) {
                        break StreamEnd::DefaultChanged;
                    }
                }
            }

            if let Some(spec) = restore {
                if last_restore.elapsed() >= *restore_retry {
                    last_restore = Instant::now();
                    // Open it while this stream keeps running, so the switch has no gap.
                    if let Ok(device) = devices::resolve(dir, spec) {
                        match Stream::open(&device) {
                            Ok(s) => break StreamEnd::Restored(s),
                            Err(e) => {
                                *restore_retry = double(*restore_retry, RESTORE_RETRY_MAX);
                                eprintln!(
                                    "[restore] {spec:?} found but failed to open ({e}); \
                                     retrying in {restore_retry:?}"
                                );
                            }
                        }
                    }
                }
            }
        };
        self.client.stop_stream().ok();
        end
    }

    fn drain_packets(&self, raw: &mut VecDeque<u8>) -> Result<(), String> {
        loop {
            match self.capture.get_next_nbr_frames() {
                Ok(Some(0)) | Ok(None) => return Ok(()),
                Ok(Some(_)) => {}
                Err(e) => return Err(e.to_string()),
            }
            let before = raw.len();
            let flags = self
                .capture
                .read_from_device_to_deque(self.block_align, raw)
                .map_err(|e| e.to_string())?;
            // AUDCLNT_BUFFERFLAGS_SILENT: the packet's contents must be treated as silence.
            if flags.silent {
                raw.range_mut(before..).for_each(|b| *b = 0);
            }
        }
    }
}
