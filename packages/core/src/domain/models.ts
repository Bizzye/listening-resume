export type SessionStatus =
  | "created"
  | "recording"
  | "stopped"
  | "transcribing"
  | "transcribed"
  | "analyzing"
  | "completed"
  | "failed";

export type ChunkStatus = "recording" | "recorded" | "transcribed" | "failed";

export interface Session {
  id: string;
  title: string | null;
  status: SessionStatus;
  startedAt: string | null;
  endedAt: string | null;
  audioSource: string | null;
  language: string;
  createdAt: string;
}

export interface AudioChunk {
  id: string;
  sessionId: string;
  index: number;
  path: string;
  durationMs: number | null;
  sampleRate: number;
  status: ChunkStatus;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface Transcript {
  id: string;
  sessionId: string;
  segments: TranscriptSegment[];
  fullText: string;
  language: string | null;
  provider: string;
  model: string;
  createdAt: string;
}

export interface Analysis {
  id: string;
  sessionId: string;
  templateId: string;
  provider: string;
  model: string;
  content: string;
  createdAt: string;
}
