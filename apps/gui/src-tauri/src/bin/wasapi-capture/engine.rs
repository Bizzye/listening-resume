//! Capture / meter engine: the main thread is a wall-clock-paced mixer.
//!
//! Every tick it emits exactly the number of output frames real time demands, pulling from each
//! source's jitter buffer and substituting silence for whatever a source didn't deliver. WASAPI
//! loopback delivers nothing (and fires no event) while the system is silent, so pacing on the
//! device would drop silence gaps and make mic-only recordings impossible; pacing on the wall
//! clock keeps chunk durations equal to real time. Sources live on their own threads (see
//! `source.rs`, which also compensates their clock drift) and can be swapped at any moment
//! without interrupting the timeline. Command/event handling is the pure `control::Control`.

use crate::control::{Action, Control, Msg, SourceEvent};
use crate::dsp::{mix_block, LevelMeter};
use crate::protocol::{self, CaptureArgs, Command, Source};
use crate::sink::ChunkSink;
use crate::source::{OutFormat, SourceHandle};
use crate::{emit, emit_warn};
use std::collections::VecDeque;
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

const TICK: Duration = Duration::from_millis(10);
const LEVEL_INTERVAL: Duration = Duration::from_millis(50);
/// How long startup waits for the sources to report before announcing `DEVICE:` and starting
/// the clock (opening an endpoint normally takes a few ms; a missing one reports right away).
const STARTUP_WAIT: Duration = Duration::from_secs(3);
/// Max frames mixed per block, so a long stall can't allocate unbounded buffers.
const MAX_BLOCK_SECS: u64 = 1;
/// A gap longer than this between two mixer iterations is not a stall but the wall clock
/// jumping (system suspend/resume, a debugger pause): the timeline is resynced instead of
/// catching up — which would write the whole gap (possibly hours) as silence.
const MAX_CATCH_UP: Duration = Duration::from_secs(5);

/// How much wall-clock time to drop from the timeline, given the time since the previous mixer
/// iteration (normally ~one `TICK`). `None` for ordinary gaps, which are caught up as usual
/// (silence where a source delivered nothing). On a jump, everything but one tick is dropped,
/// so the timeline continues as if a single iteration had passed. Pure.
fn clock_skip(gap: Duration) -> Option<Duration> {
    (gap > MAX_CATCH_UP).then(|| gap.saturating_sub(TICK))
}

/// `WARN:` text for a resynced clock jump (pt-BR: forwarded to the UI as is).
fn clock_jump_warning(skipped: Duration) -> String {
    format!(
        "relógio saltou {:.0}s (suspensão?) — sincronizado",
        skipped.as_secs_f64()
    )
}

/// Read stdin commands on a background thread; EOF (parent died / closed the pipe) = stop.
fn spawn_stdin_reader(tx: Sender<Msg>) {
    let spawned = std::thread::Builder::new()
        .name("stdin".into())
        .spawn(move || {
            for line in std::io::stdin().lock().lines() {
                let Ok(line) = line else { break };
                match protocol::parse_command(&line) {
                    Ok(cmd) => {
                        let quit = cmd == Command::Quit;
                        if tx.send(Msg::Command(cmd)).is_err() || quit {
                            return;
                        }
                    }
                    Err(e) if !line.trim().is_empty() => eprintln!("Ignoring stdin: {e}"),
                    Err(_) => {}
                }
            }
            let _ = tx.send(Msg::StdinClosed);
        });
    if let Err(e) = spawned {
        // Without stdin we can't be told to stop; the parent will have to kill us.
        emit_warn(&format!("cannot read commands ({e})"));
    }
}

/// Runtime side of one mix input: the thread currently feeding it plus mixing scratch.
#[derive(Default)]
struct Slot {
    handle: Option<SourceHandle>,
    meter: LevelMeter,
    scratch: Vec<f32>,
}

impl Slot {
    /// Load the next `samples` samples of this source into `scratch`, silence-padded.
    fn pull(&mut self, samples: usize) {
        self.scratch.clear();
        self.scratch.resize(samples, 0.0);
        if let Some(h) = &self.handle {
            if let Ok(mut b) = h.buffer.lock() {
                b.pull(&mut self.scratch);
            }
        }
    }
}

struct Engine {
    fmt: OutFormat,
    mic_volume: f32,
    control: Control,
    slots: [Slot; 2],
    sink: Option<ChunkSink>,
    tx: Sender<Msg>,
    /// Stopped source threads; joined (never waited on) once finished.
    retired: Vec<JoinHandle<()>>,
    pcm: Vec<i16>,
}

