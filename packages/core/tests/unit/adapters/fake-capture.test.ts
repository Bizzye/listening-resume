import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FAKE_DEVICES, FakeCaptureAdapter } from "../../../src/adapters/audio/fake-capture.js";
import type { AudioLevels, CaptureOptions, ChunkInfo } from "../../../src/ports/audio-capture.js";
import { readWavInfo } from "../../../src/utils/wav.js";
import { makeTempDir } from "../../helpers.js";

describe("FakeCaptureAdapter", () => {
	let dir: string;
	let cleanup: () => void;
	let options: CaptureOptions;

	beforeEach(() => {
		({ dir, cleanup } = makeTempDir());
		options = {
			devices: { system: "@default", mic: "@default" },
			sampleRate: 16000,
			channels: 1,
			chunkSeconds: 5,
			outputDir: path.join(dir, "audio"),
			filenamePrefix: "chunk",
		};
	});
	afterEach(() => {
		vi.useRealTimers();
		cleanup();
	});

	it("lists 2 monitors + 2 mics with one default each", async () => {
		const devices = await new FakeCaptureAdapter().listDevices();
		expect(devices).toHaveLength(4);
		for (const type of ["monitor", "microphone"] as const) {
			const ofType = devices.filter((d) => d.type === type);
			expect(ofType).toHaveLength(2);
			expect(ofType.filter((d) => d.isDefault)).toHaveLength(1);
		}
	});

	it("writes valid WAV chunks at chunkSeconds boundaries when fast-forwarded", async () => {
		const capture = new FakeCaptureAdapter({ realtime: false });
		const ready: ChunkInfo[] = [];
		const off = capture.onChunkReady((c) => ready.push(c));
		await capture.startCapture({ ...options, sampleRate: 22050, channels: 2 });

		capture.advance(12);
		expect(ready.map((c) => c.index)).toEqual([0, 1]);
		off();
		capture.advance(5);
		expect(ready).toHaveLength(2); // unsubscribed

		const chunks = await capture.stopCapture();
		expect(chunks).toHaveLength(4);
		expect(path.basename(chunks[3].path)).toBe("chunk_0003.wav");
		const durations = chunks.map((c) => readWavInfo(c.path));
		expect(durations.map((d) => Math.round(d.durationSec * 10) / 10)).toEqual([5, 5, 5, 2]);
		expect(durations[0]).toMatchObject({ sampleRate: 22050, channels: 2, bitsPerSample: 16 });
	});

	it("resolves @default to the OS default devices and announces them", async () => {
		const capture = new FakeCaptureAdapter({ realtime: false });
		const seen = vi.fn();
		capture.onDeviceChange(seen);
		await capture.startCapture(options);
		const defaults = FAKE_DEVICES.filter((d) => d.isDefault).map((d) => d.id);
		expect(seen).toHaveBeenCalledWith({
			system: "@default",
			mic: "@default",
			systemName: defaults[0],
			micName: defaults[1],
		});
		expect(capture.getActiveDevices()?.systemName).toBe(defaults[0]);
		await capture.stopCapture();
		expect(capture.getActiveDevices()).toBeNull();
	});

	it("emits levels every 50 ms in realtime mode, zeroed by mute", async () => {
		vi.useFakeTimers();
		const capture = new FakeCaptureAdapter();
		const levels: AudioLevels[] = [];
		const unsubscribe = capture.onLevels((l) => levels.push(l));
		await capture.startCapture(options);

		vi.advanceTimersByTime(500);
		expect(levels.length).toBe(10);
		expect(levels.every((l) => l.system > 0 && l.mic > 0)).toBe(true);

		await capture.setInputMute("mic", true);
		vi.advanceTimersByTime(100);
		expect(levels.at(-1)?.mic).toBe(0);
		expect(levels.at(-1)?.system).toBeGreaterThan(0);
		expect(capture.getInputMuteState()).toEqual({ system: false, mic: true });

		await capture.setInputMute("system", true);
		vi.advanceTimersByTime(100);
		expect(levels.at(-1)).toEqual({ system: 0, mic: 0 });

		unsubscribe();
		const count = levels.length;
		vi.advanceTimersByTime(200);
		expect(levels.length).toBe(count);
		await capture.stopCapture();
	});

	it("muted audio is actually silent in the written WAV", async () => {
		const capture = new FakeCaptureAdapter({ realtime: false });
		await capture.startCapture({ ...options, devices: { system: "@default", mic: null } });
		await capture.setInputMute("system", true);
		capture.advance(1);
		const [chunk] = await capture.stopCapture();
		const fs = await import("node:fs");
		const pcm = fs.readFileSync(chunk.path).subarray(44);
		expect(pcm.every((b) => b === 0)).toBe(true);
	});

	it("switches devices live and reports the new resolution", async () => {
		const capture = new FakeCaptureAdapter({ realtime: false });
		await capture.startCapture(options);
		const resolved = await capture.switchDevices({ mic: "Microfone (USB Audio Device)" });
		expect(resolved).toMatchObject({
			system: "@default",
			mic: "Microfone (USB Audio Device)",
			micName: "Microfone (USB Audio Device)",
		});
		const noMic = await capture.switchDevices({ mic: null });
		expect(noMic.micName).toBeNull();
		capture.advance(0.2);
		await capture.stopCapture();
		await expect(capture.switchDevices({ mic: null })).rejects.toThrow(/Nenhuma captura/);
	});

	it("rejects a second concurrent capture", async () => {
		const capture = new FakeCaptureAdapter({ realtime: false });
		await capture.startCapture(options);
		await expect(capture.startCapture(options)).rejects.toThrow(/já está em andamento/);
		await capture.stopCapture();
	});

	it("meter emits levels and devices until stopped; test tones are recorded", async () => {
		vi.useFakeTimers();
		const capture = new FakeCaptureAdapter();
		const meter = await capture.startMeter({ system: "@default", mic: null });
		const levels: AudioLevels[] = [];
		const devices = vi.fn();
		meter.onLevels((l) => levels.push(l));
		meter.onDeviceChange(devices);
		vi.advanceTimersByTime(200);
		expect(levels).toHaveLength(4);
		expect(levels.every((l) => l.mic === 0 && l.system > 0)).toBe(true);
		expect(devices).toHaveBeenCalledTimes(1);
		await meter.stop();
		vi.advanceTimersByTime(200);
		expect(levels).toHaveLength(4);

		await capture.playTestTone("@default");
		expect(capture.testTones).toEqual(["@default"]);
	});

	it("simulateCrash reports a fatal error", async () => {
		const capture = new FakeCaptureAdapter({ realtime: false });
		const onError = vi.fn();
		capture.onError(onError);
		await capture.startCapture(options);
		capture.simulateCrash("boom");
		expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "boom" }));
		expect(capture.isCapturing).toBe(false);
	});
});
