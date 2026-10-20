import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import {
	createWav,
	FakeAnalyzer,
	FakeCaptureAdapter,
	FakeTranscriber,
	LocalFileStorage,
	type ProcessRunner,
	RecordingService,
	readWavInfo,
	SettingsStore,
	SQLiteRepository,
	setLogLevel,
} from "@listening-resume/core";
import { type App, createApp } from "../../../server/app.js";
import type { AppDeps } from "../../../server/deps.js";
import type { GroqKeyStore } from "../../../server/services/groq-key.js";
import type { HealthCheckers } from "../../../server/services/health.js";

setLogLevel("error");

/** In-memory Groq key store. */
export class MemoryGroqKeyStore implements GroqKeyStore {
	constructor(private key = "") {}
	get() {
		return this.key;
	}
	set(key: string) {
		this.key = key;
	}
	clear() {
		this.key = "";
	}
}

/** Parsed JSON bodies in assertions. */
// biome-ignore lint/suspicious/noExplicitAny: loosely-typed test payloads
export type Json = any;

export const AUDIO = { sampleRate: 16000, channels: 1, chunkSeconds: 5 };

/** Fake ffmpeg: writes `seconds` of tone split into chunk files per the segment pattern. */
export function fakeFfmpeg(seconds = 7, fail = false): ProcessRunner & { calls: string[][] } {
	const calls: string[][] = [];
	const runner = (async (_cmd: string, args: string[]) => {
		calls.push(args);
		if (fail) return { code: 1, stdout: "", stderr: "Invalid data found when processing input" };
		const pattern = args.at(-1) as string;
		const sr = Number(args[args.indexOf("-ar") + 1]);
		const chunk = Number(args[args.indexOf("-segment_time") + 1]);
		let left = seconds;
		for (let i = 0; left > 0; i++) {
			const len = Math.min(chunk, left);
			const samples = new Int16Array(Math.round(len * sr));
			for (let j = 0; j < samples.length; j++) {
				samples[j] = Math.round(Math.sin((2 * Math.PI * 440 * j) / sr) * 8000);
			}
			const file = pattern.replace("%04d", String(i).padStart(4, "0"));
			fs.writeFileSync(file, createWav(samples, { sampleRate: sr, channels: 1 }));
			left -= len;
		}
		return { code: 0, stdout: "", stderr: "" };
	}) as ProcessRunner & { calls: string[][] };
	runner.calls = calls;
	return runner;
}

const silentLogger = { info() {}, warn() {}, error() {} };

export const fakeHealth: HealthCheckers = {
	async ollama() {
		return { ok: true, url: "http://127.0.0.1:11434", models: ["llama3.1:8b", "qwen2.5:7b"] };
	},
	async ffmpeg() {
		return { ok: true, version: "7.1-test" };
	},
	async whisper() {
		return { ok: false };
	},
};

export interface TestApp {
	app: App;
	base: string;
	dir: string;
	capture: FakeCaptureAdapter;
	transcriber: FakeTranscriber;
	analyzer: FakeAnalyzer;
	repo: SQLiteRepository;
	settings: SettingsStore;
	deps: AppDeps;
	api(p: string, init?: RequestInit & { json?: unknown }): Promise<Response>;
	json<T = Json>(
		p: string,
		init?: RequestInit & { json?: unknown },
	): Promise<{ status: number; body: T }>;
	waitForStatus(id: string, statuses: string[], timeoutMs?: number): Promise<Json>;
	close(): Promise<void>;
}

