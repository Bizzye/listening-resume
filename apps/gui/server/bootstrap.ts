import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	type AnalyzerPort,
	createCaptureAdapter,
	createTranscriber,
	defaultCaptureBackend,
	FakeAnalyzer,
	FakeTranscriber,
	GroqLLMAdapter,
	LocalFileStorage,
	loadConfig,
	logger,
	OllamaAdapter,
	ProcessRegistry,
	type ProcessRunner,
	RecordingService,
	readWavInfo,
	resolveConfigDir,
	resolveDataDir,
	run,
	SettingsStore,
	SQLiteRepository,
	type WhisperModel,
	whisperModelPath,
} from "@listening-resume/core";
import { type App, createApp } from "./app.js";
import type { AppDeps } from "./deps.js";
import { EnvFileGroqKeyStore, parseEnv } from "./services/groq-key.js";
import { createHealthCheckers, type HealthCheckers } from "./services/health.js";

export const DEFAULT_PORT = 3456;

/** Path of this module: `server/bootstrap.ts` from source, `server-bundle.mjs` when packaged. */
function modulePath(): string | null {
	try {
		return fileURLToPath(import.meta.url);
	} catch {
		return null;
	}
}

/** Directory of this module — works for `tsx server.ts` and for the esbuild bundle. */
function moduleDir(): string {
	const p = modulePath();
	return p ? path.dirname(p) : process.cwd();
}

/**
 * The pnpm workspace root when running from a source checkout (dev), else null. The packaged
 * app runs the esbuild bundle (`server-bundle.mjs`) and never counts as dev — not even in the
 * smoke test, which runs the bundle from inside the repo.
 */
