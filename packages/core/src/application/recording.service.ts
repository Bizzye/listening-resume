import { v4 as uuid } from "uuid";
import { statSync } from "node:fs";
import type { AudioCapturePort, ChunkInfo } from "../ports/audio-capture.js";
import type { SessionRepository } from "../ports/repository.js";
import type { FileStoragePort } from "../ports/file-storage.js";
import type { AudioChunk, Session } from "../domain/models.js";
import { assertTransition } from "../domain/states.js";
import { logger } from "../utils/logger.js";

export class RecordingService {
  constructor(
    private capture: AudioCapturePort,
    private repo: SessionRepository,
    private storage: FileStoragePort,
  ) {}

  async startRecording(
    device: string,
    config: {
      sampleRate: number;
      channels: number;
      chunkSeconds: number;
      micDevice?: string;
      micVolume?: number;
    },
  ): Promise<Session> {
    const sessionId = uuid();
    const now = new Date().toISOString();

    const session: Session = {
      id: sessionId,
      title: null,
      status: "created",
      startedAt: now,
      endedAt: null,
      audioSource: device,
      language: "auto",
      createdAt: now,
    };

    this.repo.createSession(session);
    assertTransition("created", "recording");
    this.repo.updateSession(sessionId, { status: "recording" });

    const sessionDir = this.storage.getSessionDir(sessionId);
    const audioDir = `${sessionDir}/audio`;
    await this.storage.ensureDir(audioDir);

    this.capture.onChunkReady((info) => {
      // Calculate actual duration from WAV file size (16-bit PCM)
      let durationMs: number;
      try {
        const fileSize = statSync(info.path).size;
        const bytesPerSecond = config.sampleRate * config.channels * 2;
        durationMs = Math.round(((fileSize - 44) / bytesPerSecond) * 1000);
      } catch {
        durationMs = config.chunkSeconds * 1000;
      }

      const chunk: AudioChunk = {
        id: uuid(),
        sessionId,
        index: info.index,
        path: info.path,
        durationMs,
        sampleRate: config.sampleRate,
        status: "recorded",
      };
      this.repo.addChunk(chunk);
      logger.info(`Chunk ${info.index} saved: ${info.path}`);
    });

    await this.capture.startCapture({
      device,
      micDevice: config.micDevice,
      micVolume: config.micVolume,
      sampleRate: config.sampleRate,
      channels: config.channels,
      chunkSeconds: config.chunkSeconds,
      outputDir: audioDir,
      filenamePrefix: "chunk",
    });

    session.status = "recording";
    return session;
  }

  async stopRecording(sessionId: string): Promise<ChunkInfo[]> {
    const chunks = await this.capture.stopCapture();
    const now = new Date().toISOString();

    this.repo.updateSession(sessionId, {
      status: "stopped",
      endedAt: now,
    });

    logger.info(`Recording stopped. ${chunks.length} chunks saved.`);
    return chunks;
  }
}
