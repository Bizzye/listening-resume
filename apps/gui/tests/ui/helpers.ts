import { expect, vi } from "vitest";
import { API_BASE } from "../../src/shared/api/client";
import type {
	Analysis,
	AudioDevice,
	Health,
	SessionDetail,
	SessionSummary,
	Settings,
	Template,
} from "../../src/shared/api/types";

// ---------------------------------------------------------------------------- fetch mock

export interface Call {
	method: string;
	path: string;
	body: unknown;
	headers: Record<string, string>;
}

type Reply = object | string | number | boolean | null | undefined;
type Handler = (call: Call) => Reply | Promise<Reply>;
export type Route = [method: string, path: string | RegExp, reply: Handler | Reply];

export interface FetchMock {
	calls: Call[];
	/** Calls matching method + exact path (query included) or regex. */
	to: (method: string, path: string | RegExp) => Call[];
	fn: ReturnType<typeof vi.fn>;
}

const isStatusReply = (r: unknown): r is { status: number; body?: unknown } =>
	!!r &&
	typeof r === "object" &&
	"status" in r &&
	typeof (r as { status: unknown }).status === "number";

/** Stubs global fetch with a small router over API paths (relative to API_BASE). */
export function mockFetch(routes: Route[] = []): FetchMock {
	const calls: Call[] = [];
	const matches = (p: string | RegExp, path: string) =>
		typeof p === "string" ? p === path : p.test(path);
	const fn = vi.fn(async (input: string, init: RequestInit = {}) => {
		const path = String(input).replace(API_BASE, "");
		const method = init.method ?? "GET";
		let body: unknown = init.body;
		if (typeof body === "string") {
			try {
				body = JSON.parse(body);
			} catch {
				// raw string
			}
		}
		const call: Call = {
			method,
			path,
			body,
			headers: (init.headers as Record<string, string>) ?? {},
		};
		calls.push(call);
		const route = routes.find(([m, p]) => m === method && matches(p, path));
		if (!route)
			return new Response(JSON.stringify({ error: `no route ${method} ${path}` }), { status: 404 });
		const raw = route[2];
		const reply = typeof raw === "function" ? await (raw as Handler)(call) : raw;
		const status = isStatusReply(reply) ? reply.status : 200;
		const payload = isStatusReply(reply) ? reply.body : reply;
		return new Response(payload === undefined ? "" : JSON.stringify(payload), { status });
	});
	vi.stubGlobal("fetch", fn);
	return {
		calls,
		fn,
		to: (method, path) => calls.filter((c) => c.method === method && matches(path, c.path)),
	};
}

// ---------------------------------------------------------------------------- fixtures

export function makeSettings(over: Partial<Settings> = {}): Settings {
	return {
		onboardingDone: true,
		theme: "dark",
		systemDevice: "@default",
		micDevice: "@default",
		transcriptionProvider: "groq",
		whisperModel: "medium",
		autoTranscribe: true,
		silenceDetection: true,
		analysisModel: "llama3.1:8b",
		analysisLanguage: "pt-BR",
		defaultTemplateId: "resumo-executivo",
		exportDir: "C:\\Users\\me\\Documents\\ListeningResume",
		exportFormat: "md",
		...over,
	};
}

export const DEVICES: AudioDevice[] = [
	{
		id: "Alto-falantes (Realtek) (Loopback)",
		name: "Alto-falantes (Realtek) (Loopback)",
		isMonitor: true,
		isDefault: true,
		type: "monitor",
	},
	{
		id: "Fone Bluetooth (Loopback)",
		name: "Fone Bluetooth (Loopback)",
		isMonitor: true,
		isDefault: false,
		type: "monitor",
	},
	{
		id: "Microfone USB",
		name: "Microfone USB",
		isMonitor: false,
		isDefault: true,
		type: "microphone",
	},
	{
		id: "Microfone interno",
		name: "Microfone interno",
		isMonitor: false,
		isDefault: false,
		type: "microphone",
	},
];

let seq = 0;
export function makeSession(over: Partial<SessionSummary> = {}): SessionSummary {
	seq += 1;
	return {
		id: `sess-${seq}`,
		title: `Sessão ${seq}`,
		status: "transcribed",
		startedAt: "2026-10-11T09:14:00",
		endedAt: "2026-10-11T10:00:00",
		audioSource: "Áudio do sistema",
		language: "pt",
		createdAt: "2026-10-11T09:14:00",
		exportDir: null,
		lastError: null,
		chunks: 2,
		duration: 125,
		preview: "…um trecho da transcrição…",
		analysesCount: 0,
		...over,
	};
}

