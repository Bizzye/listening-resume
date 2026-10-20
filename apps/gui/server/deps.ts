import type {
	ActiveRecording,
	AnalyzerPort,
	AudioCapturePort,
	AudioLevels,
	CaptureDevices,
	CaptureSource,
	FileStoragePort,
	ProcessRunner,
	ResolvedDevices,
	Session,
	SessionRepository,
	Settings,
	TranscriberPort,
} from "@listening-resume/core";
import type { FetchLike, GroqKeyStore } from "./services/groq-key.js";
import type { HealthCheckers } from "./services/health.js";
import type { WavInfoLike } from "./services/wav-stream.js";

/** The slice of core's RecordingService the HTTP layer uses. */
export interface RecordingController {
	start(opts: { devices: CaptureDevices; title?: string }): Promise<Session>;
	stop(): Promise<{ session: Session; chunks: number }>;
	discard(): Promise<void>;
	getActive(): ActiveRecording | null;
	setMute(source: CaptureSource, muted: boolean): Promise<void>;
	switchDevices(devices: Partial<CaptureDevices>): Promise<ResolvedDevices>;
	onLevels(cb: (l: AudioLevels) => void): () => void;
	onDeviceChange(cb: (d: ResolvedDevices) => void): () => void;
	/** Non-fatal capture warning (raw backend text, e.g. a named device fell back to default). */
	onWarning(cb: (message: string) => void): () => void;
	/** Fired when the capture dies mid-recording (the session is already settled). */
	onInterrupted(cb: (session: Session) => void): () => void;
}

export interface SettingsStoreLike {
	get(): Settings;
	update(partial: Partial<Settings>): Settings;
}

export interface Logger {
	info(msg: string): void;
	warn(msg: string): void;
	error(msg: string): void;
}

export interface AudioFormat {
	sampleRate: number;
	channels: number;
	chunkSeconds: number;
}

export interface TranscriptionFactory {
	/** Build a transcriber for the current settings. Throws a validation error when unusable. */
	create(settings: Settings): TranscriberPort;
}

export interface AnalysisFactory {
	create(settings: Settings): { primary: AnalyzerPort; fallback: AnalyzerPort | null };
}

export interface AppDeps {
	repo: SessionRepository;
	storage: FileStoragePort;
	recording: RecordingController;
	capture: AudioCapturePort;
	settings: SettingsStoreLike;
	groqKey: GroqKeyStore;
	transcription: TranscriptionFactory;
	/** Groq quotas shared by every transcription (default 18 RPM / 7000 audio s/h). */
	rateLimits?: { requestsPerMinute: number; audioSecondsPerHour: number };
	/** ISO code or "auto" (config `transcription.language`). */
	transcriptionLanguage?: string;
	/** Vocabulary hint (config `transcription.prompt`). */
	transcriptionPrompt?: string;
	analysis: AnalysisFactory;
	health: HealthCheckers;
	fetch: FetchLike;
	/** Runs ffmpeg (imports). */
	run: ProcessRunner;
	/** ffmpeg conversion timeout for imports (default 30 min, env `LR_IMPORT_TIMEOUT_MS`). */
	importTimeoutMs?: number;
	audio: AudioFormat;
	/** Scratch dir for uploads (imports). */
	tmpDir: string;
	readWavInfo(path: string): WavInfoLike & { durationSec: number };
	logger: Logger;
	newId?: () => string;
	now?: () => Date;
	sseHeartbeatMs?: number;
	/** How often SSE streams check whether a recording started/stopped (default 250 ms). */
	ssePollMs?: number;
	/** A level meter silent for this long is considered dead (default 5000 ms). */
	meterStallMs?: number;
	/** Extra allowed browser origins (default: `LR_ALLOWED_ORIGINS`). */
	allowedOrigins?: string[];
	/** Max accepted import size in bytes (default 4 GB). */
	importLimitBytes?: number;
}
