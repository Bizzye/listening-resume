import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildWavHeader,
	createWav,
	floatToPcm16,
	parseWavHeader,
	readWavInfo,
	repairWavHeader,
	totalWavDurationSec,
	tryReadWavInfo,
	writeWavHeader,
} from "../../../src/utils/wav.js";
import { makeTempDir, writeToneWav } from "../../helpers.js";

describe("wav utils", () => {
	let dir: string;
	let cleanup: () => void;

	beforeEach(() => {
		({ dir, cleanup } = makeTempDir());
	});
	afterEach(() => cleanup());

	it("createWav produces a canonical 16-bit PCM file readable by readWavInfo", () => {
		const file = writeToneWav(path.join(dir, "a.wav"), 2, 16000, 1);
		const info = readWavInfo(file);
		expect(info).toMatchObject({
			sampleRate: 16000,
			channels: 1,
			bitsPerSample: 16,
			dataOffset: 44,
			dataBytes: 64000,
			headerStale: false,
		});
		expect(info.durationSec).toBeCloseTo(2, 5);
	});

	it("computes duration from the file's own format (48 kHz stereo)", () => {
		const file = writeToneWav(path.join(dir, "b.wav"), 1.5, 48000, 2);
		const info = readWavInfo(file);
		expect(info.sampleRate).toBe(48000);
		expect(info.channels).toBe(2);
		expect(info.durationSec).toBeCloseTo(1.5, 5);
	});

	it("trusts the file size when the header data size is 0 (writer killed)", () => {
		const file = writeToneWav(path.join(dir, "stale.wav"), 3);
		const fd = fs.openSync(file, "r+");
		writeWavHeader(fd, { sampleRate: 16000, channels: 1, bitsPerSample: 16 }, 0);
		fs.closeSync(fd);

		const info = readWavInfo(file);
		expect(info.headerStale).toBe(true);
		expect(info.durationSec).toBeCloseTo(3, 5);
	});

	it("trusts the file size when the header under-reports appended audio", () => {
		const file = writeToneWav(path.join(dir, "grown.wav"), 2);
		const fd = fs.openSync(file, "r+");
		writeWavHeader(fd, { sampleRate: 16000, channels: 1, bitsPerSample: 16 }, 32000); // says 1 s
		fs.closeSync(fd);
		expect(readWavInfo(file).durationSec).toBeCloseTo(2, 5);
	});

	it("respects a real trailing chunk after the data chunk", () => {
		const pcm = Buffer.alloc(32000);
		const list = Buffer.concat([
			Buffer.from("LIST"),
			Buffer.from([4, 0, 0, 0]),
			Buffer.from("INFO"),
		]);
		const header = buildWavHeader({ sampleRate: 16000, channels: 1, bitsPerSample: 16 }, 32000);
		const file = path.join(dir, "trailing.wav");
		fs.writeFileSync(file, Buffer.concat([header, pcm, list]));
		const info = readWavInfo(file);
		expect(info.headerStale).toBe(false);
		expect(info.dataBytes).toBe(32000);
	});

	it("treats printable bytes with an impossible chunk size as appended audio", () => {
		const header = buildWavHeader({ sampleRate: 16000, channels: 1, bitsPerSample: 16 }, 32000);
		// 1 s declared, then 1 s more whose first bytes happen to be printable ASCII.
		const appended = Buffer.alloc(32000, 0x41); // "AAAA" + size 0x41414141 (> file)
		const file = path.join(dir, "printable.wav");
		fs.writeFileSync(file, Buffer.concat([header, Buffer.alloc(32000), appended]));
		const info = readWavInfo(file);
		expect(info.headerStale).toBe(true);
		expect(info.durationSec).toBeCloseTo(2, 5);
	});

	it("caps a header that claims more data than the file holds", () => {
		const header = buildWavHeader({ sampleRate: 16000, channels: 1, bitsPerSample: 16 }, 999_999);
		const file = path.join(dir, "truncated.wav");
		fs.writeFileSync(file, Buffer.concat([header, Buffer.alloc(16000)]));
		expect(readWavInfo(file).durationSec).toBeCloseTo(0.5, 5);
	});

	it("walks RIFF chunks: LIST before fmt/data and odd-sized chunks", () => {
		const fmt = buildWavHeader({ sampleRate: 8000, channels: 1, bitsPerSample: 16 }, 0).subarray(
			12,
			36,
		);
		const odd = Buffer.concat([
			Buffer.from("junk"),
			Buffer.from([3, 0, 0, 0]),
			Buffer.from([1, 2, 3, 0]),
		]);
		const data = Buffer.concat([
			Buffer.from("data"),
			Buffer.from([0x40, 0x1f, 0, 0]),
			Buffer.alloc(8000),
		]);
		const body = Buffer.concat([Buffer.from("WAVE"), odd, fmt, data]);
		const riff = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), body]);
		riff.writeUInt32LE(riff.length - 8, 4);
		const info = parseWavHeader(riff, riff.length);
		expect(info.sampleRate).toBe(8000);
		expect(info.durationSec).toBeCloseTo(0.5, 5);
	});

	it("rejects non-WAV input", () => {
		expect(() => parseWavHeader(Buffer.from("not a wav file at all"), 21)).toThrow(/RIFF/);
		const file = path.join(dir, "x.wav");
		fs.writeFileSync(file, "hello");
		expect(tryReadWavInfo(file)).toBeNull();
		expect(tryReadWavInfo(path.join(dir, "missing.wav"))).toBeNull();
	});

	it("repairWavHeader rewrites stale sizes in place and is a no-op otherwise", () => {
		const file = writeToneWav(path.join(dir, "repair.wav"), 1);
		expect(repairWavHeader(file)).toBe(false);

		const fd = fs.openSync(file, "r+");
		writeWavHeader(fd, { sampleRate: 16000, channels: 1, bitsPerSample: 16 }, 0);
		fs.closeSync(fd);
		expect(repairWavHeader(file)).toBe(true);

		const buf = fs.readFileSync(file);
		expect(buf.readUInt32LE(40)).toBe(32000);
		expect(buf.readUInt32LE(4)).toBe(buf.length - 8);
		expect(readWavInfo(file).headerStale).toBe(false);
	});

	it("totalWavDurationSec sums files and ignores unreadable ones", () => {
		const a = writeToneWav(path.join(dir, "1.wav"), 1);
		const b = writeToneWav(path.join(dir, "2.wav"), 2.5, 48000, 2);
		expect(totalWavDurationSec([a, b, path.join(dir, "nope.wav")])).toBeCloseTo(3.5, 5);
	});

	it("floatToPcm16 clamps and scales", () => {
		expect(Array.from(floatToPcm16([0, 1, -1, 2, -2, 0.5]))).toEqual([
			0, 32767, -32768, 32767, -32768, 16384,
		]);
	});

	it("createWav sets block align for stereo", () => {
		const wav = createWav(new Int16Array(8), { sampleRate: 44100, channels: 2 });
		expect(wav.readUInt16LE(32)).toBe(4);
		expect(wav.readUInt32LE(28)).toBe(44100 * 4);
		expect(wav.length).toBe(44 + 16);
	});
});
