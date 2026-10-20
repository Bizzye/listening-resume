import { describe, expect, it } from "vitest";
import {
	decodeFilenameHeader,
	fileExtension,
	titleFromFilename,
} from "../../../server/services/filenames.js";
import { buildImportArgs } from "../../../server/services/import.js";

describe("import filename handling", () => {
	it("decodes percent-encoded names and strips directories", () => {
		expect(decodeFilenameHeader("Aula%2001%20-%20Introdu%C3%A7%C3%A3o.mp4")).toBe(
			"Aula 01 - Introdução.mp4",
		);
		expect(decodeFilenameHeader("C:\\fakepath\\podcast.mp3")).toBe("podcast.mp3");
		expect(decodeFilenameHeader("../../etc/passwd")).toBe("passwd");
		expect(decodeFilenameHeader("100%.wav")).toBe("100%.wav");
		expect(decodeFilenameHeader(undefined)).toBe("");
		expect(decodeFilenameHeader(["a.mp3", "b.mp3"])).toBe("a.mp3");
	});

	it("extracts a lowercase extension", () => {
		expect(fileExtension("Reunião.M4A")).toBe("m4a");
		expect(fileExtension("noext")).toBe("");
		expect(fileExtension("weird.ex t")).toBe("");
	});

	it("derives a title from the filename", () => {
		expect(titleFromFilename("aula_03_derivadas.mp4")).toBe("aula 03 derivadas");
		expect(titleFromFilename(".mp3")).toBe(".mp3");
		expect(titleFromFilename("")).toBe("Arquivo importado");
	});

	it("builds ffmpeg args for the configured chunk format", () => {
		const args = buildImportArgs("in.mp4", "out/chunk_%04d.wav", {
			sampleRate: 16000,
			channels: 1,
			chunkSeconds: 120,
		});
		expect(args).toEqual(
			expect.arrayContaining(["-i", "in.mp4", "-vn", "-ar", "16000", "-ac", "1", "pcm_s16le"]),
		);
		expect(args.at(-1)).toBe("out/chunk_%04d.wav");
		expect(args[args.indexOf("-segment_time") + 1]).toBe("120");
	});

	it("restricts ffmpeg to local protocols and keeps it non-interactive", () => {
		const args = buildImportArgs("in.m3u8", "out/chunk_%04d.wav", {
			sampleRate: 16000,
			channels: 1,
			chunkSeconds: 120,
		});
		expect(args).toContain("-nostdin");
		const wl = args.indexOf("-protocol_whitelist");
		expect(args[wl + 1]).toBe("file,pipe");
		expect(wl).toBeLessThan(args.indexOf("-i")); // an input option: must precede -i
	});
});
