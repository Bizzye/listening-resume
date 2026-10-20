import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CommandRunner, FFmpegPulseAdapter } from "../../src/adapters/audio/ffmpeg-pulse.js";
import { AudioCaptureError } from "../../src/domain/errors.js";
import type { CaptureOptions, ChunkInfo, ResolvedDevices } from "../../src/ports/audio-capture.js";
import { run } from "../../src/utils/process.js";
import { readWavInfo } from "../../src/utils/wav.js";
import { makeTempDir } from "../helpers.js";

/** Drives the real adapter against a node script standing in for ffmpeg (pactl faked). */
const FAKE_FFMPEG = path.resolve(__dirname, "../fixtures/fake-ffmpeg.mjs");

const PACTL_DEFAULTS: Record<string, string> = {
	"get-default-sink": "alsa_output.pci-0000_00_1f.3.analog-stereo",
	"get-default-source": "alsa_input.pci-0000_00_1f.3.analog-stereo",
};

function makeAdapter(pactl: Record<string, string> | null = PACTL_DEFAULTS): FFmpegPulseAdapter {
	const runCommand: CommandRunner = async (command, args, timeoutMs) => {
		if (command === "pactl") {
			const out = pactl?.[args[0]];
			if (out === undefined) throw new Error("spawn pactl ENOENT");
			return { code: 0, stdout: `${out}\n`, stderr: "" };
		}
		return run(command, args, timeoutMs);
	};
	return new FFmpegPulseAdapter({
		ffmpegPath: process.execPath,
		ffmpegArgsPrefix: [FAKE_FFMPEG],
		runCommand,
	});
}

describe("FFmpegPulseAdapter lifecycle (fake ffmpeg)", () => {
	let dir: string;
	let cleanup: () => void;
	let options: CaptureOptions;
	let log: string;

	beforeEach(() => {
		({ dir, cleanup } = makeTempDir());
		log = path.join(dir, "ffmpeg-args.log");
		process.env.FAKE_FFMPEG_LOG = log;
		options = {
			devices: { system: "@default", mic: "@default" },
			micVolume: 1.2,
			sampleRate: 16000,
			channels: 1,
			chunkSeconds: 0.4,
			outputDir: dir,
			filenamePrefix: "chunk",
		};
	});
	afterEach(() => {
		delete process.env.FAKE_FFMPEG_LOG;
		cleanup();
	});

	const loggedRuns = (): string[][] =>
		fs
			.readFileSync(log, "utf-8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as string[]);

	it("chains chunks, resolves @default names, mutes and switches by rotating chunks", async () => {
		const adapter = makeAdapter();
		expect(await adapter.isAvailable()).toBe(true);
		const ready: ChunkInfo[] = [];
		const off = adapter.onChunkReady((c) => ready.push(c));
		const devices: ResolvedDevices[] = [];
		adapter.onDeviceChange((d) => devices.push(d));

		await adapter.startCapture(options);
		expect(adapter.getActiveDevices()).toEqual({
			system: "@default",
			mic: "@default",
			systemName: "alsa_output.pci-0000_00_1f.3.analog-stereo.monitor",
			micName: "alsa_input.pci-0000_00_1f.3.analog-stereo",
		});
		await vi.waitFor(() => expect(ready.length).toBeGreaterThanOrEqual(2), { timeout: 5000 });

		// (the fake logs its argv a moment after `spawn`)
		const lastFilter = () => {
			const args = loggedRuns().at(-1) ?? [];
			return args.includes("-filter_complex") ? args[args.indexOf("-filter_complex") + 1] : null;
		};
		await adapter.setInputMute("mic", true);
		await vi.waitFor(() => expect(lastFilter()).toContain("volume=0[mic]"), { timeout: 3000 });

		const switched = await adapter.switchDevices({ mic: null });
		expect(switched).toMatchObject({ mic: null, micName: null });
		expect(devices.at(-1)).toMatchObject({ mic: null, micName: null });
		await vi.waitFor(() => expect(lastFilter()).toBeNull(), { timeout: 3000 }); // system only

		const before = ready.length;
		off(); // unsubscribed listeners get nothing more
		const chunks = await adapter.stopCapture();
		expect(ready.length).toBe(before);
		expect(chunks.length).toBeGreaterThan(before);
		expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
		for (const c of chunks) expect(readWavInfo(c.path).sampleRate).toBe(16000);
		expect(adapter.getActiveDevices()).toBeNull();
	});

	it("keeps the @default alias when pactl can't tell the default device", async () => {
		const adapter = makeAdapter(null);
		await adapter.startCapture({ ...options, devices: { system: "@default", mic: null } });
		expect(adapter.getActiveDevices()).toMatchObject({ systemName: "@default", micName: null });
		await adapter.stopCapture();
	});

	it("rejects start when ffmpeg cannot be spawned (no onError, state cleared)", async () => {
		const adapter = new FFmpegPulseAdapter({ ffmpegPath: path.join(dir, "no-ffmpeg.exe") });
		const onError = vi.fn();
		adapter.onError(onError);
		expect(await adapter.isAvailable()).toBe(false);
		await expect(adapter.startCapture(options)).rejects.toThrow(/FFmpeg não pôde ser iniciado/);
		await new Promise((r) => setTimeout(r, 100));
		expect(onError).not.toHaveBeenCalled();
		expect(adapter.getActiveDevices()).toBeNull();
		// Not stuck in "recording": a new start is attempted (and fails the same way).
		await expect(adapter.startCapture(options)).rejects.toBeInstanceOf(AudioCaptureError);
	});

	it("reports a device failure after spawn once through onError", async () => {
		const adapter = makeAdapter();
		const onError = vi.fn();
		adapter.onError(onError);
		await adapter.startCapture({ ...options, devices: { system: "explode", mic: null } });
		await vi.waitFor(() => expect(onError).toHaveBeenCalled(), { timeout: 3000 });
		await new Promise((r) => setTimeout(r, 100));
		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError.mock.calls[0][0].message).toMatch(/FFmpeg encerrou.*No such device/);
		expect(adapter.getActiveDevices()).toBeNull();
		expect(await adapter.stopCapture()).toEqual([]);
	});
});
