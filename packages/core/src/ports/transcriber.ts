import type { TranscriptSegment } from "../domain/models.js";

export type TranscriptionProvider = "groq" | "whisper-cpp";

export interface TranscribeOptions {
	/** ISO code or "auto". */
	language?: string;
	prompt?: string;
}

export interface TranscribeResult {
	/** Segment times relative to the start of the file. */
	segments: TranscriptSegment[];
	fullText: string;
	language: string;
	/** Audio duration in seconds as reported by the provider (0 when unknown). */
	duration: number;
}

export interface TranscriberPort {
	readonly provider: string;
	readonly model: string;
	/** Whether calls count against the Groq quotas (rate-limited by the service). */
	readonly rateLimited: boolean;
	transcribe(audioPath: string, options?: TranscribeOptions): Promise<TranscribeResult>;
}
