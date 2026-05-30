import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SQLiteRepository } from "../../src/adapters/persistence/sqlite.js";
import { LocalFileStorage } from "../../src/adapters/persistence/local-files.js";
import { TranscriptionService } from "../../src/application/transcription.service.js";
import { AnalysisService } from "../../src/application/analysis.service.js";
import { MarkdownExporter } from "../../src/adapters/export/markdown.js";
import { getTemplate } from "../../src/templates/index.js";
import type { AudioCapturePort } from "../../src/ports/audio-capture.js";
import type { TranscriberPort, TranscribeResult } from "../../src/ports/transcriber.js";
import type { AnalyzerPort, AnalyzeResult } from "../../src/ports/analyzer.js";
import type { Session, AudioChunk } from "../../src/domain/models.js";
import { v4 as uuid } from "uuid";

const TEST_DIR = path.join(os.tmpdir(), `lr-integration-${Date.now()}`);
const DB_PATH = path.join(TEST_DIR, "test.db");

function createMockTranscriber(): TranscriberPort {
  return {
    provider: "mock",
    model: "mock-v1",
    async transcribe(audioPath: string): Promise<TranscribeResult> {
      return {
        segments: [
          { start: 0, end: 5, text: "Hello world from chunk." },
          { start: 5, end: 10, text: "This is a test recording." },
        ],
        fullText: "Hello world from chunk. This is a test recording.",
        language: "en",
        duration: 10,
      };
    },
  };
}

function createMockAnalyzer(available = true): AnalyzerPort {
  return {
    provider: "mock",
    model: "mock-analysis-v1",
    async analyze(options): Promise<AnalyzeResult> {
      return {
        content: `## Summary\n\nThis is a summary of: ${options.transcript.slice(0, 50)}...`,
        model: "mock-analysis-v1",
        provider: "mock",
        tokensUsed: 100,
      };
    },
    async isAvailable(): Promise<boolean> {
      return available;
    },
  };
}

