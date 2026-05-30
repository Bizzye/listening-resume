import { describe, it, expect, vi, beforeEach } from "vitest";
import { TranscriptionService } from "../../../src/application/transcription.service.js";
import type {
  TranscriberPort,
  TranscribeResult,
} from "../../../src/ports/transcriber.js";
import type { SessionRepository } from "../../../src/ports/repository.js";
import type { AudioChunk, Transcript } from "../../../src/domain/models.js";

describe("TranscriptionService", () => {
  let mockTranscriber: TranscriberPort;
  let mockRepo: SessionRepository;
  let service: TranscriptionService;

  beforeEach(() => {
    mockTranscriber = {
      provider: "test",
      model: "test-model",
      transcribe: vi.fn(),
    };

    mockRepo = {
      createSession: vi.fn(),
      updateSession: vi.fn(),
      getSession: vi.fn(),
      listSessions: vi.fn(),
      addChunk: vi.fn(),
      updateChunk: vi.fn(),
      getChunks: vi.fn(),
      saveTranscript: vi.fn(),
      getTranscript: vi.fn(),
      saveAnalysis: vi.fn(),
      getAnalyses: vi.fn(),
    };

    service = new TranscriptionService(mockTranscriber, mockRepo, {
      requestsPerMinute: 100,
      audioSecondsPerHour: 36000,
    });
  });

  it("transcribes all chunks and merges segments", async () => {
    const chunks: AudioChunk[] = [
      {
        id: "c1",
        sessionId: "s1",
        index: 0,
        path: "/tmp/c1.wav",
        durationMs: 30000,
        sampleRate: 16000,
        status: "recorded",
      },
      {
        id: "c2",
        sessionId: "s1",
        index: 1,
        path: "/tmp/c2.wav",
        durationMs: 30000,
        sampleRate: 16000,
        status: "recorded",
      },
    ];

    vi.mocked(mockRepo.getChunks).mockReturnValue(chunks);
    vi.mocked(mockTranscriber.transcribe)
      .mockResolvedValueOnce({
        segments: [{ start: 0, end: 5, text: "Hello" }],
        fullText: "Hello",
        language: "en",
        duration: 30,
      } as TranscribeResult)
      .mockResolvedValueOnce({
        segments: [{ start: 0, end: 10, text: "World" }],
        fullText: "World",
        language: "en",
        duration: 30,
      } as TranscribeResult);

    const result = await service.transcribeSession("s1", "en");

    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]).toEqual({ start: 0, end: 5, text: "Hello" });
    expect(result.segments[1]).toEqual({ start: 30, end: 40, text: "World" }); // offset by first chunk duration
    expect(result.fullText).toBe("Hello World");
    expect(mockRepo.updateChunk).toHaveBeenCalledTimes(2);
    expect(mockRepo.saveTranscript).toHaveBeenCalledTimes(1);
  });

  it("skips already transcribed chunks", async () => {
    const chunks: AudioChunk[] = [
      {
        id: "c1",
        sessionId: "s1",
        index: 0,
        path: "/tmp/c1.wav",
        durationMs: 30000,
        sampleRate: 16000,
        status: "transcribed",
      },
      {
        id: "c2",
        sessionId: "s1",
        index: 1,
        path: "/tmp/c2.wav",
        durationMs: 30000,
        sampleRate: 16000,
        status: "recorded",
      },
    ];

    vi.mocked(mockRepo.getChunks).mockReturnValue(chunks);
    vi.mocked(mockTranscriber.transcribe).mockResolvedValueOnce({
      segments: [{ start: 0, end: 5, text: "Only second" }],
      fullText: "Only second",
      language: "en",
      duration: 30,
    } as TranscribeResult);

    const result = await service.transcribeSession("s1");

    expect(mockTranscriber.transcribe).toHaveBeenCalledTimes(1);
    expect(result.segments[0].start).toBe(30); // offset by skipped chunk
  });

  it("sets session status to transcribing", async () => {
    vi.mocked(mockRepo.getChunks).mockReturnValue([]);
    await service.transcribeSession("s1");
    expect(mockRepo.updateSession).toHaveBeenCalledWith("s1", {
      status: "transcribing",
    });
  });
});
