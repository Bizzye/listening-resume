import fs from "node:fs";
import path from "node:path";
import { AudioCaptureError } from "../../domain/errors.js";
import {
	type AudioCapturePort,
	type AudioDevice,
	type AudioLevels,
	type CaptureCapabilities,
	type CaptureDevices,
	type CaptureOptions,
	type CaptureSource,
	type ChunkInfo,
	type LevelMeter,
	type ResolvedDevices,
	SYSTEM_DEFAULT_DEVICE,
} from "../../ports/audio-capture.js";
import { Listeners } from "../../utils/listeners.js";
import { createWav } from "../../utils/wav.js";

export const FAKE_DEVICES: readonly AudioDevice[] = [
	{
		id: "Alto-falantes (Realtek(R) Audio)",
		name: "Alto-falantes (Realtek(R) Audio) (Loopback)",
		isMonitor: true,
		isDefault: true,
		type: "monitor",
	},
	{
		id: "Fones de ouvido (WH-1000XM4)",
		name: "Fones de ouvido (WH-1000XM4) (Loopback)",
		isMonitor: true,
		isDefault: false,
		type: "monitor",
	},
	{
		id: "Microfone (Realtek(R) Audio)",
		name: "Microfone (Realtek(R) Audio)",
		isMonitor: false,
		isDefault: true,
		type: "microphone",
	},
	{
		id: "Microfone (USB Audio Device)",
		name: "Microfone (USB Audio Device)",
		isMonitor: false,
		isDefault: false,
		type: "microphone",
	},
];

export interface FakeCaptureOptions {
	devices?: readonly AudioDevice[];
	/** Level event period (also the audio generation tick). Default 50 ms. */
	levelIntervalMs?: number;
	/** Generate audio/levels on a wall-clock timer. Disable for fully manual `advance()`. */
	realtime?: boolean;
}

/** Deterministic smooth "speech-like" envelope in 0..1 (no Math.random). */
function envelope(t: number, seed: number): number {
	const v =
		0.55 +
		0.25 * Math.sin(t * 2.3 + seed) +
		0.15 * Math.sin(t * 7.1 + seed * 2) +
		0.05 * Math.sin(t * 17.3 + seed * 3);
	return Math.min(1, Math.max(0, v));
}

/**
 * In-memory capture for tests and the e2e test server: writes real 16-bit PCM WAV chunks
 * (system = 440 Hz tone, mic = 220 Hz tone, both amplitude-modulated), emits levels every
 * 50 ms honoring mute, and supports live switching, meters and test tones.
 * `advance(seconds)` fast-forwards the recording synchronously.
 */
export class FakeCaptureAdapter implements AudioCapturePort {
	readonly backend = "fake" as const;
	readonly capabilities: CaptureCapabilities = {
		levels: true,
		liveSwitch: true,
		mute: true,
		meter: true,
		testTone: true,
	};

	/** Devices passed to `playTestTone`, in order. */
	readonly testTones: string[] = [];

	private readonly devices: readonly AudioDevice[];
	private readonly intervalMs: number;
	private readonly realtime: boolean;

	private options: CaptureOptions | null = null;
	private active: ResolvedDevices | null = null;
	private muted: Record<CaptureSource, boolean> = { system: false, mic: false };
	private chunks: ChunkInfo[] = [];
	private pending: Int16Array[] = [];
	private pendingFrames = 0;
	private totalFrames = 0;
	private startedAt = 0;
	private timer: ReturnType<typeof setInterval> | null = null;

	private readonly chunkReady = new Listeners<ChunkInfo>();
	private readonly levels = new Listeners<AudioLevels>();
	private readonly deviceChanges = new Listeners<ResolvedDevices>();
	private readonly errors = new Listeners<Error>();
	private readonly warnings = new Listeners<string>();

	constructor(options: FakeCaptureOptions = {}) {
		this.devices = options.devices ?? FAKE_DEVICES;
		this.intervalMs = options.levelIntervalMs ?? 50;
		this.realtime = options.realtime ?? true;
	}

	get isCapturing(): boolean {
		return this.options !== null;
	}

	async isAvailable(): Promise<boolean> {
		return true;
	}

	async listDevices(): Promise<AudioDevice[]> {
		return this.devices.map((d) => ({ ...d }));
	}

