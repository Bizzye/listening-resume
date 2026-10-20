import { afterEach, describe, expect, it, vi } from "vitest";
import {
	API_BASE,
	ApiError,
	api,
	filenameHeader,
	levelsUrl,
	resolveApiBase,
	sessionAudioUrl,
} from "../../src/shared/api/client";
import {
	openLevelsStream,
	parseLevels,
	parseUnavailable,
	parseWarning,
} from "../../src/shared/api/sse";
import { FakeEventSource, makeSettings, mockFetch } from "./helpers";

describe("base URL", () => {
	it("uses the Vite proxy on port 1420, the local server elsewhere", () => {
		expect(resolveApiBase({ port: "1420" })).toBe("/api");
		expect(resolveApiBase({ port: "" })).toBe("http://localhost:3456/api");
		expect(resolveApiBase({ port: "5199" })).toBe("http://localhost:3456/api");
		expect(resolveApiBase({ port: "1420" }, "http://localhost:47123/api/")).toBe(
			"http://localhost:47123/api",
		);
		expect(API_BASE).toBe("http://localhost:3456/api");
	});
	it("builds media/levels URLs", () => {
		expect(sessionAudioUrl("a b")).toBe(`${API_BASE}/sessions/a%20b/audio`);
		expect(levelsUrl({ system: "@default", mic: null })).toBe(
			`${API_BASE}/audio/levels?system=%40default&mic=none`,
		);
		expect(levelsUrl({})).toBe(`${API_BASE}/audio/levels`);
	});
	it("percent-encodes only non-ASCII file names", () => {
		expect(filenameHeader("aula.mp4")).toBe("aula.mp4");
		expect(filenameHeader("cálculo.mp4")).toBe("c%C3%A1lculo.mp4");
	});
});

describe("api client", () => {
	it("sends JSON with the right method and path", async () => {
		const f = mockFetch([
			["PATCH", "/settings", (c) => makeSettings(c.body as object)],
			["POST", "/recording/mute", (c) => c.body],
			[
				"POST",
				"/recording/devices",
				{ devices: { system: "@default", mic: null, systemName: "X", micName: null } },
			],
			["POST", "/sessions/s1/analyze", { status: 202, body: { status: "analyzing" } }],
			["GET", "/sessions?limit=50&q=entropia", { sessions: [] }],
			["DELETE", "/templates/custom-1", { ok: true }],
		]);
		expect((await api.patchSettings({ theme: "light" })).theme).toBe("light");
		expect(await api.setMute("mic", true)).toEqual({ target: "mic", muted: true });
		await api.switchDevices({ micDevice: null });
		expect(await api.analyze("s1", "ata-reuniao")).toEqual({ status: "analyzing" });
		await api.listSessions({ q: "entropia" });
		await api.deleteTemplate("custom-1");
		expect(f.to("PATCH", "/settings")[0].headers["Content-Type"]).toBe("application/json");
		expect(f.to("POST", "/recording/devices")[0].body).toEqual({ micDevice: null });
		expect(f.to("POST", "/sessions/s1/analyze")[0].body).toEqual({ templateId: "ata-reuniao" });
		expect(f.calls).toHaveLength(6);
	});

	it("posts the raw file on import with X-Filename", async () => {
		const f = mockFetch([
			["POST", "/sessions/import", { status: 201, body: { session: { id: "n1" } } }],
		]);
		const file = new File(["abc"], "aula.mp4", { type: "video/mp4" });
		await api.importSession(file);
		const call = f.to("POST", "/sessions/import")[0];
		expect(call.headers["X-Filename"]).toBe("aula.mp4");
		expect(call.headers["Content-Type"]).toBe("video/mp4");
		expect(call.body).toBe(file);
	});

	it("throws ApiError with the server message and status", async () => {
		mockFetch([
			["POST", "/recording/start", { status: 409, body: { error: "Já existe uma gravação" } }],
		]);
		const err = await api.startRecording().catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect(err).toMatchObject({ status: 409, message: "Já existe uma gravação" });
	});

	it("maps network failures to status 0", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
		await expect(api.health()).rejects.toMatchObject({
			status: 0,
			message: "Serviço local indisponível",
		});
	});

	it("falls back to a generic message for non-JSON errors", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("boom", { status: 500 })));
		await expect(api.getSettings()).rejects.toMatchObject({
			status: 500,
			message: "Falha na requisição (500)",
		});
	});
});

