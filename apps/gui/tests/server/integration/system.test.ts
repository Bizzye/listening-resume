import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestApp, type TestApp } from "./harness.js";

const KEY = "gsk_abcdefghijklmnopqrstuvwxyz123456";

describe("system endpoints", () => {
	let t: TestApp;
	beforeAll(async () => {
		t = await startTestApp({
			fetch: async (url, init) => {
				const auth = new Headers(init?.headers).get("authorization");
				expect(url).toContain("api.groq.com");
				return new Response("{}", { status: auth === `Bearer ${KEY}` ? 200 : 401 });
			},
		});
	});
	afterAll(() => t.close());

	it("GET /health reports every service", async () => {
		const { status, body } = await t.json("/health");
		expect(status).toBe(200);
		expect(body).toEqual({
			services: {
				ollama: { ok: true, model: "llama3.1:8b", url: "http://127.0.0.1:11434" },
				groq: { configured: false },
				ffmpeg: { ok: true, version: "7.1-test" },
				whisper: { ok: false, model: "medium" },
				capture: {
					backend: "fake",
					ok: true,
					levels: true,
					liveSwitch: true,
					meter: true,
					sampleRate: 16000,
				},
			},
		});
	});

	it("GET /analysis/models lists Ollama models", async () => {
		expect((await t.json("/analysis/models")).body).toEqual({
			models: ["llama3.1:8b", "qwen2.5:7b"],
		});
	});

	it("GET/PATCH /settings validates and persists", async () => {
		const initial = (await t.json("/settings")).body;
		expect(initial).toMatchObject({
			theme: "dark",
			systemDevice: "@default",
			autoTranscribe: false,
		});

		const patched = await t.json("/settings", {
			method: "PATCH",
			json: { theme: "light", micDevice: null, onboardingDone: true },
		});
		expect(patched.status).toBe(200);
		expect(patched.body).toMatchObject({ theme: "light", micDevice: null, onboardingDone: true });
		expect(t.settings.get().theme).toBe("light");

		const bad = await t.json("/settings", { method: "PATCH", json: { theme: "blue" } });
		expect(bad.status).toBe(400);
		expect(bad.body.error).toMatch(/theme/);
		const unknown = await t.json("/settings", { method: "PATCH", json: { nope: 1 } });
		expect(unknown.status).toBe(400);
		const notJson = await t.api("/settings", {
			method: "PATCH",
			body: "{oops",
			headers: { "Content-Type": "application/json" },
		});
		expect(notJson.status).toBe(400);
	});

	it("manages the Groq key", async () => {
		expect((await t.json("/config/groq-key")).body).toEqual({ configured: false, masked: null });
		expect(
			(await t.json("/config/groq-key", { method: "POST", json: { key: "bad" } })).status,
		).toBe(400);

		const saved = await t.json("/config/groq-key", { method: "POST", json: { key: ` ${KEY} ` } });
		expect(saved.body).toEqual({ ok: true, masked: "gsk_********...3456" });
		expect((await t.json("/config/groq-key")).body).toEqual({
			configured: true,
			masked: "gsk_********...3456",
		});
		expect((await t.json("/health")).body.services.groq.configured).toBe(true);

		expect((await t.json("/config/groq-key/validate", { method: "POST" })).body).toEqual({
			valid: true,
		});
		const other = await t.json("/config/groq-key/validate", {
			method: "POST",
			json: { key: "gsk_zzzzzzzzzzzzzzzzzzzzzzzzzzzz" },
		});
		expect(other.body.valid).toBe(false);

		expect((await t.json("/config/groq-key", { method: "DELETE" })).body).toEqual({ ok: true });
		expect((await t.json("/config/groq-key")).body.configured).toBe(false);
	});

	it("enforces the origin guard and answers CORS preflight", async () => {
		const evil = await t.api("/settings", { headers: { Origin: "https://evil.example" } });
		expect(evil.status).toBe(403);
		for (const origin of ["http://localhost:1420", "http://tauri.localhost", "tauri://localhost"]) {
			const ok = await t.api("/settings", { headers: { Origin: origin } });
			expect(ok.status).toBe(200);
			expect(ok.headers.get("access-control-allow-origin")).toBe(origin);
		}
		const pre = await t.api("/recording/start", {
			method: "OPTIONS",
			headers: { Origin: "http://localhost:1420", "Access-Control-Request-Method": "POST" },
		});
		expect(pre.status).toBe(204);
		expect(pre.headers.get("access-control-allow-methods")).toContain("PATCH");
	});

	it("returns JSON 404/405 for unknown routes", async () => {
		const missing = await t.json("/nope");
		expect(missing).toEqual({ status: 404, body: { error: "Não encontrado" } });
		expect((await t.json("/settings", { method: "DELETE" })).status).toBe(405);
		expect((await fetch(t.base.replace(/\/api$/, "/"))).status).toBe(404);
	});
});
