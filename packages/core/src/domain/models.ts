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
	/** Human-readable description of where the audio came from (pt-BR, shown in the UI). */
	audioSource: string | null;
	language: string;
	createdAt: string;
	/** Per-session export directory override; `null` = use the global default. */
	exportDir: string | null;
	/** Human-readable (pt-BR) reason of the last failure, cleared on the next success. */
	lastError: string | null;
}

/** A session as the API lists it: the row plus data derived from its files (wire type). */
export interface SessionSummary extends Session {
	chunks: number;
	/** Seconds, from the chunks' WAV headers (never from config). */
	duration: number;
	/** Start of the transcript, for the session card. */
	preview: string | null;
	analysesCount: number;
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
	/** Seconds from the start of the session. */
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

/** Language the analysis is written in. */
export type AnalysisLanguage = "pt-BR" | "en";

export interface AnalysisTemplate {
	id: string;
	name: string;
	description: string;
	/** User prompt. Variables: `{transcricao}`, `{titulo}` (legacy `{{transcript}}` also accepted). */
	prompt: string;
	builtin: boolean;
	/** Number of output sections the prompt asks for (display only). */
	sections: number;
	language: "pt-BR";
	createdAt?: string;
	updatedAt?: string;
}

export interface NewTemplate {
	name: string;
	description?: string;
	prompt: string;
}
