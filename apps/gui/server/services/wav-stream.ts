import fs from "node:fs";
import { Readable } from "node:stream";
import { buildWavHeader } from "@listening-resume/core";

/** Subset of core's `readWavInfo` result that the virtual stream needs. */
export interface WavInfoLike {
	sampleRate: number;
	channels: number;
	bitsPerSample: number;
	dataBytes: number;
	dataOffset: number;
}

export interface WavSource {
	path: string;
	info: WavInfoLike;
}

interface FilePart {
	path: string;
	/** Byte offset of the PCM data inside the file. */
	fileOffset: number;
	length: number;
	/** Offset of this part inside the virtual file. */
	virtualStart: number;
}

export interface VirtualWav {
	header: Buffer;
	parts: FilePart[];
	totalSize: number;
	durationSec: number;
	/** Sources skipped because their format differs from the first chunk. */
	skipped: string[];
}

export const WAV_HEADER_SIZE = 44;

/**
 * Plan a single WAV that virtually concatenates the PCM data of every chunk under one header.
 * All chunks must share the first chunk's format (the capture binary writes a fixed output
 * format); mismatching chunks are skipped rather than producing garbage audio.
 */
export function planVirtualWav(sources: WavSource[]): VirtualWav | null {
	const usable = sources.filter(
		(s) => s.info.sampleRate > 0 && s.info.channels > 0 && s.info.bitsPerSample > 0,
	);
	const first = usable[0];
	if (!first) return null;
	const fmt = first.info;
	const blockAlign = fmt.channels * Math.ceil(fmt.bitsPerSample / 8);
	const parts: FilePart[] = [];
	const skipped: string[] = [];
	let cursor = WAV_HEADER_SIZE;
	for (const s of usable) {
		const i = s.info;
		if (
			i.sampleRate !== fmt.sampleRate ||
			i.channels !== fmt.channels ||
			i.bitsPerSample !== fmt.bitsPerSample
		) {
			skipped.push(s.path);
			continue;
		}
		// Never split a sample frame across chunk boundaries.
		const length = i.dataBytes - (i.dataBytes % blockAlign);
		if (length <= 0) continue;
		parts.push({ path: s.path, fileOffset: i.dataOffset, length, virtualStart: cursor });
		cursor += length;
	}
	const dataBytes = cursor - WAV_HEADER_SIZE;
	return {
		// RIFF sizes are 32-bit; clamp so huge sessions still produce a playable header.
		header: buildWavHeader(fmt, Math.min(dataBytes, 0xffffffff - 36)),
		parts,
		totalSize: cursor,
		durationSec: dataBytes / (fmt.sampleRate * blockAlign),
		skipped,
	};
}

export type ByteRange = { start: number; end: number };

/**
 * Parse an HTTP `Range` header against a resource of `total` bytes.
 * Returns `null` when absent/ignorable (serve the full body), `"unsatisfiable"` for 416,
 * or an inclusive byte range. Multi-range requests are served as their first range.
 */
export function parseRange(
	header: string | undefined,
	total: number,
): ByteRange | "unsatisfiable" | null {
	if (!header) return null;
	const m = /^bytes=\s*(\d*)\s*-\s*(\d*)/i.exec(header.trim());
	if (!m) return null;
	const [, a, b] = m;
	if (!a && !b) return null;
	if (total <= 0) return "unsatisfiable";
	let start: number;
	let end: number;
	if (!a) {
		// suffix range: last N bytes
		const n = Number(b);
		if (n <= 0) return "unsatisfiable";
		start = Math.max(0, total - n);
		end = total - 1;
	} else {
		start = Number(a);
		// RFC 9110 §14.1.1: last-pos < first-pos is invalid syntax → ignore the header (200).
		if (b && Number(b) < start) return null;
		if (start >= total) return "unsatisfiable";
		end = b ? Math.min(Number(b), total - 1) : total - 1;
	}
	return { start, end };
}

export type ReadPlanItem =
	| { kind: "header"; start: number; end: number }
	| { kind: "file"; path: string; start: number; end: number };

/** Map an inclusive virtual byte range to concrete header/file reads (inclusive offsets). */
export function planReads(plan: VirtualWav, range: ByteRange): ReadPlanItem[] {
	const items: ReadPlanItem[] = [];
	const { start, end } = range;
	if (start < WAV_HEADER_SIZE) {
		items.push({ kind: "header", start, end: Math.min(end, WAV_HEADER_SIZE - 1) });
	}
	for (const p of plan.parts) {
		const pEnd = p.virtualStart + p.length - 1;
		if (pEnd < start || p.virtualStart > end) continue;
		const from = Math.max(start, p.virtualStart) - p.virtualStart;
		const to = Math.min(end, pEnd) - p.virtualStart;
		items.push({ kind: "file", path: p.path, start: p.fileOffset + from, end: p.fileOffset + to });
	}
	return items;
}

/** Stream the bytes of a virtual range sequentially. */
export function createVirtualWavStream(plan: VirtualWav, range: ByteRange): Readable {
	const items = planReads(plan, range);
	async function* generate() {
		for (const item of items) {
			if (item.kind === "header") {
				yield plan.header.subarray(item.start, item.end + 1);
			} else {
				const stream = fs.createReadStream(item.path, { start: item.start, end: item.end });
				for await (const chunk of stream) yield chunk as Buffer;
			}
		}
	}
	return Readable.from(generate());
}
