import { ConflictError } from "./errors.js";
import type { SessionStatus } from "./models.js";

/**
 * Session lifecycle:
 *
 *   created → recording → stopped → transcribing → transcribed → analyzing → completed
 *   created → stopped  (import: the converted file's chunks are registered)
 *
 * Re-transcription is allowed from any settled state, (re-)analysis from any settled state
 * that has a transcript (checked by the service), and a `failed` session can be retried. Any
 * working state may fall back when interrupted. Enforced by the application services.
 */
const validTransitions: Record<SessionStatus, readonly SessionStatus[]> = {
	// `created → stopped`: an imported file, once converted and its chunks registered.
	created: ["recording", "stopped", "failed"],
	recording: ["stopped", "failed"],
	stopped: ["transcribing", "analyzing", "failed"],
	transcribing: ["transcribed", "completed", "stopped", "failed"],
	transcribed: ["transcribing", "analyzing", "failed"],
	analyzing: ["completed", "transcribed", "stopped", "failed"],
	completed: ["transcribing", "analyzing", "failed"],
	failed: ["transcribing", "analyzing"],
};

/** pt-BR labels for each status (UI badges, exports). Pure. */
export const SESSION_STATUS_LABELS: Record<SessionStatus, string> = {
	created: "Gravado",
	recording: "Gravando…",
	stopped: "Gravado",
	transcribing: "Transcrevendo…",
	transcribed: "Transcrito",
	analyzing: "Analisando…",
	completed: "Concluído",
	failed: "Falhou",
};

/** Why a session in a working state can't start something else (pt-BR). */
const BUSY_MESSAGES: Partial<Record<SessionStatus, string>> = {
	created: "A gravação desta sessão ainda não começou.",
	recording: "A sessão ainda está sendo gravada.",
	transcribing: "A transcrição desta sessão já está em andamento.",
	analyzing: "Uma análise desta sessão já está em andamento.",
};

export function canTransition(from: SessionStatus, to: SessionStatus): boolean {
	return validTransitions[from].includes(to);
}

/** Throws `ConflictError` (HTTP 409) with a pt-BR reason when `from → to` is not allowed. */
export function assertTransition(from: SessionStatus, to: SessionStatus): void {
	if (canTransition(from, to)) return;
	throw new ConflictError(
		BUSY_MESSAGES[from] ??
			`Transição de estado inválida: ${SESSION_STATUS_LABELS[from]} → ${SESSION_STATUS_LABELS[to]}.`,
	);
}

/** States that only exist while a process is running; stale after a crash/restart. */
export const TRANSIENT_STATUSES: readonly SessionStatus[] = [
	"recording",
	"transcribing",
	"analyzing",
];
