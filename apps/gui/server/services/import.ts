import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { EmptyImportError, ImportService, type Session } from "@listening-resume/core";
import type { AppDeps } from "../deps.js";
import { HttpError } from "../http.js";
import { fileExtension, titleFromFilename } from "./filenames.js";

export const DEFAULT_IMPORT_LIMIT = 4 * 1024 ** 3; // 4 GB
/** Upper bound for one ffmpeg conversion (hours of video still convert well within it). */
export const DEFAULT_IMPORT_TIMEOUT_MS = 30 * 60 * 1000;

/** Stream a request body to `dest`, enforcing `limit` bytes. Returns bytes written. */
export async function saveUpload(
	req: http.IncomingMessage,
	dest: string,
	limit: number,
): Promise<number> {
	const declared = Number(req.headers["content-length"]);
	if (Number.isFinite(declared) && declared > limit) {
		req.resume();
		throw new HttpError(413, "Arquivo muito grande");
	}
	let size = 0;
	const counter = new Transform({
		transform(chunk: Buffer, _enc, cb) {
			size += chunk.length;
			if (size > limit) cb(new HttpError(413, "Arquivo muito grande"));
			else cb(null, chunk);
		},
	});
	try {
		await pipeline(req, counter, fs.createWriteStream(dest));
	} catch (err) {
		fs.rmSync(dest, { force: true });
		throw err;
	}
	return size;
}

/**
 * ffmpeg args: any audio/video → mono/stereo 16-bit WAV chunks of `chunkSeconds`.
 * `-protocol_whitelist file,pipe` stops a crafted playlist/concat file (e.g. .m3u8, .ffconcat)
 * from making ffmpeg fetch URLs or open other protocols; `-nostdin` keeps it non-interactive.
 */
export function buildImportArgs(
	input: string,
	outPattern: string,
	fmt: { sampleRate: number; channels: number; chunkSeconds: number },
): string[] {
	return [
		"-hide_banner",
		"-nostdin",
		"-y",
		"-protocol_whitelist",
		"file,pipe",
		"-i",
		input,
		"-vn",
		"-ac",
		String(fmt.channels),
		"-ar",
		String(fmt.sampleRate),
		"-c:a",
		"pcm_s16le",
		"-f",
		"segment",
		"-segment_time",
		String(fmt.chunkSeconds),
		"-reset_timestamps",
		"1",
		outPattern,
	];
}

type Deps = Pick<
	AppDeps,
	| "repo"
	| "storage"
	| "run"
	| "audio"
	| "readWavInfo"
	| "logger"
	| "newId"
	| "now"
	| "importTimeoutMs"
>;

/**
 * Convert an uploaded file into a `stopped` session with WAV chunks at the configured format.
 * Core's `ImportService` owns the session (created as `created` — hidden from lists — and
 * moved to `stopped` once every chunk is registered; nothing is left behind on failure); this
 * only runs ffmpeg into the session's audio dir.
 */
export async function importMedia(
	deps: Deps,
	upload: { path: string; filename: string },
): Promise<Session> {
	const ext = fileExtension(upload.filename);
	const imports = new ImportService({
		repo: deps.repo,
		storage: deps.storage,
		readWavInfo: deps.readWavInfo,
		newId: deps.newId,
		now: deps.now,
	});
	const request = {
		title: titleFromFilename(upload.filename || "importado"),
		audioSource: ext ? `Arquivo importado · .${ext}` : "Arquivo importado",
	};
	try {
		return await imports.importAudio(request, async (audioDir) => {
			const args = buildImportArgs(upload.path, path.join(audioDir, "chunk_%04d.wav"), deps.audio);
			let result: Awaited<ReturnType<typeof deps.run>>;
			try {
				result = await deps.run("ffmpeg", args, {
					timeoutMs: deps.importTimeoutMs ?? DEFAULT_IMPORT_TIMEOUT_MS,
				});
			} catch (err) {
				throw new HttpError(500, `ffmpeg não encontrado: ${(err as Error).message}`);
			}
			if (result.timedOut) {
				throw new HttpError(500, "A conversão do arquivo excedeu o tempo limite");
			}
			if (result.code !== 0) {
				deps.logger.warn(`[import] ffmpeg exit ${result.code}: ${result.stderr.slice(-500)}`);
				throw new HttpError(422, "Não foi possível converter o arquivo (formato não suportado?)");
			}
		});
	} catch (err) {
		if (err instanceof EmptyImportError) throw new HttpError(422, err.message);
		throw err;
	}
}
