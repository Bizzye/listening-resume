import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_MIC_VOLUME } from "../../constants.js";
import { AudioCaptureError, errorMessage } from "../../domain/errors.js";
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
import { logger } from "../../utils/logger.js";
import { type RunResult, run, waitForExit } from "../../utils/process.js";
import { createWav, floatToPcm16 } from "../../utils/wav.js";

const PULSE_DEFAULT_MONITOR = "@DEFAULT_MONITOR@";
const PULSE_DEFAULT_SOURCE = "@DEFAULT_SOURCE@";

/** Maps port device ids to pulse source names (`@default` → pulse's default aliases). Pure. */
export function toPulseSource(source: CaptureSource, device: string): string {
	if (device !== SYSTEM_DEFAULT_DEVICE) return device;
	return source === "system" ? PULSE_DEFAULT_MONITOR : PULSE_DEFAULT_SOURCE;
}

/** ffmpeg argv for one chunk. Pure. */
export function buildPulseArgs(
	opts: CaptureOptions,
	chunkPath: string,
	muted: Record<CaptureSource, boolean>,
): string[] {
	const { devices } = opts;
	const sysVol = muted.system ? 0 : 1;
	const args = ["-hide_banner", "-loglevel", "error", "-thread_queue_size", "1024", "-f", "pulse"];
	args.push("-i", toPulseSource("system", devices.system));
	if (devices.mic) {
		const micVol = muted.mic ? 0 : (opts.micVolume ?? DEFAULT_MIC_VOLUME);
		args.push("-thread_queue_size", "1024", "-f", "pulse", "-i", toPulseSource("mic", devices.mic));
		args.push(
			"-filter_complex",
			`[0:a]aresample=async=1,volume=${sysVol}[sys];[1:a]aresample=async=1,volume=${micVol}[mic];` +
				"[sys][mic]amix=inputs=2:duration=first:dropout_transition=3:normalize=0," +
				"alimiter=limit=0.95:attack=5:release=50[mixed]",
			"-map",
			"[mixed]",
		);
	} else if (muted.system) {
		args.push("-af", "volume=0");
	}
	args.push(
		"-ac",
		String(opts.channels),
		"-ar",
		String(opts.sampleRate),
		"-t",
		String(opts.chunkSeconds),
		"-y",
		chunkPath,
	);
	return args;
}

export type CommandRunner = (
	command: string,
	args: string[],
	timeoutMs?: number,
) => Promise<RunResult>;

export interface FFmpegPulseAdapterOptions {
	/** ffmpeg executable (default `ffmpeg` on PATH). */
	ffmpegPath?: string;
	/** Arguments placed before the ffmpeg args (lets tests run a script through node). */
	ffmpegArgsPrefix?: string[];
	/** Runs short helper commands (`pactl`, `pw-cli`, players). Injectable for tests. */
	runCommand?: CommandRunner;
}

/** How long a `pactl get-default-*` lookup may take before falling back to the alias. */
const RESOLVE_TIMEOUT_MS = 2000;

/**
 * Linux capture with ffmpeg + PulseAudio/PipeWire. One ffmpeg process per chunk; mute and
 * device switches finish the current chunk and continue in a new one (no live levels).
 */
export class FFmpegPulseAdapter implements AudioCapturePort {
	readonly backend = "pulse" as const;
	readonly capabilities: CaptureCapabilities = {
		levels: false,
		liveSwitch: true,
		mute: true,
		meter: false,
		testTone: true,
	};

	private readonly ffmpegPath: string;
	private readonly ffmpegArgsPrefix: string[];
	private readonly run: CommandRunner;

	private proc: ChildProcess | null = null;
	private options: CaptureOptions | null = null;
	private recording = false;
	/** Settles once the current chunk's ffmpeg spawned and its device names were resolved. */
	private chunkStarted: Promise<void> | null = null;
	/** Processes killed on purpose (chunk rotation): their exit is never a failure. */
	private readonly rotated = new WeakSet<ChildProcess>();
	private chunks: ChunkInfo[] = [];
	private muted: Record<CaptureSource, boolean> = { system: false, mic: false };
	private active: ResolvedDevices | null = null;