	private resolveName(source: CaptureSource, id: string | null): string | null {
		if (!id) return null;
		const type = source === "system" ? "monitor" : "microphone";
		const device =
			id === SYSTEM_DEFAULT_DEVICE
				? this.devices.find((d) => d.type === type && d.isDefault)
				: this.devices.find((d) => d.id === id);
		return device?.id ?? (id === SYSTEM_DEFAULT_DEVICE ? null : id);
	}

	private resolve(devices: CaptureDevices): ResolvedDevices {
		return {
			...devices,
			systemName: this.resolveName("system", devices.system),
			micName: this.resolveName("mic", devices.mic),
		};
	}

	async startCapture(options: CaptureOptions): Promise<void> {
		if (this.options) throw new AudioCaptureError("Uma captura já está em andamento.");
		fs.mkdirSync(options.outputDir, { recursive: true });
		this.options = options;
		this.chunks = [];
		this.pending = [];
		this.pendingFrames = 0;
		this.totalFrames = 0;
		this.muted = { system: false, mic: false };
		this.active = this.resolve(options.devices);
		this.startedAt = Date.now();
		this.deviceChanges.emit({ ...this.active });
		if (this.realtime) {
			this.timer = setInterval(() => this.tick(), this.intervalMs);
			this.timer.unref?.();
		}
	}

	private tick(): void {
		const opts = this.options;
		if (!opts) return;
		const due = Math.round(((Date.now() - this.startedAt) / 1000) * opts.sampleRate);
		if (due > this.totalFrames) this.generate(due - this.totalFrames);
		this.levels.emit(this.currentLevels());
	}

	/** Levels at the current recording position (0 for muted / absent sources). */
	private currentLevels(): AudioLevels {
		const t = this.options ? this.totalFrames / this.options.sampleRate : 0;
		return this.levelsAt(t, this.active, this.muted);
	}

	private levelsAt(
		t: number,
		devices: CaptureDevices | null,
		muted: Record<CaptureSource, boolean>,
	): AudioLevels {
		const round = (v: number) => Math.round(v * 10_000) / 10_000;
		return {
			system: devices && !muted.system ? round(0.15 + 0.6 * envelope(t, 1)) : 0,
			mic: devices?.mic && !muted.mic ? round(0.05 + 0.45 * envelope(t, 4)) : 0,
		};
	}

	/** Synthesizes `frames` frames, finalizing chunks at `chunkSeconds` boundaries. */
	private generate(frames: number): void {
		const opts = this.options;
		if (!opts) return;
		const perChunk = Math.max(1, Math.round(opts.chunkSeconds * opts.sampleRate));
		let remaining = frames;
		while (remaining > 0) {
			const n = Math.min(remaining, perChunk - this.pendingFrames);
			this.pending.push(this.synthesize(this.totalFrames, n));
			this.pendingFrames += n;
			this.totalFrames += n;
			remaining -= n;
			if (this.pendingFrames >= perChunk) this.finalizeChunk();
		}
	}

	private synthesize(startFrame: number, frames: number): Int16Array {
		const opts = this.options as CaptureOptions;
		const { sampleRate, channels } = opts;
		const hasMic = Boolean(this.active?.mic);
		const out = new Int16Array(frames * channels);
		for (let i = 0; i < frames; i++) {
			const t = (startFrame + i) / sampleRate;
			let v = 0;
			if (!this.muted.system) v += 0.3 * envelope(t, 1) * Math.sin(2 * Math.PI * 440 * t);
			if (hasMic && !this.muted.mic) v += 0.2 * envelope(t, 4) * Math.sin(2 * Math.PI * 220 * t);
			const sample = Math.round(Math.max(-1, Math.min(1, v)) * 0x7fff);
			for (let c = 0; c < channels; c++) out[i * channels + c] = sample;
		}
		return out;
	}

	private finalizeChunk(): void {
		const opts = this.options;
		if (!opts || this.pendingFrames === 0) return;
		const samples = new Int16Array(this.pendingFrames * opts.channels);
		let offset = 0;
		for (const part of this.pending) {
			samples.set(part, offset);
			offset += part.length;
		}
		const index = this.chunks.length;
		const file = path.join(
			opts.outputDir,
			`${opts.filenamePrefix}_${String(index).padStart(4, "0")}.wav`,
		);
		fs.writeFileSync(
			file,
			createWav(samples, { sampleRate: opts.sampleRate, channels: opts.channels }),
		);
		this.pending = [];
		this.pendingFrames = 0;
		const info: ChunkInfo = { path: file, index };
		this.chunks.push(info);
		this.chunkReady.emit(info);
	}