export function findDevWorkspaceRoot(
	from: string | null = modulePath(),
	maxDepth = 6,
): string | null {
	if (!from || /server-bundle\.m?js$/i.test(from)) return null;
	let dir = path.dirname(from);
	for (let i = 0; i < maxDepth; i++) {
		if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/**
 * Prepend the dir holding the bundled `ffmpeg.exe` to PATH. Packaged: next to the bundled
 * node (`resources/bin`); dev: `apps/gui/src-tauri/resources/bin` (download-deps-win.ps1).
 */
export function addBundledBinToPath(): void {
	if (process.platform !== "win32") return;
	const here = moduleDir();
	const candidates = [
		path.join(path.dirname(process.execPath), "..", "bin"),
		path.dirname(process.execPath),
		path.join(here, "bin"), // bundle lives in resources/, binaries in resources/bin
		path.join(here, "..", "src-tauri", "resources", "bin"), // dev: apps/gui/server/
		path.join(here, "src-tauri", "resources", "bin"),
	];
	for (const dir of candidates) {
		if (fs.existsSync(path.join(dir, "ffmpeg.exe"))) {
			process.env.PATH = `${dir}${path.delimiter}${process.env.PATH ?? ""}`;
			return;
		}
	}
}

/** Load `KEY=value` pairs from an env file into process.env without overriding. */
export function loadEnvFile(file: string): void {
	if (!fs.existsSync(file)) return;
	for (const [k, v] of Object.entries(parseEnv(fs.readFileSync(file, "utf-8")))) {
		if (process.env[k] === undefined) process.env[k] = v;
	}
}

export interface BootOptions {
	/** Use fake capture/transcriber/analyzer + deterministic health (hermetic e2e). */
	fake: boolean;
	dataDir?: string;
	configDir?: string;
}

export function bootOptionsFromEnv(env = process.env): BootOptions {
	return {
		fake: env.LR_FAKE_CAPTURE === "1" || env.LR_FAKE_CAPTURE === "true",
		dataDir: env.LR_DATA_DIR || undefined,
		configDir: env.LR_CONFIG_DIR || undefined,
	};
}

const fakeHealth: HealthCheckers = {
	async ollama() {
		return { ok: true, url: "http://127.0.0.1:11434", models: ["llama3.1:8b", "qwen2.5:7b"] };
	},
	async ffmpeg() {
		return { ok: true, version: "fake" };
	},
	async whisper() {
		return { ok: false };
	},
};

/** Wire the real (or hermetic fake) dependencies. */
export function buildDeps(opts: BootOptions): {
	deps: AppDeps;
	recording: RecordingService;
	dataDir: string;
	/** Children started through `deps.run` (killed on shutdown). */
	processes: ProcessRegistry;
} {
	const configDir = path.resolve(opts.configDir ?? resolveConfigDir());
	const workspace = opts.fake ? null : findDevWorkspaceRoot();
	if (workspace) {
		// Dev convenience only: the workspace-root .env. Never loaded by the packaged app.
		loadEnvFile(path.join(workspace, ".env"));
	}
	const config = loadConfig(configDir);
	const dataDir = path.resolve(opts.dataDir ?? resolveDataDir(config));
	fs.mkdirSync(dataDir, { recursive: true });

	const repo = new SQLiteRepository(path.join(dataDir, "listening-resume.db"));
	const storage = new LocalFileStorage(dataDir);
	const settings = new SettingsStore(path.join(configDir, "settings.json"));
	if (opts.fake && !fs.existsSync(path.join(configDir, "settings.json"))) {
		// Keep hermetic runs from writing exports into the user's Documents folder.
		settings.update({ exportDir: path.join(dataDir, "exports") });
	}
	const groqKey = new EnvFileGroqKeyStore(
		path.join(configDir, ".env"),
		opts.fake ? "" : (process.env.GROQ_API_KEY ?? ""),
	);

	const capture = createCaptureAdapter(
		opts.fake ? "fake" : config.audio.backend === "fake" ? "fake" : defaultCaptureBackend(),
	);
	capture.onError((err) => logger.error(`[capture] ${err.message}`));

	const audio = {
		sampleRate: config.audio.sampleRate,
		channels: config.audio.channels,
		chunkSeconds: config.audio.chunkSeconds,
	};
	const recording = new RecordingService({
		capture,
		repo,
		storage,
		audio: { ...audio, micVolume: config.audio.micVolume },
	});

	// Every child the API runs (ffmpeg imports, health probes) is tracked for shutdown.
	const processes = new ProcessRegistry();
	const runTracked: ProcessRunner = (cmd, args, options = {}) =>
		run(cmd, args, {
			...(typeof options === "number" ? { timeoutMs: options } : options),
			registry: processes,
		});

	const t = config.transcription;
	const whisperModelsDir = t.whisperModelsDir ?? path.join(dataDir, "models");
	const ollamaUrl = config.analysis.ollamaHost;
	// Fake jobs take a moment so the UI (and e2e) can observe the working states.
	const fakeDelayMs = Number(process.env.LR_FAKE_DELAY_MS ?? 600);

	const deps: AppDeps = {
		repo,
		storage,
		recording,
		capture,
		settings,
		groqKey,
		transcription: {
			create(s) {
				if (opts.fake) return new FakeTranscriber({ delayMs: fakeDelayMs });
				return createTranscriber(s.transcriptionProvider, {
					groqApiKey: groqKey.get(),
					groqModel: t.model,
					whisperBinary: t.whisperBinary,
					whisperModelsDir,
					whisperModel: s.whisperModel,
				});
			},
		},
		analysis: {
			create(s) {
				if (opts.fake)
					return { primary: new FakeAnalyzer({ delayMs: fakeDelayMs }), fallback: null };
				const primary: AnalyzerPort = new OllamaAdapter(s.analysisModel, ollamaUrl);
				const key = groqKey.get();
				const fallback = key ? new GroqLLMAdapter(key, config.analysis.fallback?.model) : null;
				return { primary, fallback };
			},
		},
		health: opts.fake
			? fakeHealth
			: createHealthCheckers({
					fetch,
					run: runTracked,
					ollamaUrl,
					whisperBin: t.whisperBinary,
					whisperModelPath: (m) => whisperModelPath(whisperModelsDir, m as WhisperModel),
				}),
		fetch,
		run: runTracked,
		importTimeoutMs: Number(process.env.LR_IMPORT_TIMEOUT_MS) || undefined,
		audio,
		rateLimits: {
			requestsPerMinute: config.rateLimits.groqRpm,
			audioSecondsPerHour: config.rateLimits.groqAudioSecondsPerHour,
		},
		transcriptionLanguage: t.language,
		transcriptionPrompt: t.prompt || undefined,
		tmpDir: path.join(dataDir, "tmp"),
		readWavInfo,
		logger,
	};
	return { deps, recording, dataDir, processes };
}

export interface RunningServer {
	app: App;
	port: number;
	/**
	 * Graceful stop: finalize an in-flight recording (last chunk + session settled), kill child
	 * processes (ffmpeg imports, level meters), give background jobs a moment, close listeners.
	 */
	close(): Promise<void>;
}

function listen(server: http.Server, port: number, host: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			server.off("error", reject);
			resolve();
		});
	});
}

/** `p`, or `undefined` once `ms` elapse. */
function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		p,
		new Promise<undefined>((r) => {
			timer = setTimeout(() => r(undefined), ms);
		}),
	]).finally(() => clearTimeout(timer));
}

