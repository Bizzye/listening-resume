import fs from "node:fs";

/**
 * WAV (RIFF) helpers. Durations must come from the file itself — never from config — and a
 * header can be stale (data size 0 or wrong) when the writer was killed before finalizing, so
 * the data size is reconciled against the real file size.
 */

export interface WavFormat {
	sampleRate: number;
	channels: number;
	bitsPerSample: number;
}

export interface WavInfo extends WavFormat {
	/** Usable PCM bytes (block-aligned). */
	dataBytes: number;
	/** Byte offset of the first PCM sample. */
	dataOffset: number;
	durationSec: number;
	/** True when the header's data size disagreed with the file and was corrected. */
	headerStale: boolean;
}

/** Bytes inspected for chunks preceding `data` (fmt, LIST, fact, …). */
const HEADER_PROBE_BYTES = 64 * 1024;
const RIFF_HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;
export const PCM_HEADER_BYTES = 44;

type ReadAt = (offset: number, length: number) => Buffer;

/**
 * Whether `probe` (the bytes right after the declared data end) looks like a real trailing RIFF
 * chunk: a printable 4-char id and, when the size field is visible, a size that fits in the
 * `remaining` bytes. Audio samples rarely pass both checks.
 */
function isPlausibleChunk(probe: Buffer, remaining: number): boolean {
	if (probe.length < 4) return false;
	for (let i = 0; i < 4; i++) {
		const c = probe[i];
		if (c < 0x20 || c > 0x7e) return false;
	}
	if (probe.length < CHUNK_HEADER_BYTES) return true;
	return CHUNK_HEADER_BYTES + probe.readUInt32LE(4) <= remaining;
}

/**
 * Pure parser. `header` holds at least the bytes up to the start of the `data` payload;
 * `readAt` (optional) lets it peek past the declared data end to tell a stale size from a
 * trailing chunk.
 */
export function parseWavHeader(header: Buffer, fileSize: number, readAt?: ReadAt): WavInfo {
	if (
		header.length < RIFF_HEADER_BYTES ||
		header.toString("ascii", 0, 4) !== "RIFF" ||
		header.toString("ascii", 8, 12) !== "WAVE"
	) {
		throw new Error("Not a RIFF/WAVE file");
	}

	let format: WavFormat | null = null;
	let pos = RIFF_HEADER_BYTES;
	while (pos + CHUNK_HEADER_BYTES <= header.length) {
		const id = header.toString("ascii", pos, pos + 4);
		const size = header.readUInt32LE(pos + 4);
		const body = pos + CHUNK_HEADER_BYTES;

		if (id === "fmt ") {
			if (body + 16 > header.length) break;
			format = {
				channels: header.readUInt16LE(body + 2),
				sampleRate: header.readUInt32LE(body + 4),
				bitsPerSample: header.readUInt16LE(body + 14),
			};
		} else if (id === "data") {
			if (!format) throw new Error("WAV data chunk before fmt chunk");
			return resolveData(format, body, size, fileSize, readAt);
		}
		pos = body + size + (size % 2);
	}
	throw new Error(format ? "WAV data chunk not found" : "WAV fmt chunk not found");
}

function resolveData(
	format: WavFormat,
	dataOffset: number,
	declared: number,
	fileSize: number,
	readAt?: ReadAt,
): WavInfo {
	const { sampleRate, channels, bitsPerSample } = format;
	const blockAlign = channels * Math.ceil(bitsPerSample / 8);
	if (sampleRate <= 0 || blockAlign <= 0) throw new Error("Invalid WAV format");

	const available = Math.max(0, fileSize - dataOffset);
	let dataBytes = declared;
	let headerStale = false;
	if (declared === 0 || declared === 0xffffffff || declared > available) {
		dataBytes = available;
		headerStale = declared !== available;
	} else if (declared < available) {
		// Bytes after the declared end: either a real trailing chunk (LIST…) or audio the
		// writer appended without updating the header.
		const next = declared + (declared % 2);
		const remaining = available - next;
		const probe =
			readAt && remaining >= 4
				? readAt(dataOffset + next, Math.min(CHUNK_HEADER_BYTES, remaining))
				: null;
		if (probe && !isPlausibleChunk(probe, remaining)) {
			dataBytes = available;
			headerStale = true;
		}
	}
	dataBytes -= dataBytes % blockAlign;
	return {
		...format,
		dataOffset,
		dataBytes,
		durationSec: dataBytes / (sampleRate * blockAlign),
		headerStale,
	};
}