export async function startTestApp(overrides: Partial<AppDeps> = {}): Promise<TestApp> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lr-server-it-"));
	const repo = new SQLiteRepository(":memory:");
	const storage = new LocalFileStorage(path.join(dir, "data"));
	const capture = new FakeCaptureAdapter({ levelIntervalMs: 20 });
	const recording = new RecordingService({ capture, repo, storage, audio: AUDIO });
	const settings = new SettingsStore(path.join(dir, "config", "settings.json"));
	settings.update({ exportDir: path.join(dir, "exports"), autoTranscribe: false });
	const transcriber = new FakeTranscriber({ delayMs: 30 });
	const analyzer = new FakeAnalyzer({ delayMs: 30 });

	const deps: AppDeps = {
		repo,
		storage,
		recording,
		capture,
		settings,
		groqKey: new MemoryGroqKeyStore(),
		transcription: { create: () => transcriber },
		rateLimits: { requestsPerMinute: 1000, audioSecondsPerHour: 1_000_000 },
		analysis: { create: () => ({ primary: analyzer, fallback: null }) },
		health: fakeHealth,
		fetch: async () => new Response("{}", { status: 200 }),
		run: fakeFfmpeg(),
		audio: AUDIO,
		tmpDir: path.join(dir, "tmp"),
		readWavInfo,
		logger: silentLogger,
		sseHeartbeatMs: 100,
		...overrides,
	};
	const app = createApp(deps);
	await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api`;

	const api: TestApp["api"] = (p, init = {}) => {
		const { json, ...rest } = init;
		const headers = new Headers(rest.headers);
		if (json !== undefined) headers.set("Content-Type", "application/json");
		return fetch(`${base}${p}`, {
			...rest,
			headers,
			body: json !== undefined ? JSON.stringify(json) : rest.body,
		});
	};

	const t: TestApp = {
		app,
		base,
		dir,
		capture,
		transcriber,
		analyzer,
		repo,
		settings,
		deps,
		api,
		async json(p, init) {
			const res = await api(p, init);
			const text = await res.text();
			return { status: res.status, body: text ? JSON.parse(text) : null };
		},
		async waitForStatus(id, statuses, timeoutMs = 5000) {
			const until = Date.now() + timeoutMs;
			let last: Json = null;
			while (Date.now() < until) {
				last = (await t.json(`/sessions/${id}`)).body;
				if (statuses.includes(last?.session?.status)) return last;
				await new Promise((r) => setTimeout(r, 25));
			}
			throw new Error(`timeout waiting for ${statuses}; last=${JSON.stringify(last?.session)}`);
		},
		async close() {
			if (recording.getActive()) await recording.stop().catch(() => {});
			app.server.closeAllConnections();
			await new Promise<void>((r) => app.server.close(() => r()));
			await app.context.jobs.idle();
			repo.close();
			fs.rmSync(dir, { recursive: true, force: true });
		},
	};
	return t;
}

/** Read SSE frames from a streaming response until `count` events (or timeout). */
export async function readSse(
	res: Response,
	count: number,
	timeoutMs = 3000,
): Promise<Array<{ event: string; data: Json }>> {
	const reader = (res.body as ReadableStream<Uint8Array>).getReader();
	const decoder = new TextDecoder();
	const events: Array<{ event: string; data: Json }> = [];
	let buf = "";
	const deadline = Date.now() + timeoutMs;
	try {
		while (events.length < count && Date.now() < deadline) {
			const { value, done } = await Promise.race([
				reader.read(),
				new Promise<{ value: undefined; done: true }>((r) =>
					setTimeout(() => r({ value: undefined, done: true }), Math.max(0, deadline - Date.now())),
				),
			]);
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			let idx = buf.indexOf("\n\n");
			while (idx >= 0) {
				const frame = buf.slice(0, idx);
				buf = buf.slice(idx + 2);
				let event = "message";
				const data: string[] = [];
				for (const line of frame.split("\n")) {
					if (line.startsWith("event: ")) event = line.slice(7);
					else if (line.startsWith("data: ")) data.push(line.slice(6));
				}
				if (data.length) events.push({ event, data: JSON.parse(data.join("\n")) });
				idx = buf.indexOf("\n\n");
			}
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	return events;
}

/**
 * Read SSE frames until `until(event)` matches, the server ends the stream, or the timeout.
 * `closed` is true when the server ended the stream.
 */
export async function collectSse(
	res: Response,
	opts: { until?: (e: { event: string; data: Json }) => boolean; timeoutMs?: number } = {},
): Promise<{ events: Array<{ event: string; data: Json }>; closed: boolean; text: string }> {
	const reader = (res.body as ReadableStream<Uint8Array>).getReader();
	const decoder = new TextDecoder();
	const events: Array<{ event: string; data: Json }> = [];
	let buf = "";
	let text = "";
	let closed = false;
	const deadline = Date.now() + (opts.timeoutMs ?? 3000);
	try {
		outer: while (Date.now() < deadline) {
			const r = await Promise.race([
				reader.read(),
				new Promise<null>((ok) => setTimeout(() => ok(null), Math.max(0, deadline - Date.now()))),
			]);
			if (r === null) break;
			if (r.done) {
				closed = true;
				break;
			}
			const chunk = decoder.decode(r.value, { stream: true });
			text += chunk;
			buf += chunk;
			let idx = buf.indexOf("\n\n");
			while (idx >= 0) {
				const frame = buf.slice(0, idx);
				buf = buf.slice(idx + 2);
				let event = "message";
				const data: string[] = [];
				for (const line of frame.split("\n")) {
					if (line.startsWith("event: ")) event = line.slice(7);
					else if (line.startsWith("data: ")) data.push(line.slice(6));
				}
				if (data.length) {
					const e = { event, data: JSON.parse(data.join("\n")) };
					events.push(e);
					if (opts.until?.(e)) break outer;
				}
				idx = buf.indexOf("\n\n");
			}
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	return { events, closed, text };
}

/** Raw HTTP request (lets tests set `Host` and omit fetch's default headers). */
export function rawRequest(
	base: string,
	p: string,
	opts: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {},
): Promise<{ status: number; body: Json; headers: http.IncomingHttpHeaders }> {
	const url = new URL(`${base}${p}`);
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				host: url.hostname,
				port: url.port,
				path: url.pathname + url.search,
				method: opts.method ?? "GET",
				headers: opts.headers,
			},
			(res) => {
				const parts: Buffer[] = [];
				res.on("data", (d: Buffer) => parts.push(d));
				res.on("end", () => {
					const text = Buffer.concat(parts).toString("utf-8");
					let body: Json = text;
					try {
						body = text ? JSON.parse(text) : null;
					} catch {
						// non-JSON body
					}
					resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
				});
			},
		);
		req.on("error", reject);
		if (opts.body !== undefined && opts.body.length > 0) req.write(opts.body);
		req.end();
	});
}

/** A live SSE connection over plain `http` (one socket per stream, closed with `close()`). */
export interface SseClient {
	events: Array<{ event: string; data: Json }>;
	readonly closedByServer: boolean;
	waitFor(pred: (e: { event: string; data: Json }) => boolean, timeoutMs?: number): Promise<void>;
	close(): void;
}

export function openSseClient(base: string, p: string): Promise<SseClient> {
	const url = new URL(`${base}${p}`);
	return new Promise((resolve, reject) => {
		const req = http.get(
			{ host: url.hostname, port: url.port, path: url.pathname + url.search, agent: false },
			(res) => {
				if (res.statusCode !== 200) {
					reject(new Error(`SSE HTTP ${res.statusCode}`));
					res.resume();
					return;
				}
				let buf = "";
				let closedByServer = false;
				const events: SseClient["events"] = [];
				const waiters = new Set<() => void>();
				res.setEncoding("utf-8");
				res.on("data", (chunk: string) => {
					buf += chunk;
					let idx = buf.indexOf("\n\n");
					while (idx >= 0) {
						const frame = buf.slice(0, idx);
						buf = buf.slice(idx + 2);
						let event = "message";
						const data: string[] = [];
						for (const line of frame.split("\n")) {
							if (line.startsWith("event: ")) event = line.slice(7);
							else if (line.startsWith("data: ")) data.push(line.slice(6));
						}
						if (data.length) events.push({ event, data: JSON.parse(data.join("\n")) });
						idx = buf.indexOf("\n\n");
					}
					for (const w of waiters) w();
				});
				res.on("end", () => {
					closedByServer = true;
					for (const w of waiters) w();
				});
				res.on("error", () => {});
				resolve({
					events,
					get closedByServer() {
						return closedByServer;
					},
					waitFor(pred, timeoutMs = 2000) {
						return new Promise<void>((ok, fail) => {
							const check = () => {
								if (events.some(pred)) {
									waiters.delete(check);
									clearTimeout(timer);
									ok();
								}
							};
							const timer = setTimeout(() => {
								waiters.delete(check);
								fail(new Error(`SSE timeout; got ${JSON.stringify(events.slice(-3))}`));
							}, timeoutMs);
							waiters.add(check);
							check();
						});
					},
					close() {
						req.destroy();
					},
				});
			},
		);
		req.on("error", reject);
	});
}
