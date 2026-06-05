import type { Analysis, AudioChunk, Session, Transcript } from "../domain/models.js";

export interface SessionRepository {
	createSession(session: Session): void;
	updateSession(id: string, data: Partial<Session>): void;
	getSession(id: string): Session | null;
	listSessions(limit?: number): Session[];

	addChunk(chunk: AudioChunk): void;
	updateChunk(id: string, data: Partial<AudioChunk>): void;
	getChunks(sessionId: string): AudioChunk[];

	saveTranscript(transcript: Transcript): void;
	getTranscript(sessionId: string): Transcript | null;

	saveAnalysis(analysis: Analysis): void;
	getAnalyses(sessionId: string): Analysis[];

	deleteSession(id: string): void;
}