/** Reads and validates a WAV file's header. Throws when the file isn't a usable WAV. */
export function readWavInfo(filePath: string): WavInfo {
	const fd = fs.openSync(filePath, "r");
	try {
		const fileSize = fs.fstatSync(fd).size;
		const header = Buffer.alloc(Math.min(fileSize, HEADER_PROBE_BYTES));
		fs.readSync(fd, header, 0, header.length, 0);
		const readAt: ReadAt = (offset, length) => {
			const buf = Buffer.alloc(length);
			const n = fs.readSync(fd, buf, 0, length, offset);
			return buf.subarray(0, n);
		};
		return parseWavHeader(header, fileSize, readAt);
	} finally {
		fs.closeSync(fd);
	}
}

export function tryReadWavInfo(filePath: string): WavInfo | null {
	try {
		return readWavInfo(filePath);
	} catch {
		return null;
	}
}

/** Sum of the durations (seconds) of the given WAV files; unreadable files count as 0. */
export function totalWavDurationSec(filePaths: readonly string[]): number {
	let total = 0;
	for (const p of filePaths) total += tryReadWavInfo(p)?.durationSec ?? 0;
	return total;
}

/** Canonical 44-byte PCM header. */
export function buildWavHeader(format: WavFormat, dataBytes: number): Buffer {
	const { sampleRate, channels, bitsPerSample } = format;
	const blockAlign = channels * Math.ceil(bitsPerSample / 8);
	const buf = Buffer.alloc(PCM_HEADER_BYTES);
	buf.write("RIFF", 0, "ascii");
	buf.writeUInt32LE(36 + dataBytes, 4);
	buf.write("WAVE", 8, "ascii");
	buf.write("fmt ", 12, "ascii");
	buf.writeUInt32LE(16, 16);
	buf.writeUInt16LE(1, 20); // PCM
	buf.writeUInt16LE(channels, 22);
	buf.writeUInt32LE(sampleRate, 24);
	buf.writeUInt32LE(sampleRate * blockAlign, 28);
	buf.writeUInt16LE(blockAlign, 32);
	buf.writeUInt16LE(bitsPerSample, 34);
	buf.write("data", 36, "ascii");
	buf.writeUInt32LE(dataBytes, 40);
	return buf;
}

/** Writes (or overwrites) the canonical header at the start of an open file. */
export function writeWavHeader(fd: number, format: WavFormat, dataBytes: number): void {
	fs.writeSync(fd, buildWavHeader(format, dataBytes), 0, PCM_HEADER_BYTES, 0);
}

/** A complete 16-bit PCM WAV file from interleaved samples. */
export function createWav(samples: Int16Array, format: Omit<WavFormat, "bitsPerSample">): Buffer {
	const pcm = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
	return Buffer.concat([buildWavHeader({ ...format, bitsPerSample: 16 }, pcm.length), pcm]);
}

/** Converts -1..1 floats to clamped 16-bit PCM. */
export function floatToPcm16(samples: Float32Array | readonly number[]): Int16Array {
	const out = new Int16Array(samples.length);
	for (let i = 0; i < samples.length; i++) {
		const v = Math.max(-1, Math.min(1, samples[i]));
		out[i] = Math.round(v < 0 ? v * 0x8000 : v * 0x7fff);
	}
	return out;
}

/**
 * Fixes the size fields of a WAV left with a stale header (e.g. capture killed mid-chunk) so
 * every player reads the full audio. Returns true when the file was rewritten.
 */
export function repairWavHeader(filePath: string): boolean {
	const info = readWavInfo(filePath);
	if (!info.headerStale) return false;
	const fd = fs.openSync(filePath, "r+");
	try {
		const riffSize = Buffer.alloc(4);
		riffSize.writeUInt32LE(info.dataOffset + info.dataBytes - 8);
		fs.writeSync(fd, riffSize, 0, 4, 4);
		const dataSize = Buffer.alloc(4);
		dataSize.writeUInt32LE(info.dataBytes);
		fs.writeSync(fd, dataSize, 0, 4, info.dataOffset - 4);
	} finally {
		fs.closeSync(fd);
	}
	return true;
}