	/** Fast-forwards the recording by `seconds` of audio (synchronously writes chunks). */
	advance(seconds: number): void {
		const opts = this.options;
		if (!opts) throw new AudioCaptureError("Nenhuma captura em andamento.");
		this.generate(Math.round(seconds * opts.sampleRate));
		this.startedAt -= seconds * 1000; // keep the realtime clock consistent
		this.levels.emit(this.currentLevels());
	}

	/** Simulates the capture process dying mid-recording. */
	simulateCrash(message = "Falha simulada na captura"): void {
		this.clearTimer();
		this.options = null;
		this.active = null;
		this.errors.emit(new AudioCaptureError(message));
	}

	/**
	 * Simulates a named device going missing mid-recording, like the native binary does: a
	 * `WARN:` naming the fallback, then the source reopens on the system default (the requested
	 * id is kept — the binary keeps trying to restore it).
	 */
	simulateFallback(source: CaptureSource = "system"): void {
		if (!this.active) throw new AudioCaptureError("Nenhuma captura em andamento.");
		const label = source === "system" ? "system audio" : "microphone";
		const requested = source === "system" ? this.active.system : this.active.mic;
		this.warnings.emit(
			`could not open ${label} '${requested}' (not found); falling back to the system default`,
		);
		const name = this.resolveName(source, SYSTEM_DEFAULT_DEVICE);
		this.active =
			source === "system"
				? { ...this.active, systemName: name }
				: { ...this.active, micName: name };
		this.deviceChanges.emit({ ...this.active });
	}

	/** Emits a non-fatal capture warning (as the native binary's `WARN:` lines). */
	simulateWarning(message: string): void {
		this.warnings.emit(message);
	}

	private clearTimer(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	async stopCapture(): Promise<ChunkInfo[]> {
		if (this.options) {
			if (this.realtime) this.tick(); // catch up to the wall clock
			this.finalizeChunk();
		}
		this.clearTimer();
		this.options = null;
		this.active = null;
		const chunks = this.chunks;
		this.chunks = [];
		return chunks;
	}

	onChunkReady(cb: (info: ChunkInfo) => void): () => void {
		return this.chunkReady.on(cb);
	}

	onLevels(cb: (levels: AudioLevels) => void): () => void {
		return this.levels.on(cb);
	}

	onDeviceChange(cb: (devices: ResolvedDevices) => void): () => void {
		return this.deviceChanges.on(cb);
	}

	onError(cb: (err: Error) => void): () => void {
		return this.errors.on(cb);
	}

	onWarning(cb: (message: string) => void): () => void {
		return this.warnings.on(cb);
	}

	async setInputMute(source: CaptureSource, muted: boolean): Promise<void> {
		this.muted = { ...this.muted, [source]: muted };
	}

	getInputMuteState(): Record<CaptureSource, boolean> {
		return { ...this.muted };
	}

	async switchDevices(devices: Partial<CaptureDevices>): Promise<ResolvedDevices> {
		if (!this.options || !this.active) {
			throw new AudioCaptureError("Nenhuma captura em andamento para trocar o dispositivo.");
		}
		const next: CaptureDevices = {
			system: devices.system ?? this.active.system,
			mic: devices.mic !== undefined ? devices.mic : this.active.mic,
		};
		this.active = this.resolve(next);
		this.deviceChanges.emit({ ...this.active });
		return { ...this.active };
	}

	getActiveDevices(): ResolvedDevices | null {
		return this.active ? { ...this.active } : null;
	}

	async startMeter(devices: CaptureDevices): Promise<LevelMeter> {
		const levels = new Listeners<AudioLevels>();
		const deviceChanges = new Listeners<ResolvedDevices>();
		const resolved = this.resolve(devices);
		const started = Date.now();
		let first = true;
		const timer = setInterval(() => {
			if (first) {
				first = false;
				deviceChanges.emit({ ...resolved });
			}
			const t = (Date.now() - started) / 1000;
			levels.emit(this.levelsAt(t, resolved, { system: false, mic: false }));
		}, this.intervalMs);
		timer.unref?.();
		return {
			onLevels: (cb) => levels.on(cb),
			onDeviceChange: (cb) => deviceChanges.on(cb),
			stop: async () => {
				clearInterval(timer);
				levels.clear();
				deviceChanges.clear();
			},
		};
	}

	async playTestTone(device: string): Promise<void> {
		this.testTones.push(device);
	}
}