impl Engine {
    /// Execute the control's effects. Returns `true` when the engine should stop.
    fn apply(&mut self, actions: Vec<Action>) -> bool {
        let mut queue: VecDeque<Action> = actions.into();
        let mut quit = false;
        while let Some(action) = queue.pop_front() {
            match action {
                Action::Open {
                    source,
                    spec,
                    generation,
                } => {
                    self.retire(source);
                    eprintln!("[{}] opening {spec:?}", source.label());
                    let tx = self.tx.clone();
                    let notify = move |event| {
                        let _ = tx.send(Msg::Source {
                            source,
                            generation,
                            event,
                        });
                    };
                    match SourceHandle::spawn(source, spec, self.fmt, notify) {
                        Ok(h) => self.slots[source as usize].handle = Some(h),
                        Err(e) => {
                            // Report through the control like a source would, so the slot is
                            // marked unavailable and startup doesn't wait for it.
                            for event in [
                                SourceEvent::Warn(format!("{}: {e}", source.label())),
                                SourceEvent::Unavailable,
                            ] {
                                queue.extend(self.control.handle(Msg::Source {
                                    source,
                                    generation,
                                    event,
                                }));
                            }
                        }
                    }
                }
                Action::Close(source) => {
                    eprintln!("[{}] removed", source.label());
                    self.retire(source);
                }
                Action::Line(line) => emit(&line),
                Action::Warn(msg) => emit_warn(&msg),
                Action::Quit => quit = true,
            }
        }
        // Reap threads that have finished stopping.
        let (done, pending): (Vec<_>, Vec<_>) =
            self.retired.drain(..).partition(|t| t.is_finished());
        self.retired = pending;
        for t in done {
            let _ = t.join();
        }
        quit
    }

    fn handle(&mut self, msg: Msg) -> bool {
        if let Msg::Command(Command::Mute(source, muted)) = &msg {
            eprintln!(
                "[{}] {}",
                source.label(),
                if *muted { "muted" } else { "unmuted" }
            );
        }
        let actions = self.control.handle(msg);
        self.apply(actions)
    }

    /// Tell the source's thread to stop without waiting for it.
    fn retire(&mut self, source: Source) {
        if let Some(h) = self.slots[source as usize].handle.take() {
            self.retired.push(h.stop());
        }
    }

    /// Mix `frames` output frames and hand them to the sink.
    fn mix(&mut self, frames: usize) -> Result<(), String> {
        let samples = frames * self.fmt.channels;
        let gains = self.control.gains(self.mic_volume);
        let [sys, mic] = &mut self.slots; // [System, Mic]
        sys.pull(samples);
        mic.pull(samples);
        self.pcm.clear();
        mix_block(
            &sys.scratch,
            &mic.scratch,
            gains,
            &mut sys.meter,
            &mut mic.meter,
            &mut self.pcm,
        );
        match self.sink.as_mut() {
            Some(sink) => sink.write(&self.pcm, Instant::now(), &mut emit_chunk),
            None => Ok(()),
        }
    }

    fn emit_levels(&mut self) {
        let sys = self.slots[Source::System as usize].meter.take();
        let mic = self.slots[Source::Mic as usize].meter.take();
        emit(&protocol::level_line(sys, mic));
    }

    fn shutdown(&mut self) {
        self.retire(Source::System);
        self.retire(Source::Mic);
        // Give capture threads a moment to stop their streams cleanly, but never hang on exit.
        let deadline = Instant::now() + Duration::from_millis(500);
        while Instant::now() < deadline && !self.retired.iter().all(|t| t.is_finished()) {
            std::thread::sleep(Duration::from_millis(10));
        }
        for t in self.retired.drain(..).filter(|t| t.is_finished()) {
            let _ = t.join();
        }
    }
}

fn emit_chunk(path: &Path) {
    emit(&protocol::chunk_line(path));
}

fn absolute(p: &Path) -> PathBuf {
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|d| d.join(p))
            .unwrap_or_else(|_| p.to_path_buf())
    }
}

/// Run a capture (or `--meter-only` session). Returns the process exit code.
pub fn run(args: CaptureArgs) -> i32 {
    let fmt = OutFormat {
        rate: args.sample_rate,
        channels: args.channels as usize,
    };

    let sink = match (&args.output_dir, args.meter_only) {
        (Some(dir), false) => {
            let dir = absolute(dir);
            if let Err(e) = std::fs::create_dir_all(&dir) {
                eprintln!("Failed to create output directory {}: {e}", dir.display());
                return 1;
            }
            Some(ChunkSink::new(
                dir,
                args.prefix.clone(),
                args.sample_rate,
                args.channels,
                args.chunk_seconds,
            ))
        }
        _ => None,
    };
    eprintln!(
        "{} at {} Hz / {} ch (chunk {} s, mic volume {})",
        if sink.is_some() {
            "Recording"
        } else {
            "Metering"
        },
        args.sample_rate,
        args.channels,
        args.chunk_seconds,
        args.mic_volume
    );

    let (tx, rx) = mpsc::channel::<Msg>();
    spawn_stdin_reader(tx.clone());
    let mut engine = Engine {
        fmt,
        mic_volume: args.mic_volume,
        control: Control::new(),
        slots: Default::default(),
        sink,
        tx,
        retired: Vec::new(),
        pcm: Vec::new(),
    };
    let mut quit = false;
    for (source, spec) in [(Source::System, args.system), (Source::Mic, args.mic)] {
        let actions = engine.control.set_device(source, spec);
        quit |= engine.apply(actions);
    }

    let code = if quit || startup(&mut engine, &rx) {
        0 // asked to quit before the clock even started
    } else {
        mix_loop(&mut engine, &rx)
    };
    engine.shutdown();
    if let Some(sink) = &engine.sink {
        eprintln!(
            "Capture stopped. {} chunks written.",
            sink.chunks_written()
        );
    }
    code
}

