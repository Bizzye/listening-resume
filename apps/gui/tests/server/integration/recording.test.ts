import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Json, readSse, startTestApp, type TestApp } from "./harness.js";

describe("devices & audio", () => {
	let t: TestApp;
	beforeEach(async () => {
		t = await startTestApp();
	});
	afterEach(() => t.close());

	it("GET /devices lists real devices with defaults", async () => {
		const { body } = await t.json("/devices");
		expect(body.devices).toHaveLength(4);
		expect(body.devices.filter((d: Json) => d.isDefault)).toHaveLength(2);
	});

	it("POST /audio/test plays a tone on the requested device", async () => {
		expect(
			(await t.json("/audio/test", { method: "POST", json: { device: "@default" } })).body,
		).toEqual({
			ok: true,
		});
		await t.json("/audio/test", { method: "POST", json: {} });
		expect(t.capture.testTones).toEqual(["@default", "@default"]);
		expect((await t.json("/audio/test", { method: "POST", json: { device: 3 } })).status).toBe(400);
	});

	it("GET /audio/levels streams a meter when idle", async () => {
		const res = await t.api("/audio/levels?system=@default&mic=none");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		const events = await readSse(res, 4);
		const devices = events.find((e) => e.event === "devices");
		expect(devices?.data).toMatchObject({ system: "@default", mic: null, micName: null });
		const levels = events.filter((e) => e.event === "message");
		expect(levels.length).toBeGreaterThanOrEqual(2);
		for (const l of levels) {
			expect(l.data.system).toBeGreaterThan(0);
			expect(l.data.mic).toBe(0);
		}
	});
});

