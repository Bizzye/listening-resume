import type { CaptureDevices, LevelMeter } from "@listening-resume/core";
import { afterEach, describe, expect, it } from "vitest";
import { collectSse, type Json, openSseClient, startTestApp, type TestApp } from "./harness.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wrap the fake adapter's startMeter to count starts/stops. */
function spyMeters(t: TestApp) {
	const stats = { started: 0, stopped: 0 };
	const original = t.capture.startMeter.bind(t.capture);
	t.capture.startMeter = async (devices: CaptureDevices): Promise<LevelMeter> => {
		stats.started++;
		const m = await original(devices);
		return {
			...m,
			stop: async () => {
				stats.stopped++;
				await m.stop();
			},
		};
	};
	return stats;
}

async function waitFor(cond: () => boolean, timeoutMs = 2000) {
	const until = Date.now() + timeoutMs;
	while (!cond()) {
		if (Date.now() > until) throw new Error("timeout");
		await sleep(10);
	}
}

describe("GET /audio/levels (SSE)", () => {
	let t: TestApp;
	afterEach(() => t.close());

	it("shares one meter per device pair and stops it when the last client leaves", async () => {
		t = await startTestApp({ ssePollMs: 20 });
		const stats = spyMeters(t);
		const meters = t.app.context.meters;
		const isLevels = (e: { event: string }) => e.event === "message";
		const a = await openSseClient(t.base, "/audio/levels?system=@default&mic=none");
		const b = await openSseClient(t.base, "/audio/levels?system=@default&mic=none");
		await Promise.all([a.waitFor(isLevels), b.waitFor(isLevels)]);
		// the late joiner still gets the `devices` event (cached by the shared meter)
		await b.waitFor((e) => e.event === "devices");
		expect(stats.started).toBe(1);
		expect(meters.size).toBe(1);

		const c = await openSseClient(t.base, "/audio/levels?system=@default&mic=@default");
		await c.waitFor(isLevels);
		expect(stats.started).toBe(2); // a different pair gets its own meter
		c.close();
		await waitFor(() => meters.size === 1 && stats.stopped === 1);

		a.close();
		await sleep(80);
		expect(meters.size).toBe(1); // b is still listening
		expect(stats.stopped).toBe(1);
		b.close();
		await waitFor(() => meters.size === 0 && stats.stopped === 2);
	});

	it("reports a meter that stops emitting as `unavailable` (meter-stopped)", async () => {
		t = await startTestApp({ meterStallMs: 120 });
		let stopped = 0;
		t.capture.startMeter = async () => ({
			onLevels: () => () => {},
			onDeviceChange: () => () => {},
			stop: async () => {
				stopped++;
			},
		});
		const res = await t.api("/audio/levels?mic=none");
		const { events } = await collectSse(res, {
			until: (e) => e.event === "unavailable",
			timeoutMs: 2000,
		});
		expect(events.at(-1)).toMatchObject({
			event: "unavailable",
			data: { reason: "meter-stopped" },
		});
		expect(stopped).toBe(1);
		expect(t.app.context.meters.size).toBe(0);
	});

	it("reports a meter that cannot start as `unavailable` and keeps the stream open", async () => {
		t = await startTestApp();
		t.capture.startMeter = async () => {
			throw new Error("binary missing");
		};
		const res = await t.api("/audio/levels");
		const { events, closed } = await collectSse(res, { timeoutMs: 300 });
		expect(events).toEqual([
			{ event: "unavailable", data: { reason: "meter-failed", error: expect.any(String) } },
		]);
		expect(closed).toBe(false);
	});

	it("reports meter-unsupported backends without starting anything", async () => {
		t = await startTestApp();
		(t.capture.capabilities as { meter: boolean }).meter = false;
		const stats = spyMeters(t);
		const { events } = await collectSse(await t.api("/audio/levels"), { timeoutMs: 300 });
		expect(events).toEqual([{ event: "unavailable", data: { reason: "meter-unsupported" } }]);
		expect(stats.started).toBe(0);
	});

	it("ends a meter stream when a recording starts", async () => {
		t = await startTestApp({ ssePollMs: 20 });
		const stats = spyMeters(t);
		const res = await t.api("/audio/levels?mic=none");
		const pending = collectSse(res, { timeoutMs: 3000 });
		await waitFor(() => stats.started === 1);
		await t.json("/recording/start", { method: "POST", json: {} });
		const { events, closed, text } = await pending;
		expect(closed).toBe(true);
		expect(events.at(-1)).toMatchObject({ event: "ended" });
		expect(text).toContain("retry: ");
		await waitFor(() => stats.stopped === 1);
	});

	it("sends `ended` and closes the recording stream when the recording stops", async () => {
		t = await startTestApp({ ssePollMs: 20 });
		const { session } = (await t.json("/recording/start", { method: "POST", json: {} })).body;
		const res = await t.api("/audio/levels");
		const pending = collectSse(res, { timeoutMs: 3000 });
		await sleep(100);
		t.capture.advance(2);
		await t.json("/recording/stop", { method: "POST" });
		const { events, closed } = await pending;
		expect(closed).toBe(true);
		expect(events.some((e) => e.event === "message")).toBe(true);
		expect(events.at(-1)).toEqual({ event: "ended", data: { sessionId: session.id } });
	});

	it("sends `ended` when the capture dies mid-recording", async () => {
		t = await startTestApp({ ssePollMs: 10_000 }); // only the interrupt event can end it
		const { session } = (await t.json("/recording/start", { method: "POST", json: {} })).body;
		const res = await t.api("/audio/levels");
		const pending = collectSse(res, { timeoutMs: 3000 });
		await sleep(100);
		t.capture.advance(2);
		t.capture.simulateCrash();
		const { events, closed } = await pending;
		expect(closed).toBe(true);
		expect(events.at(-1)).toEqual({ event: "ended", data: { sessionId: session.id } });
	});

	it("forwards capture warnings as `event: warning` (fallback → pt-BR message + live name)", async () => {
		t = await startTestApp({ ssePollMs: 20 });
		await t.json("/recording/start", {
			method: "POST",
			json: { device: "Fones de ouvido (WH-1000XM4)", micDevice: "none" },
		});
		const client = await openSseClient(t.base, "/audio/levels");
		await client.waitFor((e) => e.event === "devices");

		const find = async (pred: (e: { event: string; data: Json }) => boolean) => {
			await client.waitFor(pred);
			return client.events.find(pred);
		};
		t.capture.simulateFallback("system");
		const warning = await find((e) => e.event === "warning");
		expect(warning?.data).toEqual({
			message: "Dispositivo indisponível — usando o padrão do sistema",
			fallback: true,
		});
		// The following devices event carries the name actually recording.
		const devices = await find(
			(e) => e.event === "devices" && e.data.systemName !== "Fones de ouvido (WH-1000XM4)",
		);
		expect(devices?.data).toMatchObject({
			system: "Fones de ouvido (WH-1000XM4)",
			systemName: "Alto-falantes (Realtek(R) Audio)",
		});

		t.capture.simulateWarning("microphone: COM init failed (x)");
		const other = await find((e) => e.event === "warning" && e.data.fallback === false);
		expect(other?.data.message).toBe("Aviso da captura de áudio: microphone: COM init failed (x)");
		client.close();
	});

	it("sends no warning events on meter (idle) streams", async () => {
		t = await startTestApp({ ssePollMs: 20 });
		const res = await t.api("/audio/levels");
		const pending = collectSse(res, { timeoutMs: 300 });
		t.capture.simulateWarning("ignored while idle");
		const { events } = await pending;
		expect(events.some((e) => e.event === "warning")).toBe(false);
	});

	it("reports levels-unsupported recordings but still streams device changes", async () => {
		t = await startTestApp({ ssePollMs: 20 });
		(t.capture.capabilities as { levels: boolean }).levels = false;
		await t.json("/recording/start", { method: "POST", json: {} });
		const res = await t.api("/audio/levels");
		const { events, closed } = await collectSse(res, { timeoutMs: 300 });
		expect(closed).toBe(false);
		expect(events.map((e) => e.event)).toEqual(["devices", "unavailable"]);
		expect(events[1]?.data).toEqual({ reason: "levels-unsupported" });
	});
});