/** Shutdown budget — the Tauri shell waits 4 s after closing our stdin before killing us. */
const STOP_RECORDING_BUDGET_MS = 2500;
const JOBS_BUDGET_MS = 500;
const HARD_EXIT_MS = 3800;

/**
 * Boot the API: wiring, crash reconcile, listen on `LR_PORT` (default 3456).
 * Binds loopback only (127.0.0.1 + ::1 so `localhost` works whichever family resolves first);
 * `LR_HOST` overrides with a single explicit address.
 */
export async function startServer(
	opts: BootOptions = bootOptionsFromEnv(),
	port = Number(process.env.LR_PORT || process.env.PORT || DEFAULT_PORT),
	host = process.env.LR_HOST || "127.0.0.1",
): Promise<RunningServer> {
	addBundledBinToPath();
	const { deps, recording, dataDir, processes } = buildDeps(opts);
	try {
		const fixed = await recording.reconcileInterrupted();
		if (fixed.length)
			logger.info(`[boot-reconcile] settled ${fixed.length} interrupted session(s)`);
	} catch (err) {
		logger.error(`[boot-reconcile] ${(err as Error).message}`);
	}
	const app = createApp(deps);
	await listen(app.server, port, host);
	const actualPort = (app.server.address() as AddressInfo).port;

	let v6: http.Server | null = null;
	if (!process.env.LR_HOST) {
		const mirror = http.createServer((req, res) => app.server.emit("request", req, res));
		try {
			await listen(mirror, actualPort, "::1");
			v6 = mirror;
		} catch {
			// IPv6 loopback unavailable — IPv4 is enough.
		}
	}

	logger.info(
		`API server on http://localhost:${actualPort} (capture: ${deps.capture.backend}${opts.fake ? ", FAKE" : ""}, data: ${dataDir})`,
	);

	const servers = [app.server, v6].filter((s): s is http.Server => s !== null);
	const doClose = async () => {
		// Stop accepting new connections (in-flight ones are cut below).
		for (const s of servers) s.close();
		// Finalize an in-flight recording so its last chunk isn't lost and the session settles.
		const active = deps.recording.getActive();
		if (active) {
			const stopped = await within(
				deps.recording.stop().then(
					() => true,
					(err: Error) => {
						logger.error(`[shutdown] stopping the recording failed: ${err.message}`);
						return false;
					},
				),
				STOP_RECORDING_BUDGET_MS,
			);
			if (stopped) logger.info(`[shutdown] recording ${active.sessionId} finalized`);
			else logger.warn(`[shutdown] recording ${active.sessionId} was not finalized`);
		}
		const killed = processes.killAll();
		if (killed) logger.info(`[shutdown] killed ${killed} child process(es)`);
		await within(app.context.meters.stopAll(), 1000);
		// Running transcriptions/analyses are cut; boot-reconcile settles them on the next start.
		await app.context.jobs.idle(JOBS_BUDGET_MS);
		for (const s of servers) {
			s.closeAllConnections?.();
			await within(new Promise<void>((r) => s.close(() => r())), 500);
		}
	};
	let closing: Promise<void> | null = null;
	return {
		app,
		port: actualPort,
		close() {
			closing ??= doClose();
			return closing;
		},
	};
}

/**
 * Exit gracefully (code 0) on SIGTERM/SIGINT and — when `LR_SHUTDOWN_ON_STDIN_EOF=1`, set by
 * the Tauri shell, which cannot signal a child on Windows — when stdin reaches EOF/closes.
 */
export function installShutdownHandlers(
	running: RunningServer,
	env: NodeJS.ProcessEnv = process.env,
): void {
	let started = false;
	const shutdown = (reason: string) => {
		if (started) return;
		started = true;
		logger.info(`[shutdown] ${reason}`);
		// Never hang (keeping the port bound) if something refuses to settle.
		setTimeout(() => process.exit(0), HARD_EXIT_MS).unref();
		void running
			.close()
			.catch((err: Error) => logger.error(`[shutdown] ${err.message}`))
			.finally(() => process.exit(0));
	};
	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("SIGINT", () => shutdown("SIGINT"));
	if (env.LR_SHUTDOWN_ON_STDIN_EOF === "1" || env.LR_SHUTDOWN_ON_STDIN_EOF === "true") {
		const stdin = process.stdin;
		stdin.on("end", () => shutdown("stdin closed"));
		stdin.on("close", () => shutdown("stdin closed"));
		stdin.on("error", () => shutdown("stdin error"));
		stdin.on("data", () => {}); // input is ignored; only EOF matters
		stdin.resume();
	}
}
