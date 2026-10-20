//! The engine's control state machine: stdin commands and source-thread events in, effects out.
//! Pure (no COM, no threads, no I/O) so the protocol behaviour is unit-tested; `engine.rs`
//! executes the returned `Action`s.

use crate::dsp::MixGains;
use crate::protocol::{self, Command, DeviceChange, DeviceSpec, Source};

/// What a capture thread reports about itself.
#[derive(Debug, Clone, PartialEq)]
pub enum SourceEvent {
    /// A device was (re)opened and is streaming; carries its friendly name.
    Opened(String),
    /// No device could be opened; the thread keeps retrying.
    Unavailable,
    Warn(String),
}

#[derive(Debug)]
pub enum Msg {
    Command(Command),
    StdinClosed,
    Source {
        source: Source,
        /// Which thread sent it (see `Action::Open`), so late events from a replaced thread
        /// are ignored.
        generation: u64,
        event: SourceEvent,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    /// Retire the source's current thread (if any) and start one for `spec`; its events must
    /// carry `generation`.
    Open {
        source: Source,
        spec: DeviceSpec,
        generation: u64,
    },
    /// Retire the source's current thread; the slot stays empty (silence).
    Close(Source),
    /// Print a protocol line on stdout.
    Line(String),
    /// Report a non-fatal problem (`WARN:` line + stderr).
    Warn(String),
    /// Stop: finalize the current chunk and exit.
    Quit,
}

#[derive(Debug, Clone)]
struct SlotState {
    generation: u64,
    /// Friendly name of the device currently streaming, if any.
    name: Option<String>,
    /// Startup bookkeeping: has the current thread reported (opened or unavailable)?
    reported: bool,
    muted: bool,
}

pub struct Control {
    slots: [SlotState; 2],
    /// `DEVICE:` lines are held back during startup so the first one carries both sources.
    announce: bool,
}

impl Control {
    pub fn new() -> Self {
        let slot = SlotState {
            generation: 0,
            name: None,
            reported: true,
            muted: false,
        };
        Self {
            slots: [slot.clone(), slot],
            announce: false,
        }
    }

    fn device_line(&self, changed: DeviceChange) -> Action {
        Action::Line(protocol::device_line(
            self.slots[Source::System as usize].name.as_deref(),
            self.slots[Source::Mic as usize].name.as_deref(),
            changed,
        ))
    }

    /// Announce a change of `source` (tagged, so the adapter can match it to a switch).
    fn announce_if_started(&self, source: Source, actions: &mut Vec<Action>) {
        if self.announce {
            actions.push(self.device_line(DeviceChange::Source(source)));
        }
    }

    /// Point a source at a device, or remove it with `None`.
    pub fn set_device(&mut self, source: Source, spec: Option<DeviceSpec>) -> Vec<Action> {
        let slot = &mut self.slots[source as usize];
        slot.generation += 1;
        let mut actions = Vec::new();
        match spec {
            Some(spec) => {
                // Keep the old name until the new device reports, so DEVICE: doesn't flicker.
                slot.reported = false;
                actions.push(Action::Open {
                    source,
                    spec,
                    generation: slot.generation,
                });
            }
            None => {
                slot.reported = true;
                slot.name = None;
                actions.push(Action::Close(source));
                // A removed source won't report, so announce the change now.
                self.announce_if_started(source, &mut actions);
            }
        }
        actions
    }

    pub fn handle(&mut self, msg: Msg) -> Vec<Action> {
        let mut actions = Vec::new();
        match msg {
            Msg::Command(Command::Quit) | Msg::StdinClosed => actions.push(Action::Quit),
            Msg::Command(Command::Mute(source, muted)) => {
                self.slots[source as usize].muted = muted;
            }
            Msg::Command(Command::SetDevice(source, spec)) => {
                return self.set_device(source, spec);
            }
            Msg::Source {
                source,
                generation,
                event,
            } => {
                let slot = &mut self.slots[source as usize];
                if slot.generation != generation {
                    return actions; // late event from a replaced thread
                }
                match event {
                    SourceEvent::Opened(name) => {
                        slot.name = Some(name);
                        slot.reported = true;
                        self.announce_if_started(source, &mut actions);
                    }
                    SourceEvent::Unavailable => {
                        slot.reported = true;
                        if slot.name.take().is_some() {
                            self.announce_if_started(source, &mut actions);
                        }
                    }
                    SourceEvent::Warn(msg) => actions.push(Action::Warn(msg)),
                }
            }
        }
        actions
    }

