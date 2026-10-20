import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TranscriptionError } from "../../domain/errors.js";
import type { TranscriptSegment } from "../../domain/models.js";
import type {
	TranscribeOptions,
	TranscribeResult,
	TranscriberPort,
} from "../../ports/transcriber.js";
import { run, tail } from "../../utils/process.js";
import { tryReadWavInfo } from "../../utils/wav.js";

interface WhisperCppJson {
	result?: { language?: string };
	transcription?: { offsets: { from: number; to: number }; text: string }[];
}

/** Parses whisper.cpp's `-oj` output. Pure. */
export function parseWhisperCppJson(json: WhisperCppJson): {
	segments: TranscriptSegment[];
	language: string | null;
} {
	const segments = (json.transcription ?? [])
		.map((seg) => ({
			start: seg.offsets.from / 1000,
			end: seg.offsets.to / 1000,
			text: seg.text.trim(),
		}))
		.filter((seg) => seg.text.length > 0);
	return { segments, language: json.result?.language ?? null };
}

/**
 * Local transcription with the whisper.cpp CLI (`whisper-cli`). Input must be 16 kHz WAV —
 * the capture's default output format.
 */
export class WhisperCppAdapter implements TranscriberPort {
	readonly provider = "whisper-cpp";
	readonly rateLimited = false;

	constructor(
		private readonly binaryPath: string,
		private readonly modelPath: string,
		readonly model = "medium",
	) {}

	async transcribe(audioPath: string, options?: TranscribeOptions): Promise<TranscribeResult> {
		if (!fs.existsSync(this.modelPath)) {
			throw new TranscriptionError(`Modelo do Whisper não encontrado: ${this.modelPath}`);
		}
		if (!fs.existsSync(audioPath)) {
			throw new TranscriptionError(`Arquivo de áudio não encontrado: ${path.basename(audioPath)}`);
		}
		const outBase = path.join(
			os.tmpdir(),
			`lr-whisper-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		);
		const args = ["-m", this.modelPath, "-f", audioPath, "-oj", "-of", outBase, "-np"];
		args.push("-l", options?.language || "auto");
		if (options?.prompt) args.push("--prompt", options.prompt);

		let result: Awaited<ReturnType<typeof run>>;
		try {
			result = await run(this.binaryPath, args, 60 * 60 * 1000);
		} catch {
			throw new TranscriptionError(`whisper.cpp não encontrado em: ${this.binaryPath}`);
		}
		const jsonPath = `${outBase}.json`;
		try {
			if (result.code !== 0) {
				throw new TranscriptionError(
					`whisper.cpp falhou (código ${result.code}): ${tail(result.stderr)}`,
				);
			}
			let parsed: WhisperCppJson;
			try {
				parsed = JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as WhisperCppJson;
			} catch (err) {
				throw new TranscriptionError(`Saída do whisper.cpp ilegível: ${(err as Error).message}`);
			}
			const { segments, language } = parseWhisperCppJson(parsed);
			return {
				segments,
				fullText: segments.map((s) => s.text).join(" "),
				language: language ?? options?.language ?? "auto",
				duration: tryReadWavInfo(audioPath)?.durationSec ?? segments.at(-1)?.end ?? 0,
			};
		} finally {
			fs.rmSync(jsonPath, { force: true });
		}
	}
}
