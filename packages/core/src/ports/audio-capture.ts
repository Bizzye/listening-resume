export { SYSTEM_DEFAULT_DEVICE } from "../constants.js";

export type CaptureSource = "system" | "mic";

export type CaptureBackend = "wasapi" | "pulse" | "fake";

export interface AudioDevice {
	/** Friendly name (WASAPI) / pulse source name (Linux). */
	id: string;
	/** Display name. */
	name: string;
	isMonitor: boolean;
	/** Whether this is the CURRENT OS default for its type. */
	isDefault: boolean;
	type: "monitor" | "microphone";
}

export interface CaptureDevices {
	/** Device id or `SYSTEM_DEFAULT_DEVICE`. */
	system: string;
	/** Device id, `SYSTEM_DEFAULT_DEVICE`, or `null` = no mic. */
	mic: string | null;
}

export interface ResolvedDevices extends CaptureDevices {
	/** Friendly name actually open right now (resolved from `@default`). */
	systemName: string | null;
	micName: string | null;
}

/** 0..1 normalized, post-mute (what is actually being recorded). */
export interface AudioLevels {
	system: number;
	mic: number;
}

export interface CaptureOptions {
	devices: CaptureDevices;
	/** 0..2, default 1.2. */
	micVolume?: number;
	/** OUTPUT wav sample rate. */
	sampleRate: number;
	/** OUTPUT wav channels. */
	channels: number;
	chunkSeconds: number;
	outputDir: string;
	filenamePrefix: string;
}

export interface ChunkInfo {
	path: string;
	index: number;
}

export interface CaptureCapabilities {
	levels: boolean;
	liveSwitch: boolean;
	mute: boolean;
	meter: boolean;
	testTone: boolean;
}

/** A live meter WITHOUT recording (onboarding / settings test). */
export interface LevelMeter {
	onLevels(cb: (levels: AudioLevels) => void): () => void;
	/** Fired when the meter's sources (re)open (e.g. the OS default changed). */
	onDeviceChange(cb: (devices: ResolvedDevices) => void): () => void;
	stop(): Promise<void>;
}

export interface AudioCapturePort {
	readonly backend: CaptureBackend;
	readonly capabilities: CaptureCapabilities;
	/** Whether the backend can run at all (binary/ffmpeg present). */
	isAvailable(): Promise<boolean>;
	listDevices(): Promise<AudioDevice[]>;
	startCapture(options: CaptureOptions): Promise<void>;
	/** Finalizes the current chunk and resolves with every chunk of this capture. */
	stopCapture(): Promise<ChunkInfo[]>;
	/** Fired when a chunk file is finalized. Returns an unsubscribe function. */
	onChunkReady(cb: (info: ChunkInfo) => void): () => void;
	/** Returns an unsubscribe function. */
	onLevels(cb: (levels: AudioLevels) => void): () => void;
	/** Fired when a source (re)opens. */
	onDeviceChange(cb: (devices: ResolvedDevices) => void): () => void;
	/**
	 * Fatal capture failure AFTER `startCapture` resolved (process died). Startup failures
	 * reject `startCapture` instead; non-fatal problems go through `onWarning`.
	 */
	onError(cb: (err: Error) => void): () => void;
	/**
	 * Non-fatal capture problem while recording (e.g. a named device is missing and the
	 * system default is captured instead). The raw backend message; see `describeCaptureWarning`.
	 */
	onWarning(cb: (message: string) => void): () => void;
	setInputMute(source: CaptureSource, muted: boolean): Promise<void>;
	getInputMuteState(): Record<CaptureSource, boolean>;
	switchDevices(devices: Partial<CaptureDevices>): Promise<ResolvedDevices>;
	/** `null` when not capturing. */
	getActiveDevices(): ResolvedDevices | null;
	startMeter(devices: CaptureDevices): Promise<LevelMeter>;
	playTestTone(device: string): Promise<void>;
}
