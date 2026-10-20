import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rawRequest, startTestApp, type TestApp } from "./harness.js";

describe("request security (CSRF / DNS rebinding)", () => {
	let t: TestApp;
	let port: string;
	beforeEach(async () => {
		t = await startTestApp();
		port = new URL(t.base).port;
	});
	afterEach(() => t.close());

	const post = (p: string, headers: Record<string, string>, body = "") =>
		rawRequest(t.base, p, {
			method: "POST",
			headers: { Host: `localhost:${port}`, ...headers },
			body,
		});

	it("rejects `Origin: null` text/plain POSTs without Referer (sandboxed-iframe CSRF)", async () => {
		const res = await post(
			"/recording/start",
			{ Origin: "null", "Content-Type": "text/plain" },
			"{}",
		);
		expect(res.status).toBe(403);
		expect(t.deps.recording.getActive()).toBeNull();
	});

	it("rejects browser requests without Origin (Sec-Fetch-Site present)", async () => {
		for (const site of ["cross-site", "same-site"]) {
			const res = await post("/recording/start", {
				"Sec-Fetch-Site": site,
				"Content-Type": "application/json",
			});
			expect(res.status).toBe(403);
		}
		expect(t.deps.recording.getActive()).toBeNull();
	});

	it("rejects localhost origins on other ports", async () => {
		const res = await post("/recording/start", {
			Origin: "http://localhost:8080",
			"Content-Type": "application/json",
		});
		expect(res.status).toBe(403);
		const get = await rawRequest(t.base, "/settings", {
			headers: { Host: `localhost:${port}`, Origin: "http://127.0.0.1:5173" },
		});
		expect(get.status).toBe(403);
	});

	it("accepts the app's origins and non-browser clients", async () => {
		const ok = await post(
			"/recording/start",
			{ Origin: "http://tauri.localhost", "Content-Type": "application/json" },
			"{}",
		);
		expect(ok.status).toBe(200);
		expect(ok.headers["access-control-allow-origin"]).toBe("http://tauri.localhost");
		const stop = await post("/recording/stop", {}); // CLI/curl: no Origin, no Sec-Fetch-*
		expect(stop.status).toBe(200);
	});

	it("validates the Host header (DNS rebinding)", async () => {
		const get = (host: string) => rawRequest(t.base, "/settings", { headers: { Host: host } });
		expect((await get("evil.example")).status).toBe(403);
		expect((await get(`attacker.test:${port}`)).status).toBe(403);
		expect((await get("localhost:1")).status).toBe(403);
		expect((await get(`localhost:${port}`)).status).toBe(200);
		expect((await get(`127.0.0.1:${port}`)).status).toBe(200);
		expect((await get("localhost")).status).toBe(200);
		expect((await get("tauri.localhost")).status).toBe(200);
	});

	it("requires application/json on JSON routes (415), so cross-origin needs a preflight", async () => {
		for (const ct of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
			const res = await post(
				"/recording/start",
				{ Origin: "http://localhost:1420", "Content-Type": ct },
				"{}",
			);
			expect(res.status).toBe(415);
		}
		const untyped = await post("/recording/start", { Origin: "http://localhost:1420" }, "{}");
		expect(untyped.status).toBe(415);
		expect(t.deps.recording.getActive()).toBeNull();
		// bodyless POSTs (stop / discard / transcribe) need no Content-Type
		expect((await post("/recording/stop", { Origin: "http://localhost:1420" })).status).toBe(409);
	});

	it("import keeps a raw body but still enforces the origin rule", async () => {
		const evil = await post(
			"/sessions/import",
			{ "Sec-Fetch-Site": "cross-site", "Content-Type": "text/plain", "X-Filename": "a.mp3" },
			"x".repeat(32),
		);
		expect(evil.status).toBe(403);
		const ok = await post(
			"/sessions/import",
			{ Origin: "http://localhost:1420", "Content-Type": "audio/mpeg", "X-Filename": "a.mp3" },
			"x".repeat(32),
		);
		expect(ok.status).toBe(201);
	});

	it("allows cross-site GETs without Origin only with an allowed Referer (<audio>, downloads)", async () => {
		const get = (headers: Record<string, string>) =>
			rawRequest(t.base, "/settings", { headers: { Host: `localhost:${port}`, ...headers } });
		expect((await get({ "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
		expect(
			(await get({ "Sec-Fetch-Site": "cross-site", Referer: "https://evil.example/x" })).status,
		).toBe(403);
		expect(
			(await get({ "Sec-Fetch-Site": "cross-site", Referer: "http://tauri.localhost/s/1" })).status,
		).toBe(200);
	});

	it("honours extra origins from deps/LR_ALLOWED_ORIGINS", async () => {
		await t.close();
		t = await startTestApp({ allowedOrigins: ["http://localhost:4173"] });
		port = new URL(t.base).port;
		const res = await rawRequest(t.base, "/settings", {
			headers: { Host: `localhost:${port}`, Origin: "http://localhost:4173" },
		});
		expect(res.status).toBe(200);
	});
});

describe("input validation", () => {
	let t: TestApp;
	beforeEach(async () => {
		t = await startTestApp();
	});
	afterEach(() => t.close());

	it("rejects control characters in device ids (400)", async () => {
		const bad = "Fones\nmute-sys";
		for (const [p, json] of [
			["/recording/start", { device: bad }],
			["/recording/start", { micDevice: "Mic\r\nq" }],
			["/audio/test", { device: bad }],
		] as const) {
			const res = await t.json(p, { method: "POST", json });
			expect(res.status).toBe(400);
			expect(res.body.error).toMatch(/inválidos/);
		}
		expect(t.deps.recording.getActive()).toBeNull();
		await t.json("/recording/start", { method: "POST", json: {} });
		const sw = await t.json("/recording/devices", { method: "POST", json: { device: bad } });
		expect(sw.status).toBe(400);
		const levels = await t.api(`/audio/levels?system=${encodeURIComponent(bad)}`);
		expect(levels.status).toBe(400);
		await levels.body?.cancel();
	});

	it("rejects control characters in settings device fields", async () => {
		for (const patch of [{ systemDevice: "a\nb" }, { micDevice: "a\u0000b" }]) {
			const res = await t.json("/settings", { method: "PATCH", json: patch });
			expect(res.status).toBe(400);
		}
		expect(t.settings.get().systemDevice).toBe("@default");
	});

	it("requires absolute export dirs (global and per session)", async () => {
		const rel = await t.json("/settings", { method: "PATCH", json: { exportDir: "exports/x" } });
		expect(rel.status).toBe(400);
		expect(rel.body.error).toMatch(/absoluto/);
		const abs = path.join(t.dir, "elsewhere");
		const ok = await t.json("/settings", { method: "PATCH", json: { exportDir: ` ${abs} ` } });
		expect(ok.status).toBe(200);
		expect(ok.body.exportDir).toBe(abs);

		const { session } = (await t.json("/recording/start", { method: "POST", json: {} })).body;
		t.capture.advance(2);
		await t.json("/recording/stop", { method: "POST" });
		const relSession = await t.json(`/sessions/${session.id}`, {
			method: "PATCH",
			json: { exportDir: "relative/dir" },
		});
		expect(relSession.status).toBe(400);
	});
});