	private readonly chunkReady = new Listeners<ChunkInfo>();
	private readonly levels = new Listeners<AudioLevels>();
	private readonly deviceChanges = new Listeners<ResolvedDevices>();
	private readonly errors = new Listeners<Error>();
	/** ffmpeg reports no recoverable problems; kept for the port contract. */
	private readonly warnings = new Listeners<string>();

	constructor(options: FFmpegPulseAdapterOptions = {}) {
		this.ffmpegPath = options.ffmpegPath ?? "ffmpeg";
		this.ffmpegArgsPrefix = options.ffmpegArgsPrefix ?? [];
		this.run = options.runCommand ?? run;
	}

	async isAvailable(): Promise<boolean> {
		try {
			const args = [...this.ffmpegArgsPrefix, "-hide_banner", "-version"];
			return (await this.run(this.ffmpegPath, args, 5000)).code === 0;
		} catch {
			return false;
		}
	}

	async listDevices(): Promise<AudioDevice[]> {
		try {
			return await this.listWithPactl();
		} catch {
			return await this.listWithPwCli();
		}
	}

	private async pactl(args: string[]): Promise<string> {
		const result = await this.run("pactl", args, 5000);
		if (result.code !== 0) throw new AudioCaptureError(`pactl ${args.join(" ")} failed`);
		return result.stdout;
	}

	private async listWithPactl(): Promise<AudioDevice[]> {
		const [sinks, sources, defaultSink, defaultSource] = await Promise.all([
			this.pactl(["list", "sinks", "short"]),
			this.pactl(["list", "sources", "short"]).catch(() => ""),
			this.pactl(["get-default-sink"]).catch(() => ""),
			this.pactl(["get-default-source"]).catch(() => ""),
		]);
		const names = (out: string) =>
			out
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => line.split("\t")[1] ?? "")
				.filter(Boolean);

