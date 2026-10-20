/**
 * Error category, so driving adapters (HTTP server, CLI) can map domain errors without
 * `instanceof` chains: validation → 400, not_found → 404, conflict → 409, internal → 500.
 */
export type DomainErrorKind = "validation" | "not_found" | "conflict" | "internal";

export class DomainError extends Error {
	readonly kind: DomainErrorKind;

	constructor(message: string, kind: DomainErrorKind = "internal") {
		super(message);
		this.name = "DomainError";
		this.kind = kind;
	}
}

export class ValidationError extends DomainError {
	constructor(message: string) {
		super(message, "validation");
		this.name = "ValidationError";
	}
}

export class NotFoundError extends DomainError {
	constructor(message: string) {
		super(message, "not_found");
		this.name = "NotFoundError";
	}
}

export class ConflictError extends DomainError {
	constructor(message: string) {
		super(message, "conflict");
		this.name = "ConflictError";
	}
}

/** Thrown by `RecordingService.start()` when a recording is already active (HTTP 409). */
export class RecordingInProgressError extends ConflictError {
	readonly sessionId: string;

	constructor(sessionId: string) {
		super("Já existe uma gravação em andamento.");
		this.name = "RecordingInProgressError";
		this.sessionId = sessionId;
	}
}

/** Thrown when an operation needs an active recording and there is none (HTTP 409). */
export class NotRecordingError extends ConflictError {
	constructor() {
		super("Nenhuma gravação em andamento.");
		this.name = "NotRecordingError";
	}
}

export class AudioCaptureError extends DomainError {
	constructor(message: string) {
		super(message);
		this.name = "AudioCaptureError";
	}
}

export class TranscriptionError extends DomainError {
	/** True when the message is a raw upstream/provider error (not user-facing pt-BR text). */
	readonly upstream: boolean;

	constructor(message: string, options: { upstream?: boolean } = {}) {
		super(message);
		this.name = "TranscriptionError";
		this.upstream = options.upstream ?? false;
	}
}

export class AnalysisError extends DomainError {
	/** True when the message is a raw upstream/provider error (not user-facing pt-BR text). */
	readonly upstream: boolean;

	constructor(message: string, options: { upstream?: boolean } = {}) {
		super(message);
		this.name = "AnalysisError";
		this.upstream = options.upstream ?? false;
	}
}

export class ConfigError extends DomainError {
	constructor(message: string) {
		super(message, "validation");
		this.name = "ConfigError";
	}
}

export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
