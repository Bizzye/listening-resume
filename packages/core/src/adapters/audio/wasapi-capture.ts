import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
import { logger } from "../../utils/logger.js";
import { run, tail, waitForExit, writeLine } from "../../utils/process.js";
import {
	buildCaptureArgs,
	buildMeterArgs,
	buildToneArgs,
	type CaptureEvent,
	type DeviceChange,
	LineSplitter,
	muteCommand,
	parseCaptureLine,
	switchCommand,
} from "./capture-protocol.js";

export const WASAPI_BINARY_NAME = "wasapi-capture.exe";
export const WASAPI_BINARY_ENV = "LR_WASAPI_BIN";

export interface BinaryLookupContext {
	env: NodeJS.ProcessEnv;
	/** Path of the running node executable (bundled at `resources/bin/node.exe` when packaged). */
	execPath: string;
	cwd: string;
	/** Directory of this module (core `dist/`, or the esbuild server bundle). */
	moduleDir: string | null;
}

/** Where the binary may live, most specific first. Pure. */
export function wasapiBinaryCandidates(ctx: BinaryLookupContext): string[] {
	const candidates: string[] = [];
	const override = ctx.env[WASAPI_BINARY_ENV]?.trim();
	if (override) candidates.push(path.resolve(override));

	// Packaged (Tauri NSIS): <app>/resources/bin/node.exe → <app>/binaries/wasapi-capture.exe
	const nodeDir = path.dirname(ctx.execPath);
	candidates.push(
		path.join(nodeDir, "..", "..", "binaries", WASAPI_BINARY_NAME),
		path.join(nodeDir, "..", "binaries", WASAPI_BINARY_NAME),
		path.join(nodeDir, "binaries", WASAPI_BINARY_NAME),
		path.join(nodeDir, WASAPI_BINARY_NAME),
	);

	// Dev: walk up from cwd (repo root, apps/gui, apps/cli, packages/core) and from this module.
	for (const base of [ctx.cwd, ctx.moduleDir]) {
		if (!base) continue;
		let dir = path.resolve(base);
		for (let depth = 0; depth < 6; depth++) {
			candidates.push(
				path.join(dir, "src-tauri", "binaries", WASAPI_BINARY_NAME),
				path.join(dir, "apps", "gui", "src-tauri", "binaries", WASAPI_BINARY_NAME),
			);
			const parent = path.dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}

	for (const dir of (ctx.env.PATH ?? ctx.env.Path ?? "").split(path.delimiter)) {
		if (dir.trim()) candidates.push(path.join(dir.trim(), WASAPI_BINARY_NAME));
	}
	return [...new Set(candidates.map((c) => path.normalize(c)))];
}

function currentModuleDir(): string | null {
	try {
		return path.dirname(fileURLToPath(import.meta.url));
	} catch {
		return null;
	}
}

export function findWasapiBinary(
	ctx: BinaryLookupContext = {
		env: process.env,
		execPath: process.execPath,
		cwd: process.cwd(),
		moduleDir: currentModuleDir(),
	},
	exists: (p: string) => boolean = existsSync,
): string | null {
	return wasapiBinaryCandidates(ctx).find((c) => exists(c)) ?? null;
}

const MISSING_BINARY_MESSAGE =
	"Binário de captura nativo (wasapi-capture.exe) não encontrado. " +
	"Compile com `pnpm --filter @listening-resume/gui build:wasapi` " +
	`ou aponte a variável ${WASAPI_BINARY_ENV} para o executável.`;

export interface WasapiCaptureAdapterOptions {
	/** Explicit executable; default: `findBinary()`. */
	binaryPath?: string;
	/** Binary lookup (default `findWasapiBinary`); injectable for tests. */
	findBinary?: () => string | null;
	/** Arguments placed before the protocol args (lets tests run a script through node). */
	argsPrefix?: string[];
	/** How long `stopCapture` waits for the binary to finalize the chunk before killing it. */
	stopTimeoutMs?: number;
	/** How long `startCapture` waits for the first `DEVICE:` line before assuming success. */
	startTimeoutMs?: number;
	/**
	 * Spawn the capture process in its own process group (default: on Windows). The binary then
	 * never receives the console's Ctrl+C — the owner stops it with `q` and finalizes the chunk —
	 * while stdin EOF still stops it if the owner dies.
	 */
	detached?: boolean;
}

/**
 * Whether a `DEVICE:` event reflects the requested switch: an explicit device must show up
 * by name, `null` (mic removed) as no name, `@default` as any name. Pure.
 */
export function deviceEventMatches(
	requested: Partial<CaptureDevices>,
	event: Pick<ResolvedDevices, "systemName" | "micName">,
): boolean {
	const matches = (target: string | null | undefined, name: string | null) => {
		if (target === undefined) return true;
		if (target === null) return name === null;
		if (target === SYSTEM_DEFAULT_DEVICE) return name !== null;
		return name !== null && name.toLowerCase() === target.toLowerCase();
	};
	return matches(requested.system, event.systemName) && matches(requested.mic, event.micName);
}

/** A `DEVICE:` event as the adapter sees it: the resolved devices plus which source changed. */
export interface DeviceEvent {
	devices: Pick<ResolvedDevices, "systemName" | "micName">;
	/** `null` = unknown (legacy binary): the event may concern any source. */
	changed: DeviceChange | null;
}

/**
 * The requested sources a `DEVICE:` event acknowledges after a live switch. An event only
 * counts for a source it is about (`changed`), so a line produced by the OTHER source (e.g. the
 * mic re-opening on a new default) can't satisfy a pending system switch before the system
 * source has actually reopened. After a `WARN:` (device missing → fell back) the source's next
 * event counts whatever name it reports. Pure.
 */
export function acknowledgedSources(
	requested: Partial<CaptureDevices>,
	event: DeviceEvent,
	warned: boolean,
): CaptureSource[] {
	const acked: CaptureSource[] = [];
	const only: Record<CaptureSource, Partial<CaptureDevices>> = {
		system: { system: requested.system },
		mic: { mic: requested.mic },
	};
	for (const source of ["system", "mic"] as const) {
		if (requested[source] === undefined) continue;
		const about = event.changed === null || event.changed === "both" || event.changed === source;
		if (!about) continue;
		if (warned || deviceEventMatches(only[source], event.devices)) acked.push(source);
	}
	return acked;
}

/**
 * Windows capture through the bundled native binary: WASAPI loopback of an output device
 * (no "Stereo Mix" needed) mixed with an optional microphone, live mute / device switching
 * over stdin and levels/device events over stdout.
 */
export class WasapiCaptureAdapter implements AudioCapturePort {
	readonly backend = "wasapi" as const;
	readonly capabilities: CaptureCapabilities = {
		levels: true,
		liveSwitch: true,
		mute: true,
		meter: true,
		testTone: true,
	};

	private binaryPath: string | null;
	private readonly findBinary: () => string | null;
	private readonly argsPrefix: string[];
	private readonly stopTimeoutMs: number;
	private readonly startTimeoutMs: number;
	private readonly detached: boolean;

	private proc: ChildProcess | null = null;
	private stopping = false;
	private chunks: ChunkInfo[] = [];
	private readonly chunkReady = new Listeners<ChunkInfo>();
	private muted: Record<CaptureSource, boolean> = { system: false, mic: false };
	private active: ResolvedDevices | null = null;

	private readonly levels = new Listeners<AudioLevels>();
	private readonly deviceChanges = new Listeners<ResolvedDevices>();
	/** Same events with the `changed` tag (switch acknowledgement). */
	private readonly deviceEvents = new Listeners<DeviceEvent>();
	private readonly errors = new Listeners<Error>();
	private readonly warnings = new Listeners<string>();

	constructor(options: WasapiCaptureAdapterOptions = {}) {
		this.binaryPath = options.binaryPath ?? null;
		this.findBinary = options.findBinary ?? (() => findWasapiBinary());
		this.argsPrefix = options.argsPrefix ?? [];
		this.stopTimeoutMs = options.stopTimeoutMs ?? 5000;
		this.startTimeoutMs = options.startTimeoutMs ?? 3000;
		this.detached = options.detached ?? process.platform === "win32";
	}

	/** Resolved lazily (and re-checked until found) so a binary built after boot is picked up. */
	private requireBinary(): string {
		if (!this.binaryPath) this.binaryPath = this.findBinary();
		if (!this.binaryPath) throw new AudioCaptureError(MISSING_BINARY_MESSAGE);
		return this.binaryPath;
	}

	/** Long-running capture/meter process (stdin commands, stdout events). */
	private spawnBinary(args: string[]): ChildProcess {
		const proc = spawn(this.requireBinary(), [...this.argsPrefix, ...args], {
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			detached: this.detached,
		});
		proc.stderr?.setEncoding("utf8");
		return proc;
	}

	async isAvailable(): Promise<boolean> {
		try {
			this.requireBinary();
			return true;
		} catch {
			return false;
		}
	}

	async listDevices(): Promise<AudioDevice[]> {
		const binary = this.requireBinary();
		let result: Awaited<ReturnType<typeof run>>;
		try {
			result = await run(binary, [...this.argsPrefix, "--list-devices"], 10_000);
		} catch (err) {
			throw new AudioCaptureError(`Falha ao executar wasapi-capture: ${(err as Error).message}`);
		}
		for (const line of result.stdout.split("\n")) {
			const event = parseCaptureLine(line);
			if (event?.type === "devices") return event.devices;
		}
		throw new AudioCaptureError(
			`Não foi possível listar os dispositivos de áudio. ${tail(result.stderr)}`.trim(),
		);
	}

	async startCapture(options: CaptureOptions): Promise<void> {
		if (this.proc) throw new AudioCaptureError("Uma captura já está em andamento.");
		const proc = this.spawnBinary(buildCaptureArgs(options));
		this.proc = proc;
		this.stopping = false;
		this.chunks = [];
		this.muted = { system: false, mic: false };
		this.active = { ...options.devices, systemName: null, micName: null };

		let stderr = "";
		let started = false;
		let failed = false;
		const splitter = new LineSplitter();
		proc.stdout?.on("data", (data: Buffer) => {
			for (const line of splitter.push(data)) this.handleEvent(parseCaptureLine(line));
		});
		proc.stderr?.on("data", (text: string) => {
			stderr = (stderr + text).slice(-4000);
			for (const line of text.split(/\r?\n/)) {
				if (line.trim()) logger.debug(`[wasapi-capture] ${line.trim()}`);
			}
		});

		/** Fatal failure after start, reported once (an `error` may be followed by `close`). */
		const fail = (message: string) => {
			if (failed || this.stopping) return;
			failed = true;
			this.errors.emit(new AudioCaptureError(message));
		};

		const ready = new Promise<void>((resolve, reject) => {
			const settle = (err?: Error) => {
				clearTimeout(timer);
				unsubscribe();
				proc.off("error", onSpawnError);
				proc.off("close", onEarlyClose);
				if (err) reject(err);
				else resolve();
			};
			const timer = setTimeout(() => settle(), this.startTimeoutMs);
			const unsubscribe = this.deviceChanges.on(() => settle());
			const onSpawnError = (err: Error) =>
				settle(new AudioCaptureError(`Falha ao iniciar wasapi-capture: ${err.message}`));
			const onEarlyClose = (code: number | null) =>
				settle(
					new AudioCaptureError(
						`wasapi-capture encerrou ao iniciar (código ${code}). ${tail(stderr)}`.trim(),
					),
				);
			proc.once("error", onSpawnError);
			proc.once("close", onEarlyClose);
		});

		proc.on("close", (code) => {
			for (const line of splitter.flush()) this.handleEvent(parseCaptureLine(line));
			if (this.proc === proc) {
				this.proc = null;
				this.active = null;
			}
			// Before `started`, the failure rejects `startCapture` instead.
			if (started) {
				fail(`A captura de áudio parou inesperadamente (código ${code}). ${tail(stderr)}`.trim());
			}
		});
		proc.on("error", (err) => {
			if (started) fail(err.message);
		});

		try {
			await ready;
			started = true;
		} catch (err) {
			if (this.proc === proc) {
				this.proc = null;
				this.active = null;
			}
			throw err;
		}
	}

	private handleEvent(event: CaptureEvent | null): void {
		if (!event) return;
		switch (event.type) {
			case "chunk": {
				const info: ChunkInfo = { path: event.path, index: this.chunks.length };
				this.chunks.push(info);
				this.chunkReady.emit(info);
				break;
			}
			case "level":
				this.levels.emit({ system: event.system, mic: event.mic });
				break;
			case "device":
				if (!this.active) break;
				this.active = { ...this.active, systemName: event.systemName, micName: event.micName };
				this.deviceEvents.emit({ devices: { ...this.active }, changed: event.changed });
				this.deviceChanges.emit({ ...this.active });
				break;
			case "warn":
				logger.warn(`[wasapi-capture] ${event.message}`);
				this.warnings.emit(event.message);
				break;
			case "devices":
				break;
		}
	}

	async stopCapture(): Promise<ChunkInfo[]> {
		const proc = this.proc;
		if (proc) {
			this.stopping = true;
			if (!writeLine(proc, "q")) proc.kill();
			await waitForExit(proc, this.stopTimeoutMs);
			this.proc = null;
		}
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
		writeLine(this.proc, muteCommand(source, muted));
	}

	getInputMuteState(): Record<CaptureSource, boolean> {
		return { ...this.muted };
	}

	async switchDevices(devices: Partial<CaptureDevices>): Promise<ResolvedDevices> {
		if (!this.proc || !this.active) {
			throw new AudioCaptureError("Nenhuma captura em andamento para trocar o dispositivo.");
		}
		const commands: string[] = [];
		const requested: Partial<CaptureDevices> = {};
		if (devices.system !== undefined && devices.system !== this.active.system) {
			commands.push(switchCommand("system", devices.system));
			requested.system = devices.system;
		}
		if (devices.mic !== undefined && devices.mic !== this.active.mic) {
			commands.push(switchCommand("mic", devices.mic));
			requested.mic = devices.mic;
		}
		if (commands.length === 0) return { ...this.active };

		const next: CaptureDevices = {
			system: requested.system ?? this.active.system,
			mic: requested.mic !== undefined ? requested.mic : this.active.mic,
		};
		this.active = { ...this.active, ...next };
		const reopened = this.waitForSwitch(requested, this.startTimeoutMs);
		for (const cmd of commands) writeLine(this.proc, cmd);
		await reopened;
		return { ...(this.active ?? { ...next, systemName: null, micName: null }) };
	}

	/**
	 * Resolves once every requested source has been acknowledged by a `DEVICE:` event about
	 * that source (see `acknowledgedSources`; the binary reports one line per reopened source).
	 * Times out silently so a quiet binary never blocks the caller for long.
	 */
	private waitForSwitch(requested: Partial<CaptureDevices>, timeoutMs: number): Promise<void> {
		return new Promise((resolve) => {
			const pending = new Set<CaptureSource>();
			if (requested.system !== undefined) pending.add("system");
			if (requested.mic !== undefined) pending.add("mic");
			let warned = false;
			const done = () => {
				clearTimeout(timer);
				offDevice();
				offWarn();
				resolve();
			};
			const timer = setTimeout(done, timeoutMs);
			const offWarn = this.warnings.on(() => {
				warned = true;
			});
			const offDevice = this.deviceEvents.on((event) => {
				const still: Partial<CaptureDevices> = {};
				if (pending.has("system")) still.system = requested.system;
				if (pending.has("mic")) still.mic = requested.mic;
				for (const source of acknowledgedSources(still, event, warned)) pending.delete(source);
				if (pending.size === 0) done();
			});
		});
	}

	getActiveDevices(): ResolvedDevices | null {
		return this.active ? { ...this.active } : null;
	}

	async startMeter(devices: CaptureDevices): Promise<LevelMeter> {
		const proc = this.spawnBinary(buildMeterArgs(devices));
		const levels = new Listeners<AudioLevels>();
		const deviceChanges = new Listeners<ResolvedDevices>();
		const splitter = new LineSplitter();
		let stopped = false;

		proc.stdout?.on("data", (data: Buffer) => {
			for (const line of splitter.push(data)) {
				const event = parseCaptureLine(line);
				if (event?.type === "level") levels.emit({ system: event.system, mic: event.mic });
				else if (event?.type === "device") {
					deviceChanges.emit({ ...devices, systemName: event.systemName, micName: event.micName });
				} else if (event?.type === "warn") logger.warn(`[wasapi-meter] ${event.message}`);
			}
		});
		proc.stderr?.resume();
		proc.on("error", (err) => logger.warn(`[wasapi-meter] ${err.message}`));

		return {
			onLevels: (cb) => levels.on(cb),
			onDeviceChange: (cb) => deviceChanges.on(cb),
			stop: async () => {
				if (stopped) return;
				stopped = true;
				if (!writeLine(proc, "q")) proc.kill();
				await waitForExit(proc, 2000);
				levels.clear();
				deviceChanges.clear();
			},
		};
	}

	async playTestTone(device: string): Promise<void> {
		const binary = this.requireBinary();
		let result: Awaited<ReturnType<typeof run>>;
		try {
			result = await run(binary, [...this.argsPrefix, ...buildToneArgs(device)], 10_000);
		} catch (err) {
			throw new AudioCaptureError(`Falha ao tocar o som de teste: ${(err as Error).message}`);
		}
		if (result.code !== 0) {
			throw new AudioCaptureError(
				`Falha ao tocar o som de teste (código ${result.code}). ${tail(result.stderr)}`.trim(),
			);
		}
	}
}