		const monitors: AudioDevice[] = names(sinks).map((sink) => ({
			id: `${sink}.monitor`,
			name: sink,
			isMonitor: true,
			isDefault: sink === defaultSink.trim(),
			type: "monitor",
		}));
		const mics: AudioDevice[] = names(sources)
			.filter((s) => !s.endsWith(".monitor"))
			.map((source) => ({
				id: source,
				name: source.replace(/^alsa_input\./, "").replace(/\./g, " "),
				isMonitor: false,
				isDefault: source === defaultSource.trim(),
				type: "microphone",
			}));
		return [...monitors, ...mics];
	}

	private async listWithPwCli(): Promise<AudioDevice[]> {
		let output: string;
		try {
			const result = await this.run("pw-cli", ["list-objects", "Node"], 5000);
			if (result.code !== 0) throw new Error("pw-cli failed");
			output = result.stdout;
		} catch {
			throw new AudioCaptureError(
				"Nenhum utilitário de áudio encontrado. Instale pulseaudio-utils (pactl) ou pipewire.",
			);
		}
		const devices: AudioDevice[] = [];
		for (const block of output.split(/(?=id \d+)/)) {
			const name = block.match(/node\.name\s*=\s*"([^"]+)"/)?.[1];
			const mediaClass = block.match(/media\.class\s*=\s*"([^"]+)"/)?.[1];
			const label =
				block.match(/node\.description\s*=\s*"([^"]+)"/)?.[1] ??
				block.match(/node\.nick\s*=\s*"([^"]+)"/)?.[1];
			if (!name || !mediaClass) continue;
			if (mediaClass.includes("Sink")) {
				devices.push({
					id: `${name}.monitor`,
					name: label ?? name,
					isMonitor: true,
					isDefault: !devices.some((d) => d.isMonitor),
					type: "monitor",
				});
			} else if (mediaClass === "Audio/Source") {
				devices.push({
					id: name,
					name: label ?? name.replace(/^alsa_input\./, "").replace(/\./g, " "),
					isMonitor: false,
					isDefault: !devices.some((d) => !d.isMonitor),
					type: "microphone",
				});
			}
		}
		return devices;
	}

	/**
	 * Resolves once the first ffmpeg process spawned (rejects when it cannot start, e.g. ffmpeg
	 * missing). Failures after that (device unavailable, ffmpeg died) go through `onError`.
	 */
	async startCapture(options: CaptureOptions): Promise<void> {
		if (this.recording) throw new AudioCaptureError("Uma captura já está em andamento.");
		this.options = options;
		this.recording = true;
		this.chunks = [];
		this.muted = { system: false, mic: false };
		this.active = { ...options.devices, systemName: null, micName: null };
		try {
			await this.startChunk();
		} catch (err) {
			this.reset();
			throw err;
		}
	}

	private reset(): void {
		this.recording = false;
		this.options = null;
		this.active = null;
		this.proc = null;
		this.chunkStarted = null;
	}

	/** Fatal failure mid-recording: reported once, capture state cleared. */
	private fail(err: unknown): void {
		if (!this.recording) return;
		this.reset();
		this.errors.emit(
			err instanceof AudioCaptureError ? err : new AudioCaptureError(errorMessage(err)),
		);
	}

	private startChunk(): Promise<void> {
		const started = this.spawnChunk();
		this.chunkStarted = started.catch(() => {});
		return started;
	}

	/** Spawns ffmpeg for the next chunk; resolves after `spawn` + device-name resolution. */
	private async spawnChunk(): Promise<void> {
		const opts = this.options;
		if (!this.recording || !opts) return;

		const index = this.chunks.length;
		const chunkPath = path.join(
			opts.outputDir,
			`${opts.filenamePrefix}_${String(index).padStart(4, "0")}.wav`,
		);
		const proc = spawn(
			this.ffmpegPath,
			[...this.ffmpegArgsPrefix, ...buildPulseArgs(opts, chunkPath, this.muted)],
			{ stdio: ["pipe", "ignore", "pipe"], windowsHide: true },
		);
		this.proc = proc;
		let stderr = "";
		proc.stderr?.setEncoding("utf8");
		proc.stderr?.on("data", (d: string) => {
			stderr = (stderr + d).slice(-2000);
		});

		await new Promise<void>((resolve, reject) => {
			proc.once("spawn", () => {
				proc.off("error", onSpawnError);
				resolve();
			});
			const onSpawnError = (err: Error) => {
				if (this.proc === proc) this.proc = null;
				reject(new AudioCaptureError(`FFmpeg não pôde ser iniciado: ${err.message}`));
			};
			proc.once("error", onSpawnError);
		});

		proc.on("error", (err) => {
			if (this.proc === proc) this.fail(new AudioCaptureError(`FFmpeg falhou: ${err.message}`));
		});
		proc.on("close", (code) => {
			if (this.proc === proc) this.proc = null;
			const written = fs.existsSync(chunkPath) && fs.statSync(chunkPath).size > 44;
			if (written) {
				const info: ChunkInfo = { path: chunkPath, index };
				this.chunks.push(info);
				this.chunkReady.emit(info);
			}
			if (!this.recording) return;
			if (code !== 0 && !written && !this.rotated.has(proc)) {
				this.fail(new AudioCaptureError(`FFmpeg encerrou (código ${code}): ${stderr.trim()}`));
				return;
			}
			this.startChunk().catch((err) => this.fail(err));
		});

		await this.announceDevices(opts.devices);
	}

	/** Resolves the names actually open (best effort) and emits a device change. */
	private async announceDevices(devices: CaptureDevices): Promise<void> {
		const [systemName, micName] = await Promise.all([
			this.resolveDeviceName("system", devices.system),
			this.resolveDeviceName("mic", devices.mic),
		]);
		if (!this.active || this.options?.devices !== devices) return; // stopped/switched meanwhile
		this.active = { ...this.active, systemName, micName };
		this.deviceChanges.emit({ ...this.active });
	}

	/** `@default` → the current default sink monitor / source name (falls back to the id). */
	private async resolveDeviceName(
		source: CaptureSource,
		device: string | null,
	): Promise<string | null> {
		if (device === null || device !== SYSTEM_DEFAULT_DEVICE) return device;
		try {
			const args = [source === "system" ? "get-default-sink" : "get-default-source"];
			const result = await this.run("pactl", args, RESOLVE_TIMEOUT_MS);
			const name = result.code === 0 ? result.stdout.trim() : "";
			if (name) return source === "system" ? `${name}.monitor` : name;
		} catch {
			// pactl missing (pure PipeWire without pulse utils): keep the alias
		}
		return device;
	}

	/** Finalizes the current chunk; the close handler starts the next one. */
	private async rotateChunk(): Promise<void> {
		const proc = this.proc;
		if (!proc) return;
		this.rotated.add(proc);
		proc.kill("SIGINT");
		await waitForExit(proc, 5000);
		await this.chunkStarted;
	}

	async stopCapture(): Promise<ChunkInfo[]> {
		const proc = this.proc;
		this.reset();
		if (proc) {
			proc.kill("SIGINT");
			await waitForExit(proc, 5000);
		}
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
		if (this.muted[source] === muted) return;
		this.muted = { ...this.muted, [source]: muted };
		if (this.recording) await this.rotateChunk();
	}

	getInputMuteState(): Record<CaptureSource, boolean> {
		return { ...this.muted };
	}

	async switchDevices(devices: Partial<CaptureDevices>): Promise<ResolvedDevices> {
		if (!this.recording || !this.options || !this.active) {
			throw new AudioCaptureError("Nenhuma captura em andamento para trocar o dispositivo.");
		}
		const next: CaptureDevices = {
			system: devices.system ?? this.options.devices.system,
			mic: devices.mic !== undefined ? devices.mic : this.options.devices.mic,
		};
		this.options = { ...this.options, devices: next };
		this.active = { ...this.active, ...next };
		await this.rotateChunk();
		return { ...(this.active ?? { ...next, systemName: null, micName: null }) };
	}

	getActiveDevices(): ResolvedDevices | null {
		return this.active ? { ...this.active } : null;
	}

	async startMeter(_devices: CaptureDevices): Promise<LevelMeter> {
		throw new AudioCaptureError("Medidor de nível não suportado neste sistema.");
	}

	async playTestTone(device: string): Promise<void> {
		const sink =
			device === SYSTEM_DEFAULT_DEVICE ? "@DEFAULT_SINK@" : device.replace(/\.monitor$/, "");
		const file = path.join(os.tmpdir(), "listening-resume-tone.wav");
		if (!fs.existsSync(file)) fs.writeFileSync(file, toneWav());
		let result: Awaited<ReturnType<typeof run>>;
		try {
			result = await this.run("pw-play", [`--target=${sink}`, file], 10_000);
		} catch {
			result = await this.run("paplay", [`--device=${sink}`, file], 10_000).catch((err: Error) => {
				throw new AudioCaptureError(`Falha ao tocar o som de teste: ${err.message}`);
			});
		}
		if (result.code !== 0) {
			logger.warn(`test tone: ${result.stderr.trim()}`);
			throw new AudioCaptureError("Falha ao tocar o som de teste.");
		}
	}
}

function toneWav(): Buffer {
	const sampleRate = 44100;
	const samples = new Float32Array(Math.floor(sampleRate * 0.8));
	for (let i = 0; i < samples.length; i++) {
		const t = i / sampleRate;
		const fade = Math.min(1, t / 0.02, (0.8 - t) / 0.02);
		samples[i] = Math.sin(2 * Math.PI * 880 * t) * 0.5 * fade;
	}
	return createWav(floatToPcm16(samples), { sampleRate, channels: 1 });
}
