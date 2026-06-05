import fs from "node:fs";
import Groq from "groq-sdk";
import { TranscriptionError } from "../../domain/errors.js";
import type {
	TranscribeOptions,
	TranscribeResult,
	TranscriberPort,
} from "../../ports/transcriber.js";

export class GroqWhisperAdapter implements TranscriberPort {
	private client: Groq;
	readonly provider = "groq";
	readonly model: string;

	constructor(apiKey: string, model = "whisper-large-v3-turbo") {
		this.client = new Groq({ apiKey });
		this.model = model;
	}

	async transcribe(audioPath: string, options?: TranscribeOptions): Promise<TranscribeResult> {
		try {
			const file = fs.createReadStream(audioPath);
			const response = (await this.client.audio.transcriptions.create({
				file,
				model: this.model,
				response_format: "verbose_json",
				language: options?.language === "auto" ? undefined : options?.language,
				prompt: options?.prompt || undefined,
				timestamp_granularities: ["segment"],
			})) as unknown as {
				text: string;
				segments?: { start: number; end: number; text: string }[];
				language?: string;
				duration?: number;
			};

			const segments = (response.segments ?? []).map((seg) => ({
				start: seg.start,
				end: seg.end,
				text: seg.text.trim(),
			}));

			return {
				segments,
				fullText: response.text,
				language: response.language ?? options?.language ?? "unknown",
				duration: response.duration ?? 0,
			};
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "Unknown transcription error";
			throw new TranscriptionError(`Groq transcription failed: ${message}`);
		}
	}
}