export function makeAnalysis(over: Partial<Analysis> = {}): Analysis {
	return {
		id: "an-1",
		sessionId: "sess-1",
		templateId: "resumo-executivo",
		provider: "ollama",
		model: "llama3.1:8b",
		content: "## Resumo Executivo\n\nUm parágrafo de contexto.\n\n- Ponto um\n- Ponto dois",
		createdAt: "2026-10-11T10:05:00",
		...over,
	};
}

export function makeDetail(
	session: SessionSummary,
	over: Partial<SessionDetail> = {},
): SessionDetail {
	return {
		session,
		transcript: {
			segments: [
				{ start: 0, end: 10, text: "Bom dia, pessoal, hoje falamos de entropia." },
				{ start: 10, end: 25, text: "A segunda lei diz que a entropia nunca diminui." },
				{ start: 25, end: 40, text: "Pra semana que vem, leiam o capítulo 20." },
			],
			fullText: "…",
			language: "pt",
			provider: "groq",
			model: "whisper-large-v3-turbo",
		},
		analyses: [],
		...over,
	};
}

export const TEMPLATES: Template[] = [
	{
		id: "resumo-executivo",
		name: "Resumo Executivo",
		description: "Um parágrafo + 5 pontos.",
		prompt: "Resuma {transcricao}",
		builtin: true,
		sections: 2,
		language: "pt-BR",
	},
	{
		id: "flashcards-anki",
		name: "Flashcards (Anki)",
		description: "Pares pergunta/resposta.",
		prompt: "pergunta;resposta",
		builtin: true,
		sections: 1,
		language: "pt-BR",
	},
	{
		id: "custom-1",
		name: "Revisão de Entrevista",
		description: "Por competência.",
		prompt: "Avalie {transcricao}",
		builtin: false,
		sections: 4,
		language: "pt-BR",
	},
];

export function makeHealth(over: Partial<Health["services"]> = {}): Health {
	return {
		services: {
			ollama: { ok: true, model: "llama3.1:8b", url: "http://localhost:11434" },
			groq: { configured: true },
			ffmpeg: { ok: true, version: "7.0.1" },
			whisper: { ok: true, model: "medium" },
			capture: { backend: "wasapi", ok: true },
			...over,
		},
	};
}

// ---------------------------------------------------------------------------- EventSource fake

export class FakeEventSource {
	static instances: FakeEventSource[] = [];
	static reset() {
		FakeEventSource.instances = [];
	}
	readyState = 0;
	onopen: ((e: Event) => void) | null = null;
	onmessage: ((e: MessageEvent) => void) | null = null;
	onerror: ((e: Event) => void) | null = null;
	closed = false;
	private listeners = new Map<string, ((e: MessageEvent) => void)[]>();
	constructor(readonly url: string) {
		FakeEventSource.instances.push(this);
	}
	addEventListener(type: string, cb: (e: MessageEvent) => void) {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
	}
	close() {
		this.closed = true;
		this.readyState = 2;
	}
	open() {
		this.readyState = 1;
		this.onopen?.(new Event("open"));
	}
	emit(data: unknown) {
		this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(data) }));
	}
	emitEvent(type: string, data: unknown) {
		for (const cb of this.listeners.get(type) ?? [])
			cb(new MessageEvent(type, { data: JSON.stringify(data) }));
	}
	fail(closed: boolean) {
		this.readyState = closed ? 2 : 0;
		this.onerror?.(new Event("error"));
	}
	static get last(): FakeEventSource {
		const es = FakeEventSource.instances.at(-1);
		if (!es) throw new Error("no EventSource created");
		return es;
	}
}

/** Passive effects may run after the DOM commit — wait for the stream to actually open. */
export async function waitForEventSource(): Promise<FakeEventSource> {
	await vi.waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
	return FakeEventSource.last;
}

export function installFakeEventSource() {
	FakeEventSource.reset();
	vi.stubGlobal("EventSource", FakeEventSource);
}

/** Manual requestAnimationFrame: call `step(t)` to run queued frames at time t. */
export function installManualRaf() {
	let queue: FrameRequestCallback[] = [];
	vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
		queue.push(cb);
		return queue.length;
	});
	vi.stubGlobal("cancelAnimationFrame", () => {
		queue = [];
	});
	return {
		step(t: number) {
			const q = queue;
			queue = [];
			for (const cb of q) cb(t);
		},
	};
}
