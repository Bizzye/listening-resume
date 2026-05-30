import { describe, it, expect } from "vitest";
import { MarkdownExporter } from "../../../src/adapters/export/markdown.js";
import type {
  Session,
  Transcript,
  Analysis,
} from "../../../src/domain/models.js";

describe("MarkdownExporter", () => {
  const exporter = new MarkdownExporter();

  const mockSession: Session = {
    id: "test-session-123",
    title: "Team Standup",
    status: "completed",
    startedAt: "2024-01-15T10:00:00Z",
    endedAt: "2024-01-15T10:30:00Z",
    audioSource: "default.monitor",
    language: "en",
    createdAt: "2024-01-15T10:00:00Z",
  };

  const mockTranscript: Transcript = {
    id: "transcript-1",
    sessionId: "test-session-123",
    segments: [
      { start: 0, end: 5, text: "Hello everyone." },
      { start: 5, end: 15, text: "Let's discuss the sprint." },
      { start: 60, end: 70, text: "Any blockers?" },
    ],
    fullText: "Hello everyone. Let's discuss the sprint. Any blockers?",
    language: "en",
    provider: "groq",
    model: "whisper-large-v3-turbo",
    createdAt: "2024-01-15T10:31:00Z",
  };

  const mockAnalysis: Analysis = {
    id: "analysis-1",
    sessionId: "test-session-123",
    templateId: "meeting-summary",
    provider: "ollama",
    model: "llama3.1:8b",
    content: "This was a brief standup meeting.",
    createdAt: "2024-01-15T10:32:00Z",
  };

  it("exports session with transcript and analysis", async () => {
    const result = await exporter.export({
      session: mockSession,
      transcript: mockTranscript,
      analyses: [mockAnalysis],
    });

    expect(result).toContain("# Team Standup");
    expect(result).toContain("**Date**: 2024-01-15T10:00:00Z");
    expect(result).toContain("## Transcription");
    expect(result).toContain("**[0:00]** Hello everyone.");
    expect(result).toContain("**[0:05]** Let's discuss the sprint.");
    expect(result).toContain("**[1:00]** Any blockers?");
    expect(result).toContain("## meeting-summary");
    expect(result).toContain("This was a brief standup meeting.");
  });

  it("exports session without transcript", async () => {
    const result = await exporter.export({
      session: mockSession,
      transcript: null,
      analyses: [],
    });

    expect(result).toContain("# Team Standup");
    expect(result).not.toContain("## Transcription");
  });

  it("uses 'Session' as title when title is null", async () => {
    const result = await exporter.export({
      session: { ...mockSession, title: null },
      transcript: null,
      analyses: [],
    });

    expect(result).toContain("# Session");
  });
});
