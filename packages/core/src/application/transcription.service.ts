import { v4 as uuid } from "uuid";
import type { TranscriberPort } from "../ports/transcriber.js";
import type { SessionRepository } from "../ports/repository.js";
import type { Transcript, TranscriptSegment } from "../domain/models.js";
import { SlidingWindowLimiter } from "../utils/rate-limiter.js";
import { logger } from "../utils/logger.js";

export class TranscriptionService {
  private rateLimiter: SlidingWindowLimiter;

  constructor(
    private transcriber: TranscriberPort,
    private repo: SessionRepository,
    rateLimits: { requestsPerMinute: number; audioSecondsPerHour: number },
  ) {
    this.rateLimiter = new SlidingWindowLimiter(rateLimits);
  }

  async transcribeSession(
    sessionId: string,
    language?: string,
    prompt?: string,
  ): Promise<Transcript> {
    this.repo.updateSession(sessionId, { status: "transcribing" });

    const chunks = this.repo.getChunks(sessionId);
    const allSegments: TranscriptSegment[] = [];
    let offset = 0;

    for (const chunk of chunks) {
      if (chunk.status === "transcribed") {
        offset += (chunk.durationMs ?? 0) / 1000;
        continue;
      }

      const durationSec = (chunk.durationMs ?? 30000) / 1000;
      await this.rateLimiter.waitForSlot(durationSec);

      logger.info(`Transcribing chunk ${chunk.index}...`);
      const result = await this.transcriber.transcribe(chunk.path, {
        language,
        prompt,
      });

      const offsetSegments = result.segments.map((seg) => ({
        start: seg.start + offset,
        end: seg.end + offset,
        text: seg.text,
      }));

      allSegments.push(...offsetSegments);
      offset += result.duration;
      this.repo.updateChunk(chunk.id, { status: "transcribed" });
    }

    const fullText = allSegments.map((s) => s.text).join(" ");

    const transcript: Transcript = {
      id: uuid(),
      sessionId,
      segments: allSegments,
      fullText,
      language: language ?? "auto",
      provider: this.transcriber.provider,
      model: this.transcriber.model,
      createdAt: new Date().toISOString(),
    };

    this.repo.saveTranscript(transcript);
    return transcript;
  }
}
