import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { text } from "node:stream/consumers";
import { afterAll, describe, expect, it } from "vitest";
import {
	createVirtualWavStream,
	parseRange,
	planReads,
	planVirtualWav,
	WAV_HEADER_SIZE,
	type WavSource,
} from "../../../server/services/wav-stream.js";

const fmt = { sampleRate: 16000, channels: 1, bitsPerSample: 16 };
const src = (p: string, dataBytes: number, dataOffset = 44, f = fmt): WavSource => ({
	path: p,
	info: { ...f, dataBytes, dataOffset },
});

describe("parseRange", () => {
	it("returns null when absent or not a byte range", () => {
		expect(parseRange(undefined, 100)).toBeNull();
		expect(parseRange("items=0-1", 100)).toBeNull();
		expect(parseRange("bytes=-", 100)).toBeNull();
	});
	it("ignores syntactically invalid ranges (last < first) per RFC 9110", () => {
		expect(parseRange("bytes=10-5", 100)).toBeNull();
		expect(parseRange("bytes=50-40", 100)).toBeNull();
	});
	it("parses open, closed and suffix ranges", () => {
		expect(parseRange("bytes=0-", 100)).toEqual({ start: 0, end: 99 });
		expect(parseRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
		expect(parseRange("bytes=90-500", 100)).toEqual({ start: 90, end: 99 });
		expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
		expect(parseRange("bytes=-500", 100)).toEqual({ start: 0, end: 99 });
	});
	it("uses the first range of a multi-range request", () => {
		expect(parseRange("bytes=0-4, 10-14", 100)).toEqual({ start: 0, end: 4 });
	});
	it("flags unsatisfiable ranges", () => {
		expect(parseRange("bytes=100-", 100)).toBe("unsatisfiable");
		expect(parseRange("bytes=100-120", 100)).toBe("unsatisfiable");
		expect(parseRange("bytes=-0", 100)).toBe("unsatisfiable");
	});
});

describe("planVirtualWav", () => {
	it("concatenates data sections under one header", () => {
		const plan = planVirtualWav([src("a", 1000), src("b", 600, 80)]);
		expect(plan).not.toBeNull();
		if (!plan) return;
		expect(plan.totalSize).toBe(WAV_HEADER_SIZE + 1600);
		expect(plan.parts.map((p) => p.virtualStart)).toEqual([44, 1044]);
		expect(plan.parts[1]?.fileOffset).toBe(80);
		expect(plan.header.readUInt32LE(40)).toBe(1600);
		expect(plan.header.readUInt32LE(24)).toBe(16000);
		expect(plan.durationSec).toBeCloseTo(1600 / 32000);
	});

	it("block-aligns parts and skips format mismatches", () => {
		const plan = planVirtualWav([
			src("a", 1001),
			src("b", 400, 44, { sampleRate: 48000, channels: 2, bitsPerSample: 16 }),
		]);
		expect(plan?.parts.map((p) => p.length)).toEqual([1000]);
		expect(plan?.skipped).toEqual(["b"]);
	});

	it("returns null without usable sources", () => {
		expect(planVirtualWav([])).toBeNull();
	});
});

describe("planReads", () => {
	const plan = planVirtualWav([src("a", 100), src("b", 100, 60)]);
	if (!plan) throw new Error("plan");

	it("reads the header and the first file for a leading range", () => {
		expect(planReads(plan, { start: 0, end: 49 })).toEqual([
			{ kind: "header", start: 0, end: 43 },
			{ kind: "file", path: "a", start: 44, end: 49 },
		]);
	});

	it("spans chunk boundaries with correct file offsets", () => {
		// virtual 140..149 → a[44+96 .. 44+99], b[60 .. 65]
		expect(planReads(plan, { start: 140, end: 149 })).toEqual([
			{ kind: "file", path: "a", start: 140, end: 143 },
			{ kind: "file", path: "b", start: 60, end: 65 },
		]);
	});

	it("serves a tail range from the last file only", () => {
		expect(planReads(plan, { start: 243, end: 243 })).toEqual([
			{ kind: "file", path: "b", start: 159, end: 159 },
		]);
	});
});

describe("createVirtualWavStream", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lr-wav-"));
	afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

	it("streams exactly the requested bytes across files", async () => {
		const a = path.join(dir, "a.bin");
		const b = path.join(dir, "b.bin");
		fs.writeFileSync(a, Buffer.concat([Buffer.alloc(44, 0x21), Buffer.from("AAAAAAAAAA")]));
		fs.writeFileSync(b, Buffer.concat([Buffer.alloc(44, 0x21), Buffer.from("BBBBBBBBBB")]));
		const plan = planVirtualWav([src(a, 10), src(b, 10)]);
		if (!plan) throw new Error("plan");
		const full = await text(createVirtualWavStream(plan, { start: 44, end: plan.totalSize - 1 }));
		expect(full).toBe("AAAAAAAAAABBBBBBBBBB");
		const mid = await text(createVirtualWavStream(plan, { start: 50, end: 57 }));
		expect(mid).toBe("AAAABBBB");
		const head = Buffer.from(
			await new Response(
				createVirtualWavStream(plan, { start: 0, end: 3 }) as unknown as ReadableStream,
			).arrayBuffer(),
		);
		expect(head.toString("ascii")).toBe("RIFF");
	});
});
