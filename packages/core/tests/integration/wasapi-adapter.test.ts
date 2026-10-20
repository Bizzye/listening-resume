import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WasapiCaptureAdapter } from "../../src/adapters/audio/wasapi-capture.js";
import { LocalFileStorage } from "../../src/adapters/persistence/local-files.js";
import { SQLiteRepository } from "../../src/adapters/persistence/sqlite.js";
import { RecordingService } from "../../src/application/recording.service.js";
import { AudioCaptureError, ValidationError } from "../../src/domain/errors.js";
import type { Session } from "../../src/domain/models.js";
import type {
	AudioLevels,
	CaptureOptions,
	ResolvedDevices,
} from "../../src/ports/audio-capture.js";
import { readWavInfo } from "../../src/utils/wav.js";
import { makeTempDir } from "../helpers.js";

/** Drives the real adapter against a node script that speaks the binary's protocol. */
const FAKE_BINARY = path.resolve(__dirname, "../fixtures/fake-wasapi.mjs");

function makeAdapter(): WasapiCaptureAdapter {
	return new WasapiCaptureAdapter({
		binaryPath: process.execPath,
		argsPrefix: [FAKE_BINARY],
		stopTimeoutMs: 5000,
		startTimeoutMs: 5000,
	});
}

describe("WasapiCaptureAdapter (protocol over a child process)", () => {
	let dir: string;
	let cleanup: () => void;
	let options: CaptureOptions;

	beforeEach(() => {
		({ dir, cleanup } = makeTempDir());
		options = {
			devices: { system: "@default", mic: "@default" },
			micVolume: 1.2,
			sampleRate: 16000,
			channels: 1,
			chunkSeconds: 0.3,
			outputDir: dir,
			filenamePrefix: "chunk",
		};
	});
	afterEach(() => cleanup());

	it("lists devices and plays test tones", async () => {
		const adapter = makeAdapter();
		expect(await adapter.isAvailable()).toBe(true);
		const devices = await adapter.listDevices();
		expect(devices.map((d) => d.id)).toEqual(["Speakers", "Mic"]);
		await expect(adapter.playTestTone("Speakers (Loopback)")).resolves.toBeUndefined();
		await expect(adapter.playTestTone("bad")).rejects.toThrow(/render device not found/);
	});

	it("records chunks, streams levels, mutes and switches devices live", async () => {
		const adapter = makeAdapter();
		const chunkEvents: number[] = [];
		adapter.onChunkReady((c) => chunkEvents.push(c.index));
		const levels: AudioLevels[] = [];
		adapter.onLevels((l) => levels.push(l));
		const deviceEvents: ResolvedDevices[] = [];
		adapter.onDeviceChange((d) => deviceEvents.push(d));

		await adapter.startCapture(options);
		expect(adapter.getActiveDevices()).toEqual({
			system: "@default",
			mic: "@default",
			systemName: "Speakers",
			micName: "Mic",
		});

		await vi.waitFor(() => expect(levels.length).toBeGreaterThan(2), { timeout: 3000 });
		expect(levels.at(-1)).toEqual({ system: 0.5, mic: 0.25 });

		await adapter.setInputMute("mic", true);
		expect(adapter.getInputMuteState()).toEqual({ system: false, mic: true });
		await vi.waitFor(() => expect(levels.at(-1)).toEqual({ system: 0.5, mic: 0 }), {
			timeout: 3000,
		});

		// Both sources in one burst: one tagged `DEVICE:` line per source; both must arrive.
		const t0 = Date.now();
		const switched = await adapter.switchDevices({ system: "Headphones", mic: null });
		expect(Date.now() - t0).toBeLessThan(2000); // not the 5 s timeout
		expect(switched).toEqual({
			system: "Headphones",
			mic: null,
			systemName: "Headphones",
			micName: null,
		});
		expect(deviceEvents.at(-1)?.systemName).toBe("Headphones");
		// No-op switch returns immediately.
		expect((await adapter.switchDevices({ system: "Headphones" })).systemName).toBe("Headphones");

		await vi.waitFor(() => expect(chunkEvents.length).toBeGreaterThanOrEqual(1), { timeout: 3000 });
		const chunks = await adapter.stopCapture();
		expect(chunks.length).toBe(chunkEvents.length);
		expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
		for (const c of chunks) expect(readWavInfo(c.path).sampleRate).toBe(16000);
		expect(adapter.getActiveDevices()).toBeNull();
	});

	it("a switch to a missing device resolves on the fallback event after WARN", async () => {
		const adapter = makeAdapter();
		const warnings: string[] = [];
		const off = adapter.onWarning((m) => warnings.push(m));
		await adapter.startCapture(options);
		const t0 = Date.now();
		const switched = await adapter.switchDevices({ system: "Missing" });
		expect(Date.now() - t0).toBeLessThan(2000);
		expect(switched.systemName).toBe("Speakers"); // fell back to the default
		expect(warnings).toEqual([
			"could not open system audio 'Missing' (not found); falling back to the system default",
		]);
		off();
		await adapter.stopCapture();
	});

	it("a switch is not acknowledged by a DEVICE line about the other source", async () => {
		process.env.FAKE_WASAPI_MIC_FIRST = "1";
		const adapter = makeAdapter();
		try {
			await adapter.startCapture({
				...options,
				devices: { system: "Headphones", mic: "@default" },
			});
		} finally {
			delete process.env.FAKE_WASAPI_MIC_FIRST;
		}
		const seen: (string | null)[] = [];
		adapter.onDeviceChange((d) => seen.push(d.systemName));
		// The binary first reports the mic (old system name "Headphones" — a non-null name
		// that would satisfy `@default`), then the system source reopening on the default.
		const switched = await adapter.switchDevices({ system: "@default" });
		expect(seen).toEqual(["Headphones", "Speakers"]);
		expect(switched).toMatchObject({ system: "@default", systemName: "Speakers" });
		await adapter.stopCapture();
	});

	it("still acknowledges switches from a binary speaking the legacy 2-field DEVICE line", async () => {
		process.env.FAKE_WASAPI_LEGACY = "1";
		const adapter = makeAdapter();
		try {
			await adapter.startCapture(options);
		} finally {
			delete process.env.FAKE_WASAPI_LEGACY;
		}
		expect(adapter.getActiveDevices()).toMatchObject({ systemName: "Speakers", micName: "Mic" });
		const t0 = Date.now();
		const switched = await adapter.switchDevices({ system: "Headphones", mic: null });
		expect(Date.now() - t0).toBeLessThan(2000);
		expect(switched).toMatchObject({ systemName: "Headphones", micName: null });
		await adapter.stopCapture();
	});

	it("rejects device ids that would inject stdin commands", async () => {
		const adapter = makeAdapter();
		await adapter.startCapture(options);
		await expect(adapter.switchDevices({ mic: "Mic\nq" })).rejects.toBeInstanceOf(ValidationError);
		expect(adapter.getActiveDevices()?.mic).toBe("@default"); // still recording, unchanged
		await adapter.stopCapture();
	});

	it("rejects start with the binary's stderr when it exits immediately (no onError)", async () => {
		const adapter = makeAdapter();
		const onError = vi.fn();
		adapter.onError(onError);
		await expect(
			adapter.startCapture({ ...options, devices: { system: "explode", mic: null } }),
		).rejects.toThrow(/could not open device/);
		expect(adapter.getActiveDevices()).toBeNull();
		expect(onError).not.toHaveBeenCalled();
		// The adapter is reusable afterwards.
		await adapter.startCapture(options);
		await adapter.stopCapture();
	});

	it("rejects start when the binary cannot be spawned (no onError)", async () => {
		const adapter = new WasapiCaptureAdapter({
			binaryPath: path.join(dir, "missing-wasapi-capture.exe"),
			startTimeoutMs: 2000,
		});
		const onError = vi.fn();
		adapter.onError(onError);
		await expect(adapter.startCapture(options)).rejects.toThrow(/Falha ao iniciar wasapi-capture/);
		await new Promise((r) => setTimeout(r, 100)); // a late `close` must not emit either
		expect(onError).not.toHaveBeenCalled();
		expect(adapter.getActiveDevices()).toBeNull();
	});

	it("reports an unexpected exit through onError exactly once", async () => {
		const adapter = makeAdapter();
		const onError = vi.fn();
		adapter.onError(onError);
		await adapter.startCapture({ ...options, devices: { system: "dies", mic: null } });
		await vi.waitFor(() => expect(onError).toHaveBeenCalled(), { timeout: 3000 });
		await new Promise((r) => setTimeout(r, 100));
		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError.mock.calls[0][0].message).toMatch(/parou inesperadamente.*device lost/);
		expect(adapter.getActiveDevices()).toBeNull();
		expect(await adapter.stopCapture()).toEqual([]);
	});

	it("kills a binary that ignores `q` once the stop timeout elapses", async () => {
		const adapter = new WasapiCaptureAdapter({
			binaryPath: process.execPath,
			argsPrefix: [FAKE_BINARY],
			stopTimeoutMs: 300,
			startTimeoutMs: 5000,
		});
		const onError = vi.fn();
		adapter.onError(onError);
		await adapter.startCapture({ ...options, devices: { system: "stubborn", mic: null } });
		const t0 = Date.now();
		await adapter.stopCapture();
		expect(Date.now() - t0).toBeLessThan(3000);
		expect(adapter.getActiveDevices()).toBeNull();
		expect(onError).not.toHaveBeenCalled(); // a requested stop is never a failure
		await adapter.startCapture(options); // reusable
		await adapter.stopCapture();
	});

	it("runs a meter in meter-only mode (no output dir, no files)", async () => {
		const argsFile = path.join(dir, "meter-args.json");
		process.env.FAKE_WASAPI_ARGS_FILE = argsFile;
		const adapter = makeAdapter();
		const meter = await adapter.startMeter({ system: "@default", mic: null });
		delete process.env.FAKE_WASAPI_ARGS_FILE;
		const levels: AudioLevels[] = [];
		const devices: ResolvedDevices[] = [];
		meter.onLevels((l) => levels.push(l));
		meter.onDeviceChange((d) => devices.push(d));
		await vi.waitFor(() => expect(levels.length).toBeGreaterThan(1), { timeout: 3000 });
		expect(levels[0]).toEqual({ system: 0.5, mic: 0 });
		await meter.stop();
		await meter.stop(); // idempotent
		const args: string[] = JSON.parse(fs.readFileSync(argsFile, "utf-8"));
		expect(args).toContain("--meter-only");
		expect(args).not.toContain("--output-dir");
		expect(fs.readdirSync(dir)).toEqual(["meter-args.json"]); // nothing else written
	});
});