describe("recording lifecycle", () => {
	let t: TestApp;
	beforeEach(async () => {
		t = await startTestApp();
	});
	afterEach(() => t.close());

	it("start → status → mute → switch → stop", async () => {
		expect((await t.json("/recording/status")).body).toEqual({ recording: false });

		const start = await t.json("/recording/start", {
			method: "POST",
			json: { device: "@default", micDevice: "Microfone (USB Audio Device)" },
		});
		expect(start.status).toBe(200);
		const { session, startTime, devices } = start.body;
		expect(session.status).toBe("recording");
		expect(typeof startTime).toBe("number");
		expect(devices).toMatchObject({
			system: "@default",
			systemName: "Alto-falantes (Realtek(R) Audio)",
			micName: "Microfone (USB Audio Device)",
		});

		const again = await t.json("/recording/start", { method: "POST", json: {} });
		expect(again.status).toBe(409);

		const mute = await t.json("/recording/mute", {
			method: "POST",
			json: { target: "mic", muted: true },
		});
		expect(mute.body).toEqual({ target: "mic", muted: true });
		expect(
			(await t.json("/recording/mute", { method: "POST", json: { target: "x", muted: true } }))
				.status,
		).toBe(400);

		const sw = await t.json("/recording/devices", { method: "POST", json: { micDevice: "none" } });
		expect(sw.body.devices).toMatchObject({ mic: null, micName: null });
		const sw2 = await t.json("/recording/devices", {
			method: "POST",
			json: { device: "Fones de ouvido (WH-1000XM4)" },
		});
		expect(sw2.body.devices.systemName).toBe("Fones de ouvido (WH-1000XM4)");

		t.capture.advance(12);
		const status = (await t.json("/recording/status")).body;
		expect(status).toMatchObject({
			recording: true,
			sessionId: session.id,
			startTime,
			chunks: 2,
			muted: { system: false, mic: true },
		});
		expect(status.devices.system).toBe("Fones de ouvido (WH-1000XM4)");

		const stop = await t.json("/recording/stop", { method: "POST" });
		expect(stop.status).toBe(200);
		expect(stop.body.chunks).toBe(3);
		expect(stop.body.session).toMatchObject({ id: session.id, status: "stopped" });
		expect((await t.json("/recording/status")).body).toEqual({ recording: false });

		const detail = (await t.json(`/sessions/${session.id}`)).body;
		expect(detail.session.chunks).toBe(3);
		expect(detail.session.duration).toBeGreaterThanOrEqual(12);
	});

	it("uses settings defaults and auto-transcribes on stop", async () => {
		t.settings.update({ autoTranscribe: true, micDevice: null });
		const start = await t.json("/recording/start", { method: "POST", json: {} });
		expect(start.body.devices).toMatchObject({ system: "@default", mic: null });
		t.capture.advance(3);
		const stop = await t.json("/recording/stop", { method: "POST" });
		expect(stop.body.session.status).toBe("transcribing");
		const done = await t.waitForStatus(stop.body.session.id, ["transcribed"]);
		expect(done.transcript.segments.length).toBeGreaterThan(0);
	});

	it("concurrent stops share one outcome and never record a conflict as lastError", async () => {
		t.settings.update({ autoTranscribe: true });
		const { session } = (await t.json("/recording/start", { method: "POST", json: {} })).body;
		t.capture.advance(3);
		const [a, b, c] = await Promise.all([
			t.json("/recording/stop", { method: "POST" }),
			t.json("/recording/stop", { method: "POST" }),
			t.json("/recording/stop", { method: "POST" }),
		]);
		for (const r of [a, b, c]) {
			expect(r.status).toBe(200);
			expect(r.body.session.id).toBe(session.id);
			expect(r.body.chunks).toBe(a.body.chunks);
		}
		const done = await t.waitForStatus(session.id, ["transcribed"]);
		expect(done.session.lastError).toBeNull();
		// a later stop is a plain 409 again
		expect((await t.json("/recording/stop", { method: "POST" })).status).toBe(409);
	});

	it("persists real auto-transcribe failures (not conflicts) as lastError", async () => {
		t.settings.update({ autoTranscribe: true });
		t.deps.transcription = {
			create: () => {
				throw new Error("Configure a chave da Groq");
			},
		};
		const { session } = (await t.json("/recording/start", { method: "POST", json: {} })).body;
		t.capture.advance(3);
		const stop = await t.json("/recording/stop", { method: "POST" });
		expect(stop.body.session).toMatchObject({
			status: "stopped",
			lastError: "Configure a chave da Groq",
		});
		expect(session.id).toBe(stop.body.session.id);
	});

	it("returns 409 for recording actions without an active recording", async () => {
		for (const [p, json] of [
			["/recording/stop", {}],
			["/recording/discard", {}],
			["/recording/mute", { target: "system", muted: true }],
			["/recording/devices", { device: "@default" }],
		] as const) {
			expect((await t.json(p, { method: "POST", json })).status).toBe(409);
		}
	});

	it("discard removes the session and its files", async () => {
		const { session } = (await t.json("/recording/start", { method: "POST", json: {} })).body;
		t.capture.advance(6);
		expect((await t.json("/recording/discard", { method: "POST" })).body).toEqual({ ok: true });
		expect((await t.json(`/sessions/${session.id}`)).status).toBe(404);
		expect(await t.deps.storage.listAudioFiles(session.id)).toEqual([]);
	});

	it("GET /audio/levels streams the recording's levels (mute applied)", async () => {
		await t.json("/recording/start", { method: "POST", json: { micDevice: "@default" } });
		await t.json("/recording/mute", { method: "POST", json: { target: "system", muted: true } });
		const res = await t.api("/audio/levels?system=ignored");
		const events = await readSse(res, 4);
		expect(events[0]).toMatchObject({ event: "devices", data: { system: "@default" } });
		const levels = events.filter((e) => e.event === "message");
		expect(levels.length).toBeGreaterThanOrEqual(2);
		for (const l of levels) {
			expect(l.data.system).toBe(0);
			expect(l.data.mic).toBeGreaterThan(0);
		}
	});

	it("refuses to delete or transcribe the session being recorded", async () => {
		const { session } = (await t.json("/recording/start", { method: "POST", json: {} })).body;
		expect((await t.json(`/sessions/${session.id}`, { method: "DELETE" })).status).toBe(409);
		expect((await t.json(`/sessions/${session.id}/transcribe`, { method: "POST" })).status).toBe(
			409,
		);
	});
});
