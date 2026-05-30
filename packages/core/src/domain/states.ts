import type { SessionStatus } from "./models.js";

const validTransitions: Record<SessionStatus, SessionStatus[]> = {
  created: ["recording"],
  recording: ["stopped", "failed"],
  stopped: ["transcribing", "failed"],
  transcribing: ["transcribed", "failed"],
  transcribed: ["analyzing", "failed"],
  analyzing: ["completed", "failed"],
  completed: ["analyzing"],
  failed: [],
};

export function canTransition(from: SessionStatus, to: SessionStatus): boolean {
  return validTransitions[from].includes(to);
}

export function assertTransition(from: SessionStatus, to: SessionStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid state transition: ${from} → ${to}`);
  }
}
