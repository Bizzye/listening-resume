import {
	type APIRequestContext,
	test as base,
	expect,
	type Locator,
	type Page,
} from "@playwright/test";

export const API_URL = "http://localhost:3456/api";

/** Settings every test starts from (onboarding done unless a test asks otherwise). */
export const BASE_SETTINGS = {
	onboardingDone: true,
	theme: "dark",
	systemDevice: "@default",
	micDevice: "@default",
	transcriptionProvider: "groq",
	whisperModel: "medium",
	analysisLanguage: "pt-BR",
	autoTranscribe: true,
	silenceDetection: true,
	defaultTemplateId: "resumo-executivo",
	exportFormat: "md",
} as const;

export interface SessionSummary {
	id: string;
	title: string | null;
	status: string;
	duration: number;
	chunks: number;
	exportDir: string | null;
	analysesCount: number;
}

/** Thin typed client over the real HTTP API (no Origin header → allowed by the guard). */
export class Api {
	constructor(private readonly req: APIRequestContext) {}

	private async call<T>(method: string, path: string, data?: unknown): Promise<T> {
		const res = await this.req.fetch(`${API_URL}${path}`, {
			method,
			data: data === undefined ? undefined : data,
			headers: data === undefined ? undefined : { "content-type": "application/json" },
		});
		const text = await res.text();
		if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()}: ${text}`);
		return (text ? JSON.parse(text) : {}) as T;
	}

	get = <T = unknown>(path: string) => this.call<T>("GET", path);
	post = <T = unknown>(path: string, data: unknown = {}) => this.call<T>("POST", path, data);
	patch = <T = unknown>(path: string, data: unknown) => this.call<T>("PATCH", path, data);
	del = <T = unknown>(path: string) => this.call<T>("DELETE", path);

	settings() {
		return this.get<Record<string, unknown>>("/settings");
	}
	patchSettings(patch: Record<string, unknown>) {
		return this.patch<Record<string, unknown>>("/settings", patch);
	}
	async sessions(q?: string): Promise<SessionSummary[]> {
		const qs = q ? `&q=${encodeURIComponent(q)}` : "";
		return (await this.get<{ sessions: SessionSummary[] }>(`/sessions?limit=500${qs}`)).sessions;
	}
	session(id: string) {
		return this.get<{
			session: SessionSummary;
			transcript: { segments: { start: number; text: string }[] } | null;
			analyses: { id: string; templateId: string; content: string }[];
		}>(`/sessions/${id}`);
	}
	async recordingStatus() {
		return this.get<{
			recording: boolean;
			sessionId?: string;
			muted?: { system: boolean; mic: boolean };
		}>("/recording/status");
	}

	/** Waits until the session leaves the busy states (transcribing / analyzing). */
	async waitIdle(id: string, timeoutMs = 30_000): Promise<SessionSummary> {
		let s: SessionSummary | undefined;
		await expect
			.poll(
				async () => {
					s = (await this.session(id)).session;
					return s.status;
				},
				{ timeout: timeoutMs, intervals: [200, 300, 500] },
			)
			.not.toMatch(/^(transcribing|analyzing|recording)$/);
		return s as SessionSummary;
	}

	/**
	 * Imports a generated WAV of `seconds` length (8 kHz mono, quiet modulated tone) through
	 * `POST /sessions/import` (server converts it with ffmpeg), then sets its title.
	 */
	async importAudio(opts: { title: string; seconds: number }): Promise<SessionSummary> {
		const res = await this.req.fetch(`${API_URL}/sessions/import`, {
			method: "POST",
			data: makeWav(opts.seconds, 8000),
			headers: {
				"content-type": "audio/wav",
				"x-filename": encodeURIComponent(`${opts.title}.wav`),
			},
			timeout: 120_000,
		});
		if (res.status() !== 201) throw new Error(`import → ${res.status()}: ${await res.text()}`);
		const { session } = (await res.json()) as { session: SessionSummary };
		await this.patch(`/sessions/${session.id}`, { title: opts.title });
		return session;
	}

	/** Runs analyses one after the other on a transcribed session. */
	async analyze(id: string, templateIds: string[]): Promise<void> {
		for (const templateId of templateIds) {
			const before = (await this.session(id)).analyses.length;
			await this.post(`/sessions/${id}/analyze`, { templateId });
			await expect
				.poll(async () => (await this.session(id)).analyses.length, { timeout: 30_000 })
				.toBeGreaterThan(before);
			await this.waitIdle(id);
		}
	}

	/** Puts the backend in a known state: no recording, no sessions, no custom templates. */
	async reset(settings: Record<string, unknown> = {}): Promise<void> {
		const st = await this.recordingStatus();
		if (st.recording) await this.post("/recording/discard");
		for (const s of await this.sessions()) {
			if (/^(transcribing|analyzing)$/.test(s.status)) await this.waitIdle(s.id);
			await this.del(`/sessions/${s.id}`);
		}
		const { templates } = await this.get<{ templates: { id: string; builtin: boolean }[] }>(
			"/templates",
		);
		for (const t of templates) if (!t.builtin) await this.del(`/templates/${t.id}`);
		await this.patchSettings({ ...BASE_SETTINGS, ...settings });
	}

	/**
	 * Creates a session through a real (fake-capture) recording: start → wait → stop →
	 * auto-transcription → optional analyses. Returns the settled session.
	 */
	async recordSession(opts: {
		title: string;
		seconds: number;
		analyses?: string[];
		mic?: string | null;
	}): Promise<SessionSummary> {
		const body: Record<string, unknown> = { title: opts.title };
		if (opts.mic !== undefined) body.micDevice = opts.mic;
		const { session } = await this.post<{ session: { id: string } }>("/recording/start", body);
		await new Promise((r) => setTimeout(r, opts.seconds * 1000));
		await this.post("/recording/stop");
		let s = await this.waitIdle(session.id);
		for (const templateId of opts.analyses ?? []) {
			await this.post(`/sessions/${session.id}/analyze`, { templateId });
			// The job flips to "analyzing" asynchronously; wait for the analysis to land.
			const before = s.analysesCount;
			await expect
				.poll(async () => (await this.session(session.id)).analyses.length, { timeout: 30_000 })
				.toBeGreaterThan(before);
			s = await this.waitIdle(session.id);
		}
		return s;
	}
}

type Fixtures = {
	api: Api;
	/** Settings applied on top of BASE_SETTINGS before the test (e.g. onboardingDone: false). */
	initialSettings: Record<string, unknown>;
};

export const test = base.extend<Fixtures>({
	initialSettings: [{}, { option: true }],
	// Auto: every test starts from a clean backend, whether or not it uses `api` directly.
	api: [
		async ({ playwright, initialSettings }, use) => {
			const ctx = await playwright.request.newContext();
			const api = new Api(ctx);
			await api.reset(initialSettings);
			await use(api);
			// Never leave a recording running for the next test.
			const st = await api.recordingStatus().catch(() => null);
			if (st?.recording) await api.post("/recording/discard").catch(() => {});
			await ctx.dispose();
		},
		{ auto: true },
	],
});

export { expect };

/** Opens the app and waits for the shell (sidebar) to be ready. */
export async function openApp(page: Page): Promise<void> {
	await page.goto("/");
	await expect(page.getByTestId("record-button")).toBeVisible();
}

/** Current pixel heights of the bars inside a LevelBars container. */
export function barHeights(bars: Locator): Promise<number[]> {
	return bars.evaluate((el) =>
		Array.from(el.children, (c) => Number.parseFloat((c as HTMLElement).style.height) || 0),
	);
}

export const maxOf = (xs: number[]) => xs.reduce((m, x) => Math.max(m, x), 0);

/** Picks a <select> option by its visible label prefix and returns the chosen value. */
export async function selectByLabel(select: Locator, labelStartsWith: string): Promise<string> {
	const value = await select.evaluate((el, prefix) => {
		const opt = Array.from((el as HTMLSelectElement).options).find((o) =>
			o.label.startsWith(prefix),
		);
		return opt?.value ?? null;
	}, labelStartsWith);
	if (value === null) throw new Error(`No option starting with "${labelStartsWith}"`);
	await select.selectOption(value);
	return value;
}

export function optionLabels(select: Locator): Promise<string[]> {
	return select.evaluate((el) => Array.from((el as HTMLSelectElement).options, (o) => o.label));
}

/** 16-bit PCM mono WAV: a quiet 220 Hz tone with a slow amplitude envelope. */
export function makeWav(seconds: number, sampleRate: number): Buffer {
	const frames = Math.round(seconds * sampleRate);
	const buf = Buffer.alloc(44 + frames * 2);
	buf.write("RIFF", 0);
	buf.writeUInt32LE(36 + frames * 2, 4);
	buf.write("WAVEfmt ", 8);
	buf.writeUInt32LE(16, 16);
	buf.writeUInt16LE(1, 20);
	buf.writeUInt16LE(1, 22);
	buf.writeUInt32LE(sampleRate, 24);
	buf.writeUInt32LE(sampleRate * 2, 28);
	buf.writeUInt16LE(2, 32);
	buf.writeUInt16LE(16, 34);
	buf.write("data", 36);
	buf.writeUInt32LE(frames * 2, 40);
	for (let i = 0; i < frames; i++) {
		const t = i / sampleRate;
		const env = 0.5 + 0.5 * Math.sin(t * 1.3);
		buf.writeInt16LE(Math.round(3000 * env * Math.sin(2 * Math.PI * 220 * t)), 44 + i * 2);
	}
	return buf;
}