describe("Full Pipeline Integration", () => {
  let repo: SQLiteRepository;
  let storage: LocalFileStorage;

  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    repo = new SQLiteRepository(DB_PATH);
    storage = new LocalFileStorage(TEST_DIR);
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("record → transcribe → analyze → export", async () => {
    // 1. Simulate a recording session (manually create session + chunks)
    const sessionId = uuid();
    const session: Session = {
      id: sessionId,
      title: null,
      status: "recording",
      startedAt: new Date().toISOString(),
      endedAt: null,
      audioSource: "test-device.monitor",
      language: "en",
      createdAt: new Date().toISOString(),
    };
    repo.createSession(session);

    // Create fake audio chunks
    const chunkDir = path.join(TEST_DIR, "chunks", sessionId);
    fs.mkdirSync(chunkDir, { recursive: true });

    const chunks: AudioChunk[] = [];
    for (let i = 0; i < 3; i++) {
      const chunkPath = path.join(chunkDir, `chunk-${i}.wav`);
      fs.writeFileSync(chunkPath, Buffer.alloc(1024)); // fake audio data
      const chunk: AudioChunk = {
        id: uuid(),
        sessionId,
        index: i,
        path: chunkPath,
        durationMs: 30000,
        sampleRate: 16000,
        status: "recorded",
      };
      repo.addChunk(chunk);
      chunks.push(chunk);
    }

    // Stop recording
    repo.updateSession(sessionId, {
      status: "stopped",
      endedAt: new Date().toISOString(),
    });

    // 2. Transcribe
    const transcriber = createMockTranscriber();
    const transcriptionService = new TranscriptionService(transcriber, repo, {
      requestsPerMinute: 20,
      audioSecondsPerHour: 28800,
    });

    const transcript = await transcriptionService.transcribeSession(
      sessionId,
      "en",
    );

    expect(transcript.segments.length).toBe(6); // 2 segments × 3 chunks
    expect(transcript.fullText).toContain("Hello world");
    expect(transcript.language).toBe("en");

    // Verify saved in DB
    const savedTranscript = repo.getTranscript(sessionId);
    expect(savedTranscript).not.toBeNull();
    expect(savedTranscript!.segments.length).toBe(6);

    // 3. Analyze
    const analyzer = createMockAnalyzer(true);
    const analysisService = new AnalysisService(analyzer, null, repo);

    const template = getTemplate("meeting-summary")!;
    const analysis = await analysisService.analyzeSession(sessionId, template);

    expect(analysis.content).toContain("## Summary");
    expect(analysis.provider).toBe("mock");

    // Verify saved in DB
    const savedAnalyses = repo.getAnalyses(sessionId);
    expect(savedAnalyses.length).toBe(1);
    expect(savedAnalyses[0].templateId).toBe("meeting-summary");

    // 4. Export
    const updatedSession = repo.getSession(sessionId)!;
    const exporter = new MarkdownExporter();
    const markdown = await exporter.export({
      session: updatedSession,
      transcript: savedTranscript,
      analyses: savedAnalyses,
    });

    expect(markdown).toContain("# Session");
    expect(markdown).toContain("Hello world");
    expect(markdown).toContain("## Summary");
  });

  it("analysis fallback works when primary is unavailable", async () => {
    const sessionId = uuid();
    repo.createSession({
      id: sessionId,
      title: null,
      status: "stopped",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      audioSource: "test",
      language: "en",
      createdAt: new Date().toISOString(),
    });

    // Create a chunk + transcribe it first
    const chunkPath = path.join(TEST_DIR, "test-chunk.wav");
    fs.writeFileSync(chunkPath, Buffer.alloc(512));
    repo.addChunk({
      id: uuid(),
      sessionId,
      index: 0,
      path: chunkPath,
      durationMs: 30000,
      sampleRate: 16000,
      status: "recorded",
    });

    const transcriber = createMockTranscriber();
    const transcriptionService = new TranscriptionService(transcriber, repo, {
      requestsPerMinute: 20,
      audioSecondsPerHour: 28800,
    });
    await transcriptionService.transcribeSession(sessionId, "en");

    // Primary analyzer unavailable, fallback available
    const unavailableAnalyzer = createMockAnalyzer(false);
    const fallbackAnalyzer = createMockAnalyzer(true);
    const analysisService = new AnalysisService(
      unavailableAnalyzer,
      fallbackAnalyzer,
      repo,
    );

    const template = getTemplate("meeting-summary")!;
    const analysis = await analysisService.analyzeSession(sessionId, template);

    expect(analysis.content).toContain("## Summary");
  });

  it("multiple analyses on same session", async () => {
    const sessionId = uuid();
    repo.createSession({
      id: sessionId,
      title: null,
      status: "stopped",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      audioSource: "test",
      language: "en",
      createdAt: new Date().toISOString(),
    });

    const chunkPath = path.join(TEST_DIR, "multi-chunk.wav");
    fs.writeFileSync(chunkPath, Buffer.alloc(512));
    repo.addChunk({
      id: uuid(),
      sessionId,
      index: 0,
      path: chunkPath,
      durationMs: 30000,
      sampleRate: 16000,
      status: "recorded",
    });

    const transcriber = createMockTranscriber();
    const transcriptionService = new TranscriptionService(transcriber, repo, {
      requestsPerMinute: 20,
      audioSecondsPerHour: 28800,
    });
    await transcriptionService.transcribeSession(sessionId, "en");

    const analyzer = createMockAnalyzer(true);
    const analysisService = new AnalysisService(analyzer, null, repo);

    const meetingTemplate = getTemplate("meeting-summary")!;
    const actionTemplate = getTemplate("action-items")!;

    await analysisService.analyzeSession(sessionId, meetingTemplate);
    await analysisService.analyzeSession(sessionId, actionTemplate);

    const analyses = repo.getAnalyses(sessionId);
    expect(analyses.length).toBe(2);
    expect(analyses.map((a) => a.templateId).sort()).toEqual([
      "action-items",
      "meeting-summary",
    ]);
  });
});