    /// Every source has reported since it was last (re)opened.
    pub fn all_reported(&self) -> bool {
        self.slots.iter().all(|s| s.reported)
    }

    /// End of startup: from now on device changes are announced; returns the first `DEVICE:`.
    pub fn start_announcing(&mut self) -> Vec<Action> {
        self.announce = true;
        vec![self.device_line(DeviceChange::Both)]
    }

    pub fn gains(&self, mic_volume: f32) -> MixGains {
        MixGains {
            sys_muted: self.slots[Source::System as usize].muted,
            mic_muted: self.slots[Source::Mic as usize].muted,
            mic_volume,
        }
    }

    #[cfg(test)]
    pub fn muted(&self, source: Source) -> bool {
        self.slots[source as usize].muted
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn named(n: &str) -> DeviceSpec {
        DeviceSpec::Named(n.into())
    }

    fn event(source: Source, generation: u64, event: SourceEvent) -> Msg {
        Msg::Source {
            source,
            generation,
            event,
        }
    }

    fn line(s: &str) -> Action {
        Action::Line(s.into())
    }

    /// Start like `engine::run`: open both sources, report, start announcing.
    fn started(mic: bool) -> Control {
        let mut c = Control::new();
        c.set_device(Source::System, Some(DeviceSpec::Default));
        c.set_device(Source::Mic, mic.then_some(DeviceSpec::Default));
        c.handle(event(Source::System, 1, SourceEvent::Opened("Speakers".into())));
        if mic {
            c.handle(event(Source::Mic, 1, SourceEvent::Opened("Mic".into())));
        }
        c.start_announcing();
        c
    }

    #[test]
    fn startup_holds_device_line_until_announcing() {
        let mut c = Control::new();
        assert!(c.all_reported());
        assert_eq!(
            c.set_device(Source::System, Some(DeviceSpec::Default)),
            vec![Action::Open {
                source: Source::System,
                spec: DeviceSpec::Default,
                generation: 1
            }]
        );
        let a = c.set_device(Source::Mic, Some(named("USB Mic")));
        assert!(matches!(a[..], [Action::Open { generation: 1, .. }]));
        assert!(!c.all_reported());
        // Reports during startup produce no lines.
        assert!(c
            .handle(event(Source::System, 1, SourceEvent::Opened("Speakers".into())))
            .is_empty());
        assert!(!c.all_reported());
        assert!(c
            .handle(event(Source::Mic, 1, SourceEvent::Opened("USB Mic".into())))
            .is_empty());
        assert!(c.all_reported());
        assert_eq!(
            c.start_announcing(),
            vec![line("DEVICE:Speakers|USB Mic|both")]
        );
    }

    #[test]
    fn no_mic_at_startup_reports_immediately() {
        let mut c = Control::new();
        c.set_device(Source::System, Some(DeviceSpec::Default));
        let a = c.set_device(Source::Mic, None);
        // Removal during startup: close, but no DEVICE line yet.
        assert_eq!(a, vec![Action::Close(Source::Mic)]);
        c.handle(event(Source::System, 1, SourceEvent::Unavailable));
        assert!(c.all_reported());
        assert_eq!(c.start_announcing(), vec![line("DEVICE:||both")]);
    }

    #[test]
    fn mute_commands_drive_gains() {
        let mut c = started(true);
        assert!(c
            .handle(Msg::Command(Command::Mute(Source::System, true)))
            .is_empty());
        let g = c.gains(1.5);
        assert!(g.sys_muted && !g.mic_muted && g.mic_volume == 1.5);
        c.handle(Msg::Command(Command::Mute(Source::Mic, true)));
        c.handle(Msg::Command(Command::Mute(Source::System, false)));
        assert!(!c.muted(Source::System) && c.muted(Source::Mic));
    }

    #[test]
    fn set_mic_none_closes_and_announces() {
        let mut c = started(true);
        assert_eq!(
            c.handle(Msg::Command(Command::SetDevice(Source::Mic, None))),
            vec![Action::Close(Source::Mic), line("DEVICE:Speakers||mic")]
        );
        // Re-adding the mic opens a new generation; announced once it reports.
        let a = c.handle(Msg::Command(Command::SetDevice(
            Source::Mic,
            Some(DeviceSpec::Default),
        )));
        assert_eq!(
            a,
            vec![Action::Open {
                source: Source::Mic,
                spec: DeviceSpec::Default,
                generation: 3
            }]
        );
        assert_eq!(
            c.handle(event(Source::Mic, 3, SourceEvent::Opened("Mic 2".into()))),
            vec![line("DEVICE:Speakers|Mic 2|mic")]
        );
    }

    #[test]
    fn switching_keeps_old_name_and_ignores_stale_generations() {
        let mut c = started(true);
        let a = c.handle(Msg::Command(Command::SetDevice(
            Source::System,
            Some(named("Headphones")),
        )));
        assert_eq!(
            a,
            vec![Action::Open {
                source: Source::System,
                spec: named("Headphones"),
                generation: 2
            }]
        );
        // The replaced thread's late events are dropped (including warnings).
        assert!(c
            .handle(event(Source::System, 1, SourceEvent::Opened("Old".into())))
            .is_empty());
        assert!(c
            .handle(event(Source::System, 1, SourceEvent::Warn("old".into())))
            .is_empty());
        assert!(c
            .handle(event(Source::System, 1, SourceEvent::Unavailable))
            .is_empty());
        // The new one: warn (fell back) then opened on the default.
        assert_eq!(
            c.handle(event(Source::System, 2, SourceEvent::Warn("gone".into()))),
            vec![Action::Warn("gone".into())]
        );
        assert_eq!(
            c.handle(event(Source::System, 2, SourceEvent::Opened("Speakers".into()))),
            vec![line("DEVICE:Speakers|Mic|sys")]
        );
        // Re-opens within a generation (default changed / named device restored) announce too.
        assert_eq!(
            c.handle(event(Source::System, 2, SourceEvent::Opened("Headphones".into()))),
            vec![line("DEVICE:Headphones|Mic|sys")]
        );
    }

    #[test]
    fn unavailable_clears_name_once() {
        let mut c = started(true);
        assert_eq!(
            c.handle(event(Source::Mic, 1, SourceEvent::Unavailable)),
            vec![line("DEVICE:Speakers||mic")]
        );
        assert!(c
            .handle(event(Source::Mic, 1, SourceEvent::Unavailable))
            .is_empty());
    }

    #[test]
    fn a_line_from_the_other_source_is_tagged_with_that_source() {
        // Switching the system device while the mic reopens on a new default: the mic's line
        // carries the OLD system name, tagged `mic`, so it can't acknowledge the system switch.
        let mut c = started(true);
        c.handle(Msg::Command(Command::SetDevice(
            Source::System,
            Some(DeviceSpec::Default),
        )));
        assert_eq!(
            c.handle(event(Source::Mic, 1, SourceEvent::Opened("Mic B".into()))),
            vec![line("DEVICE:Speakers|Mic B|mic")]
        );
        assert_eq!(
            c.handle(event(Source::System, 2, SourceEvent::Opened("Headset".into()))),
            vec![line("DEVICE:Headset|Mic B|sys")]
        );
    }

    #[test]
    fn quit_and_stdin_eof_stop() {
        let mut c = started(false);
        assert_eq!(c.handle(Msg::Command(Command::Quit)), vec![Action::Quit]);
        assert_eq!(c.handle(Msg::StdinClosed), vec![Action::Quit]);
    }
}
