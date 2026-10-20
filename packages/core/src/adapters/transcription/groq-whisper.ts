import fs from "node:fs";
import path from "node:path";
import Groq from "groq-sdk";
import { DEFAULT_GROQ_WHISPER_MODEL } from "../../constants.js";
import { errorMessage, TranscriptionError } from "../../domain/errors.js";
import type {
	TranscribeOptions,
	TranscribeResult,
	TranscriberPort,
} from "../../ports/transcriber.js";

/** Shape of Groq's `verbose_json` response (the SDK types it loosely). */
interface VerboseTranscription {
	text: string;
	segments?: { start: number; end: number; text: string }[];
	language?: string;
	duration?: number;
}

export class GroqWhisperAdapter implements TranscriberPort {
	readonly provider = "groq";
	readonly model: string;
	readonly rateLimited = true;
	private readonly client: Groq;

	constructor(apiKey: string, model = DEFAULT_GROQ_WHISPER_MODEL) {
		this.client = new Groq({ apiKey });
		this.model = model;
	}

	async transcribe(audioPath: string, options?: TranscribeOptions): Promise<TranscribeResult> {
		if (!fs.existsSync(audioPath)) {
			throw new TranscriptionError(`Arquivo de áudio não encontrado: ${path.basename(audioPath)}`);
		}
		let response: VerboseTranscription;
		try {
			response = (await this.client.audio.transcriptions.create({
				file: fs.createReadStream(audioPath),
				model: this.model,
				response_format: "verbose_json",
				language: options?.language === "auto" ? undefined : options?.language,
				prompt: options?.prompt || undefined,
				timestamp_granularities: ["segment"],
			})) as unknown as VerboseTranscription;
		} catch (error: unknown) {
			const status = (error as { status?: number }).status;
			const prefix = status ? `Groq HTTP ${status}` : "Groq";
			throw new TranscriptionError(`${prefix}: ${errorMessage(error)}`, { upstream: true });
		}

		return {
			segments: (response.segments ?? []).map((seg) => ({
				start: seg.start,
				end: seg.end,
				text: seg.text.trim(),
			})),
			fullText: response.text.trim(),
			language: response.language ?? options?.language ?? "unknown",
			duration: response.duration ?? 0,
		};
	}
}
