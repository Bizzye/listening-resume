import { useCallback, useEffect, useRef, useState } from "react";
import { SYSTEM_DEFAULT_DEVICE } from "../../shared/api/types";
import { useAudioLevels } from "../../shared/hooks/useAudioLevels";
import { useLatest } from "../../shared/hooks/useLatest";
import { usePolling } from "../../shared/hooks/usePolling";
import { deviceLabel, displayDeviceName, fallbackDeviceName } from "../../shared/lib/devices";
import { fmtClock } from "../../shared/lib/format";
import { DeviceSelect } from "../../shared/ui/DeviceSelect";
import { Icon } from "../../shared/ui/Icon";
import { LevelBars } from "../../shared/ui/LevelBars";
import { useStore } from "../../store";
import type { ActiveRecording } from "../../store/slices/recording";
import {
	mixLevels,
	neutralLevel,
	nextQuietFrames,
	SILENCE_FRAMES,
	WAVE_BARS,
	waveBarHeight,
} from "./waveform";

const STATUS_POLL_MS = 2000;

function RecordingTimer({ startTime }: { startTime: number }) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), 500);
		return () => clearInterval(id);
	}, []);
	return (
		<div className="timer" data-testid="recording-timer">
			{fmtClock((now - startTime) / 1000)}
		</div>
	);
}

export function recordingSourceLabel(
	rec: ActiveRecording,
	devicesLabel: (v: string | null) => string,
): string {
	const d = rec.devices;
	if (!d) return "Áudio do sistema";
	const sys = d.systemName ? displayDeviceName(d.systemName) : devicesLabel(d.system);
	if (d.mic === null) return sys;
	return `${sys} + ${d.micName ? displayDeviceName(d.micName) : devicesLabel(d.mic)}`;
}

export type LevelsMode = "live" | "neutral" | "connecting" | "reconnecting";