/// Wait until every source has reported (or `STARTUP_WAIT`), then emit the first `DEVICE:` line.
/// Returns `true` if a quit arrived meanwhile.
fn startup(engine: &mut Engine, rx: &Receiver<Msg>) -> bool {
    let deadline = Instant::now() + STARTUP_WAIT;
    let mut quit = false;
    while !quit && !engine.control.all_reported() {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break;
        }
        match rx.recv_timeout(left.min(TICK * 5)) {
            Ok(msg) => quit = engine.handle(msg),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => quit = true,
        }
    }
    let actions = engine.control.start_announcing();
    quit |= engine.apply(actions);
    quit
}

fn mix_loop(engine: &mut Engine, rx: &Receiver<Msg>) -> i32 {
    let rate = engine.fmt.rate as u64;
    let start = Instant::now();
    let mut written: u64 = 0;
    // Fixed schedule (not "50 ms after the last emit") so tick jitter doesn't stretch the period.
    let mut next_level = start + LEVEL_INTERVAL;
    let mut quit = false;
    // Wall-clock time dropped from the timeline by clock jumps (see `clock_skip`).
    let mut skipped = Duration::ZERO;
    let mut last_iteration = start;

    let code = loop {
        let now = Instant::now();
        if let Some(skip) = clock_skip(now.saturating_duration_since(last_iteration)) {
            skipped += skip;
            next_level = now + LEVEL_INTERVAL;
            emit_warn(&clock_jump_warning(skip));
        }
        last_iteration = now;

        while let Ok(msg) = rx.try_recv() {
            quit |= engine.handle(msg);
        }

        // Emit exactly what wall-clock time demands (in bounded blocks).
        let elapsed = start.elapsed().saturating_sub(skipped);
        let target = (elapsed.as_secs_f64() * rate as f64) as u64;
        let mut failed = None;
        while written < target && failed.is_none() {
            let frames = (target - written).min(rate * MAX_BLOCK_SECS);
            failed = engine.mix(frames as usize).err();
            written += frames;
        }
        if let Some(e) = failed {
            emit_warn(&format!("recording stopped: {e}"));
            break 1;
        }

        let now = Instant::now();
        if now >= next_level {
            engine.emit_levels();
            next_level += LEVEL_INTERVAL;
            if next_level < now {
                next_level = now + LEVEL_INTERVAL; // fell far behind (stall): resync
            }
        }

        if quit {
            break 0;
        }
        std::thread::sleep(TICK);
    };

    if let Some(Err(e)) = engine.sink.as_mut().map(|s| s.finish_current(&mut emit_chunk)) {
        eprintln!("Fatal: {e}");
        return 1;
    }
    eprintln!("Mixed {:.3} s of audio.", written as f64 / rate as f64);
    code
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_gaps_are_caught_up() {
        for gap in [
            Duration::ZERO,
            TICK,
            Duration::from_millis(250),
            Duration::from_secs(2),
            MAX_CATCH_UP,
        ] {
            assert_eq!(clock_skip(gap), None, "gap {gap:?}");
        }
    }

    #[test]
    fn a_clock_jump_drops_all_but_one_tick() {
        assert_eq!(
            clock_skip(MAX_CATCH_UP + Duration::from_millis(1)),
            Some(MAX_CATCH_UP + Duration::from_millis(1) - TICK)
        );
        assert_eq!(
            clock_skip(Duration::from_secs(3600)),
            Some(Duration::from_secs(3600) - TICK)
        );
    }

    #[test]
    fn clock_jump_warning_is_pt_br_and_rounded() {
        assert_eq!(
            clock_jump_warning(Duration::from_millis(3_599_990)),
            "relógio saltou 3600s (suspensão?) — sincronizado"
        );
        assert_eq!(
            clock_jump_warning(Duration::from_secs(6)),
            "relógio saltou 6s (suspensão?) — sincronizado"
        );
    }
}
