export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainError";
  }
}

export class AudioCaptureError extends DomainError {
  constructor(message: string) {
    super(message);
    this.name = "AudioCaptureError";
  }
}

export class TranscriptionError extends DomainError {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptionError";
  }
}

export class AnalysisError extends DomainError {
  constructor(message: string) {
    super(message);
    this.name = "AnalysisError";
  }
}

export class ConfigError extends DomainError {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export class RateLimitError extends DomainError {
  public retryAfterMs: number;
  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}