/** Full-screen recording view (no sidebar). */
export function RecordingScreen({ recording: rec }: { recording: ActiveRecording }) {
	const devices = useStore((s) => s.devices);
	const silenceDetection = useStore((s) => s.settings?.silenceDetection ?? true);
	// Older servers do not report capabilities: assume levels are measured.
	const levelsSupported = useStore((s) => s.health?.services.capture.levels !== false);
	const pending = useStore((s) => s.recordingPending);
	const {
		syncRecording,
		stopRecording,
		discardRecording,
		toggleMute,
		switchCaptureDevice,
		setLiveDevices,
		refreshDevices,
		recordingEnded,
		pop,
	} = useStore.getState();

	usePolling(syncRecording, STATUS_POLL_MS);

	// During a recording the server streams the recording's own levels (query ignored).
	const levels = useAudioLevels({
		onDevices: (d) => {
			setLiveDevices(d);
			refreshDevices();
		},
		onEnded: () => void recordingEnded(),
		// e.g. "Dispositivo indisponível — usando o padrão do sistema" (named device missing).
		onWarning: (w) => pop(w.message, w.fallback ? "err" : "ac"),
	});
	const mode: LevelsMode =
		!levelsSupported || levels.unavailable !== null
			? "neutral"
			: levels.connected
				? "live"
				: levels.hasConnected && !levels.ended
					? "reconnecting"
					: "connecting";
	// Silence is only measured on a live stream (a dropped stream is not silence).
	const measuring = useLatest(mode === "live");
	const neutral = useLatest(mode === "neutral");

	const [silentDet, setSilentDet] = useState(false);
	const quiet = useRef(0);
	const silentRef = useRef(false);
	const onFrame = useCallback(
		(lvl: number) => {
			quiet.current = measuring.current ? nextQuietFrames(quiet.current, lvl) : 0;
			const sil = quiet.current > SILENCE_FRAMES;
			if (sil !== silentRef.current) {
				silentRef.current = sil;
				setSilentDet(sil);
			}
		},
		[measuring],
	);
	const { read: readLevels } = levels;
	const getLevel = useCallback(
		() => (neutral.current ? neutralLevel(performance.now()) : mixLevels(readLevels())),
		[neutral, readLevels],
	);

	const mic = rec.devices ? rec.devices.mic : null;
	const allMuted = rec.muted.system && (rec.muted.mic || mic === null);
	const silentWarn = allMuted || (silenceDetection && mode === "live" && silentDet);
	const label = (v: string | null) => deviceLabel(devices, v);
	const liveSystemDefault =
		rec.devices?.system === SYSTEM_DEFAULT_DEVICE ? rec.devices.systemName : null;
	const liveMicDefault = rec.devices?.mic === SYSTEM_DEFAULT_DEVICE ? rec.devices.micName : null;
	// A named device that fell back to the system default: show what is really recording.
	const systemFallback = fallbackDeviceName(rec.devices?.system, rec.devices?.systemName);
	const micFallback = fallbackDeviceName(rec.devices?.mic, rec.devices?.micName);
	const wrapCls = silentWarn
		? "wavewrap dead"
		: mode === "neutral"
			? "wavewrap neutral"
			: "wavewrap";

	return (
		<div className="rec" data-screen-label="Gravação" data-testid="recording-screen">
			<div className="fx jb ac">
				<div className="fx ac gap10">
					<span className="recdot big" />
					<span className="fw7 fs12 upper" style={{ letterSpacing: ".12em" }}>
						Gravando
					</span>
					<span className="rmeta">
						{recordingSourceLabel(rec, label)} · Chunk{" "}
						<span className="mono" data-testid="recording-chunk">
							{String(rec.chunks + 1).padStart(2, "0")}
						</span>
					</span>
				</div>
				<button
					type="button"
					className="ghost"
					data-testid="discard-recording-button"
					disabled={pending}
					onClick={() => void discardRecording()}
				>
					Descartar
				</button>
			</div>

			<div className="col ac jc f1 gap24">
				<div className={wrapCls} data-levels={mode} data-testid="wavewrap">
					<LevelBars
						count={WAVE_BARS}
						getLevel={getLevel}
						height={waveBarHeight}
						gap={4}
						style={{ height: 170 }}
						onFrame={onFrame}
						testId="waveform"
					/>
				</div>
				<RecordingTimer startTime={rec.startTime} />
				{silentWarn ? (
					<div className="warn" role="alert" data-testid="silence-warning">
						<span className="tdot k-err" />
						Não estou captando áudio — desmute uma fonte ou verifique se algo está tocando.
					</div>
				) : mode === "neutral" ? (
					<span className="hint lvl-note" data-testid="levels-status">
						Medidor de nível indisponível neste sistema — a gravação continua normalmente.
					</span>
				) : mode === "reconnecting" ? (
					<span className="hint lvl-note" role="status" data-testid="levels-status">
						Reconectando ao medidor…
					</span>
				) : null}
			</div>

			<div className="col ac gap12" style={{ paddingBottom: 14 }}>
				<div style={{ display: "flex", alignItems: "flex-end", gap: 16, marginBottom: 22 }}>
					<div className="dvw">
						<span className="dvl">Fone / saída</span>
						<DeviceSelect
							kind="system"
							className="dvs"
							label="Fone / saída"
							devices={devices}
							value={rec.devices?.system ?? SYSTEM_DEFAULT_DEVICE}
							liveDefaultName={liveSystemDefault}
							onChange={(v) => void switchCaptureDevice("system", v)}
							testId="recording-device-select"
						/>
						{systemFallback ? (
							<span className="dvm" role="status" data-testid="system-device-fallback">
								Indisponível — gravando de {systemFallback}
							</span>
						) : null}
					</div>
					<div className="dvw">
						<span className="dvl">Microfone</span>
						<DeviceSelect
							kind="mic"
							className="dvs"
							label="Microfone"
							devices={devices}
							value={mic}
							liveDefaultName={liveMicDefault}
							onChange={(v) => void switchCaptureDevice("mic", v)}
							testId="mic-device-select"
						/>
						{micFallback ? (
							<span className="dvm" role="status" data-testid="mic-device-fallback">
								Indisponível — gravando de {micFallback}
							</span>
						) : null}
					</div>
				</div>
				<div style={{ display: "flex", alignItems: "flex-start", gap: 56, marginBottom: 10 }}>
					<div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
						<button
							type="button"
							className={rec.muted.system ? "ctl mut" : "ctl"}
							aria-label={rec.muted.system ? "Desmutar áudio do sistema" : "Mutar áudio do sistema"}
							aria-pressed={rec.muted.system}
							data-testid="mute-system-button"
							onClick={() => void toggleMute("system")}
						>
							<Icon name="speaker" size={22} />
						</button>
						<span className="ctll">{rec.muted.system ? "Sistema mudo" : "Sistema"}</span>
					</div>
					<div
						style={{
							display: "flex",
							flexDirection: "column",
							alignItems: "center",
							gap: 10,
							marginTop: -11,
						}}
					>
						<button
							type="button"
							className="ctl stop"
							aria-label="Parar gravação"
							data-testid="stop-recording-button"
							disabled={pending}
							onClick={() => void stopRecording()}
						>
							<span className="stopsq" />
						</button>
						<span className="ctll">Parar</span>
					</div>
					<div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
						<button
							type="button"
							className={rec.muted.mic ? "ctl mut" : "ctl"}
							aria-label={rec.muted.mic ? "Desmutar microfone" : "Mutar microfone"}
							aria-pressed={rec.muted.mic}
							data-testid="mute-mic-button"
							disabled={mic === null}
							onClick={() => void toggleMute("mic")}
						>
							<Icon name="mic" size={22} />
						</button>
						<span className="ctll">
							{mic === null ? "Sem microfone" : rec.muted.mic ? "Mic mudo" : "Microfone"}
						</span>
					</div>
				</div>
				<span className="kbd">Ctrl+Shift+R</span>
			</div>
		</div>
	);
}
