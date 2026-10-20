import type {
	Analysis,
	AnalysisTemplate,
	AudioChunk,
	NewTemplate,
	Session,
	SessionStatus,
	Transcript,
} from "../domain/models.js";

export interface ListSessionsOptions {
	/** Default 50. */
	limit?: number;
	/** Case-insensitive search over title and transcript text. */
	query?: string;
}

export type SessionUpdate = Partial<Omit<Session, "id" | "createdAt">>;

export interface SessionRepository {
	createSession(session: Session): void;
	updateSession(id: string, data: SessionUpdate): void;
	getSession(id: string): Session | null;
	/** Exact id, or the single session whose id starts with `prefix` (null if none/ambiguous). */
	findSessionByIdPrefix(prefix: string): Session | null;
	/** Newest first. */
	listSessions(options?: ListSessionsOptions): Session[];
	findSessionsByStatus(statuses: readonly SessionStatus[]): Session[];
	deleteSession(id: string): void;

	/** Returns false (and writes nothing) when the session already has a chunk at that path. */
	addChunk(chunk: AudioChunk): boolean;
	updateChunk(id: string, data: Partial<Pick<AudioChunk, "status" | "durationMs">>): void;
	/** Ordered by index. */
	getChunks(sessionId: string): AudioChunk[];

	/** Replaces any previous transcript of the session. */
	saveTranscript(transcript: Transcript): void;
	getTranscript(sessionId: string): Transcript | null;

	saveAnalysis(analysis: Analysis): void;
	/** Oldest first. */
	getAnalyses(sessionId: string): Analysis[];
	countAnalyses(sessionId: string): number;
	/** Returns false when not found. */
	deleteAnalysis(id: string): boolean;

	/** Built-ins first, then custom templates (oldest first). */
	listTemplates(): AnalysisTemplate[];
	/** Resolves legacy ids (`meeting-summary`, `action-items`). */
	getTemplate(id: string): AnalysisTemplate | null;
	createTemplate(data: NewTemplate): AnalysisTemplate;
	/** Throws `NotFoundError` / `ValidationError` (built-ins are read-only). */
	updateTemplate(id: string, data: Partial<NewTemplate>): AnalysisTemplate;
	/** Throws `NotFoundError` / `ValidationError` (built-ins cannot be deleted). */
	deleteTemplate(id: string): void;
}
