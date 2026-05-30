import type { TranscriptSegment } from "../domain/models.js";

export interface TranscribeOptions {
  language?: string;
  model?: string;
  prompt?: string;
}

export interface TranscribeResult {
  segments: TranscriptSegment[];
  fullText: string;
  language: string;
  duration: number;
}

export interface TranscriberPort {
  transcribe(
    audioPath: string,
    options?: TranscribeOptions,
  ): Promise<TranscribeResult>;
  readonly provider: string;
  readonly model: string;
}
