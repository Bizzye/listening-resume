import { randomUUID } from "node:crypto";
import path from "node:path";
import { NotFoundError, TranscriptionError } from "../domain/errors.js";
import type { AudioChunk, Transcript, TranscriptSegment } from "../domain/models.js";
import { assertTransition } from "../domain/states.js";
import type { FileStoragePort } from "../ports/file-storage.js";
import type { SessionRepository } from "../ports/repository.js";
import type { TranscriberPort, TranscriptionProvider } from "../ports/transcriber.js";
import { logger } from "../utils/logger.js";
import { SlidingWindowLimiter } from "../utils/rate-limiter.js";
import { tryReadWavInfo } from "../utils/wav.js";
import { describeFailure } from "./error-messages.js";
import { statusFromArtifacts } from "./session-status.js";

/** A fixed transcriber, or a factory picking one per call (e.g. from the current settings). */
export type TranscriberSource =
	| TranscriberPort
	| ((provider: TranscriptionProvider | undefined) => TranscriberPort);

export interface RateLimits {
	requestsPerMinute: number;
	audioSecondsPerHour: number;
}

export interface TranscribeSessionOptions {
	/** Passed to a factory `TranscriberSource`; ignored for a fixed transcriber. */
	provider?: TranscriptionProvider;
	/** ISO code or "auto" (default). */
	language?: string;
	/** Vocabulary hint for the model. */
	prompt?: string;
}

const FALLBACK_CHUNK_SECONDS = 30;

/**
 * Transcribes every chunk of a session in order, offsets segment times by the real chunk
 * durations, and stores one transcript. Status: → transcribing → transcribed, or on failure →
 * `failed` (first transcription) / back to `transcribed`|`completed` (a re-transcription keeps
 * the previous transcript), always with a pt-BR `lastError`. Groq calls share one
 * sliding-window limiter (RPM + audio seconds/hour).
 */
export class TranscriptionService {
	private readonly limiter: SlidingWindowLimiter;

	/**
	 * @param files optional: lets the service report a missing chunk file up front with a clear
	 *   message (otherwise the transcriber's own error is reported).
	 */
	constructor(
		private readonly transcriber: TranscriberSource,
		private readonly repo: SessionRepository,
		rateLimits: RateLimits,
		private readonly files?: Pick<FileStoragePort, "exists">,
	) {
		this.limiter = new SlidingWindowLimiter(rateLimits);
	}

	async transcribeSession(
		sessionId: string,
		options: TranscribeSessionOptions = {},
	): Promise<Transcript> {
		const session = this.repo.getSession(sessionId);
		if (!session) throw new NotFoundError("Sessão não encontrada.");
		// Throws ConflictError while recording / transcribing / analyzing.
		assertTransition(session.status, "transcribing");

		// Synchronous before the first await: callers see `transcribing` right away.
		this.repo.updateSession(sessionId, { status: "transcribing", lastError: null });
		try {
			const transcript = await this.run(sessionId, options);
			this.repo.saveTranscript(transcript);
			this.repo.updateSession(sessionId, {
				status: "transcribed",
				lastError: null,
				...(session.language === "auto" && transcript.language
					? { language: transcript.language }
					: {}),
			});
			return transcript;
		} catch (err) {
			const message = describeFailure(err, "transcription");
			logger.error(`Transcription of ${sessionId} failed: ${(err as Error).message}`);
			this.repo.updateSession(sessionId, {
				status: statusFromArtifacts(this.repo, sessionId) ?? "failed",
				lastError: message,
			});
			throw new TranscriptionError(message);
		}
	}

	private resolveTranscriber(provider?: TranscriptionProvider): TranscriberPort {
		return typeof this.transcriber === "function" ? this.transcriber(provider) : this.transcriber;
	}

	private async run(sessionId: string, options: TranscribeSessionOptions): Promise<Transcript> {
		const chunks = this.repo.getChunks(sessionId);
		if (chunks.length === 0) {
			throw new TranscriptionError("Nenhum áudio foi gravado nesta sessão.");
		}
		const transcriber = this.resolveTranscriber(options.provider);
		const language = options.language || "auto";

		const segments: TranscriptSegment[] = [];
		let offset = 0;
		let detectedLanguage: string | null = null;

		for (const chunk of chunks) {
			if (this.files && !this.files.exists(chunk.path)) {
				throw new TranscriptionError(
					`Arquivo de áudio não encontrado: ${path.basename(chunk.path)}`,
				);
			}
			const knownDuration = chunkDurationSec(chunk);
			if (transcriber.rateLimited) {
				await this.limiter.waitForSlot(knownDuration ?? FALLBACK_CHUNK_SECONDS);
			}

			logger.info(`Transcribing chunk ${chunk.index} with ${transcriber.provider}...`);
			const result = await transcriber.transcribe(chunk.path, {
				language,
				prompt: options.prompt || undefined,
			});
			for (const seg of result.segments) {
				const text = seg.text.trim();
				if (text) segments.push({ start: seg.start + offset, end: seg.end + offset, text });
			}
			detectedLanguage ??= result.language || null;
			// The file's real duration keeps timestamps aligned even across silent tails.
			offset += knownDuration ?? result.duration;
			this.repo.updateChunk(chunk.id, { status: "transcribed" });
		}

		return {
			id: randomUUID(),
			sessionId,
			segments,
			fullText: segments.map((s) => s.text).join(" "),
			language: language === "auto" ? detectedLanguage : language,
			provider: transcriber.provider,
			model: transcriber.model,
			createdAt: new Date().toISOString(),
		};
	}
}

function chunkDurationSec(chunk: AudioChunk): number | null {
	if (chunk.durationMs !== null && chunk.durationMs > 0) return chunk.durationMs / 1000;
	return tryReadWavInfo(chunk.path)?.durationSec ?? null;
}