describe("levels SSE stream", () => {
	afterEach(() => FakeEventSource.reset());

	it("parses and clamps level payloads", () => {
		expect(parseLevels('{"system":0.5,"mic":2}')).toEqual({ system: 0.5, mic: 1 });
		expect(parseLevels('{"system":"x"}')).toEqual({ system: 0, mic: 0 });
		expect(parseLevels("nope")).toBeNull();
	});

	it("delivers levels and device events, reports status, closes on dispose", () => {
		const onLevels = vi.fn();
		const onDevices = vi.fn();
		const onStatus = vi.fn();
		const close = openLevelsStream(
			{ system: "@default", mic: "Microfone USB" },
			{ onLevels, onDevices, onStatus },
			{ EventSourceImpl: FakeEventSource as unknown as typeof EventSource },
		);
		const es = FakeEventSource.last;
		expect(es.url).toBe(`${API_BASE}/audio/levels?system=%40default&mic=Microfone+USB`);
		es.open();
		es.emit({ system: 0.2, mic: 0.1 });
		es.emitEvent("devices", { system: "@default", mic: null, systemName: "Fone", micName: null });
		expect(onStatus).toHaveBeenCalledWith(true);
		expect(onLevels).toHaveBeenCalledWith({ system: 0.2, mic: 0.1 });
		expect(onDevices).toHaveBeenCalledWith(expect.objectContaining({ systemName: "Fone" }));
		close();
		expect(es.closed).toBe(true);
	});

	it("reconnects with backoff only when the stream is CLOSED", () => {
		vi.useFakeTimers();
		const close = openLevelsStream(
			{},
			{ onLevels: vi.fn() },
			{
				EventSourceImpl: FakeEventSource as unknown as typeof EventSource,
				minRetryMs: 100,
				maxRetryMs: 300,
			},
		);
		FakeEventSource.last.fail(false); // CONNECTING: browser retries by itself
		vi.advanceTimersByTime(1000);
		expect(FakeEventSource.instances).toHaveLength(1);
		FakeEventSource.last.fail(true);
		vi.advanceTimersByTime(99);
		expect(FakeEventSource.instances).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(FakeEventSource.instances).toHaveLength(2);
		FakeEventSource.last.fail(true);
		vi.advanceTimersByTime(200);
		expect(FakeEventSource.instances).toHaveLength(3);
		close();
		FakeEventSource.last.fail(true);
		vi.advanceTimersByTime(1000);
		expect(FakeEventSource.instances).toHaveLength(3);
	});

	it("parses `event: warning` payloads (message required, fallback defaults to false)", () => {
		expect(parseWarning('{"message":"Dispositivo indisponível","fallback":true}')).toEqual({
			message: "Dispositivo indisponível",
			fallback: true,
		});
		expect(parseWarning('{"message":"aviso"}')).toEqual({ message: "aviso", fallback: false });
		expect(parseWarning('{"message":"aviso","fallback":"yes"}')).toEqual({
			message: "aviso",
			fallback: false,
		});
		expect(parseWarning('{"message":"  "}')).toBeNull();
		expect(parseWarning('{"fallback":true}')).toBeNull();
		expect(parseWarning("null")).toBeNull();
		expect(parseWarning("not json")).toBeNull();
	});

	it("delivers `event: warning` to onWarning and drops malformed ones", () => {
		const onWarning = vi.fn();
		openLevelsStream(
			{},
			{ onLevels: vi.fn(), onWarning },
			{ EventSourceImpl: FakeEventSource as unknown as typeof EventSource },
		);
		const es = FakeEventSource.last;
		es.open();
		es.emitEvent("warning", { message: "Dispositivo indisponível", fallback: true });
		es.emitEvent("warning", { nope: 1 });
		expect(onWarning).toHaveBeenCalledTimes(1);
		expect(onWarning).toHaveBeenCalledWith({ message: "Dispositivo indisponível", fallback: true });
		// Without a handler a warning is simply ignored.
		openLevelsStream(
			{},
			{ onLevels: vi.fn() },
			{ EventSourceImpl: FakeEventSource as unknown as typeof EventSource },
		);
		expect(() => FakeEventSource.last.emitEvent("warning", { message: "x" })).not.toThrow();
	});

	it("reports `event: unavailable` (JSON or text)", () => {
		expect(parseUnavailable('{"error":"sem dispositivo"}')).toBe("sem dispositivo");
		expect(parseUnavailable('{"message":"x"}')).toBe("x");
		expect(parseUnavailable("texto puro")).toBe("texto puro");
		expect(parseUnavailable("")).toBe("Captura indisponível");
		expect(parseUnavailable('{"reason":"levels-unsupported"}')).toBe(
			"Medidor de nível indisponível neste sistema",
		);
		expect(parseUnavailable('{"reason":"meter-stopped","error":"dispositivo removido"}')).toBe(
			"dispositivo removido",
		);
		expect(parseUnavailable('{"reason":"meter-stopped"}')).toBe("O medidor de áudio parou");
		const onUnavailable = vi.fn();
		openLevelsStream(
			{},
			{ onLevels: vi.fn(), onUnavailable },
			{ EventSourceImpl: FakeEventSource as unknown as typeof EventSource },
		);
		FakeEventSource.last.emitEvent("unavailable", { error: "falhou" });
		expect(onUnavailable).toHaveBeenCalledWith("falhou");
	});

	it("`event: ended` reports the end and never reconnects", () => {
		vi.useFakeTimers();
		const onEnded = vi.fn();
		const onStatus = vi.fn();
		openLevelsStream(
			{},
			{ onLevels: vi.fn(), onEnded, onStatus },
			{ EventSourceImpl: FakeEventSource as unknown as typeof EventSource, minRetryMs: 10 },
		);
		const es = FakeEventSource.last;
		es.open();
		es.emitEvent("ended", { sessionId: "s1" });
		expect(onEnded).toHaveBeenCalledWith({ sessionId: "s1" });
		expect(onStatus).toHaveBeenLastCalledWith(false);
		expect(es.closed).toBe(true);
		es.fail(true); // server closes the socket afterwards
		vi.advanceTimersByTime(1000);
		expect(FakeEventSource.instances).toHaveLength(1);
	});

	it("every JSON request carries Content-Type: application/json; bodiless ones carry none", async () => {
		const f = mockFetch([
			["PATCH", "/settings", {}],
			["PUT", "/templates/t", { template: {} }],
			["POST", "/recording/devices", { devices: {} }],
			["POST", "/recording/stop", { session: {}, chunks: 0 }],
			["DELETE", "/config/groq-key", { ok: true }],
		]);
		await api.patchSettings({ theme: "light" });
		await api.updateTemplate("t", { name: "n", description: "", prompt: "p" });
		await api.switchDevices({ micDevice: null });
		await api.stopRecording();
		await api.deleteGroqKey();
		const ct = f.calls.map((c) => c.headers["Content-Type"]);
		expect(ct).toEqual([
			"application/json",
			"application/json",
			"application/json",
			undefined,
			undefined,
		]);
	});

	it("`ended` with { recording: true } (meter superseded) reconnects instead", () => {
		vi.useFakeTimers();
		const onEnded = vi.fn();
		openLevelsStream(
			{},
			{ onLevels: vi.fn(), onEnded },
			{ EventSourceImpl: FakeEventSource as unknown as typeof EventSource },
		);
		const first = FakeEventSource.last;
		first.open();
		first.emitEvent("ended", { recording: true });
		expect(first.closed).toBe(true);
		vi.advanceTimersByTime(0);
		expect(FakeEventSource.instances).toHaveLength(2);
		expect(onEnded).not.toHaveBeenCalled();
	});

	it("validateGroqKey sends the key only when given", async () => {
		const f = mockFetch([["POST", "/config/groq-key/validate", { valid: true }]]);
		await api.validateGroqKey("gsk_x");
		await api.validateGroqKey();
		expect(f.calls.map((c) => c.body)).toEqual([{ key: "gsk_x" }, {}]);
	});

	it("is a no-op without EventSource support", () => {
		const close = openLevelsStream({}, { onLevels: vi.fn() }, {});
		expect(() => close()).not.toThrow();
	});
});