describe("RecordingService over the protocol adapter", () => {
	let dir: string;
	let cleanup: () => void;
	let repo: SQLiteRepository;
	let service: RecordingService;

	beforeEach(() => {
		({ dir, cleanup } = makeTempDir());
		repo = new SQLiteRepository(":memory:");
		service = new RecordingService({
			capture: makeAdapter(),
			repo,
			storage: new LocalFileStorage(dir),
			audio: { sampleRate: 16000, channels: 1, chunkSeconds: 60 },
		});
	});
	afterEach(() => {
		repo.close();
		cleanup();
	});

	it("a capture process that exits during start fails the start cleanly", async () => {
		const err = await service
			.start({ devices: { system: "explode", mic: null } })
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(AudioCaptureError);
		expect((err as Error).message).toMatch(/could not open device/);
		expect(repo.listSessions()).toEqual([]);
		expect(service.getActive()).toBeNull();

		// The slot is free and the adapter reusable.
		const session = await service.start({ devices: { system: "@default", mic: null } });
		await new Promise((r) => setTimeout(r, 300));
		const { chunks, session: stopped } = await service.stop();
		expect(stopped.id).toBe(session.id);
		expect(chunks).toBe(1);
		expect(stopped.status).toBe("stopped");
	});

	it("a capture process dying mid-recording settles the session once", async () => {
		const interrupted: Session[] = [];
		service.onInterrupted((s) => interrupted.push(s));
		const session = await service.start({ devices: { system: "dies", mic: null } });
		await vi.waitFor(() => expect(interrupted).toHaveLength(1), { timeout: 3000 });
		expect(interrupted[0]).toMatchObject({ id: session.id, status: "failed" });
		expect(interrupted[0].lastError).toMatch(/interrompida.*device lost/);
		expect(service.getActive()).toBeNull();
		await new Promise((r) => setTimeout(r, 100));
		expect(interrupted).toHaveLength(1);
		await expect(service.stop()).rejects.toThrow(/Nenhuma gravação/);
	});
});
