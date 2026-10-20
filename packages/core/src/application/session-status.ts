import type { SessionStatus } from "../domain/models.js";
import type { SessionRepository } from "../ports/repository.js";

/**
 * The settled status a session's stored artifacts justify: `completed` with analyses,
 * `transcribed` with only a transcript, `null` without a transcript. Used to fall back after an
 * interrupted/failed re-transcription or analysis without losing earlier results.
 */
export function statusFromArtifacts(
	repo: Pick<SessionRepository, "getTranscript" | "countAnalyses">,
	sessionId: string,
): Extract<SessionStatus, "completed" | "transcribed"> | null {
	if (!repo.getTranscript(sessionId)) return null;
	return repo.countAnalyses(sessionId) > 0 ? "completed" : "transcribed";
}
