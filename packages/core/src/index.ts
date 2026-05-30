// Domain
export * from "./domain/models.js";
export * from "./domain/states.js";
export * from "./domain/errors.js";

// Ports
export * from "./ports/audio-capture.js";
export * from "./ports/transcriber.js";
export * from "./ports/analyzer.js";
export * from "./ports/repository.js";
export * from "./ports/file-storage.js";
export * from "./ports/exporter.js";

// Adapters
export { FFmpegPulseAdapter } from "./adapters/audio/ffmpeg-pulse.js";
export { FFmpegWasapiAdapter } from "./adapters/audio/ffmpeg-wasapi.js";
export { GroqWhisperAdapter } from "./adapters/transcription/groq-whisper.js";
export { WhisperCppAdapter } from "./adapters/transcription/whisper-cpp.js";
export { OllamaAdapter } from "./adapters/analysis/ollama.js";
export { GroqLLMAdapter } from "./adapters/analysis/groq-llm.js";
export { SQLiteRepository } from "./adapters/persistence/sqlite.js";
export { LocalFileStorage } from "./adapters/persistence/local-files.js";
export { MarkdownExporter } from "./adapters/export/markdown.js";

// Application Services
export { RecordingService } from "./application/recording.service.js";
export { TranscriptionService } from "./application/transcription.service.js";
export { AnalysisService } from "./application/analysis.service.js";

// Config
export { loadConfig, resolveDataDir } from "./config/loader.js";
export {
  appConfigSchema,
  audioConfigSchema,
  transcriptionConfigSchema,
  analysisConfigSchema,
  rateLimitsConfigSchema,
  storageConfigSchema,
} from "./config/schema.js";
export type { AppConfig } from "./config/schema.js";

// Utils
export { logger } from "./utils/logger.js";
export { SlidingWindowLimiter } from "./utils/rate-limiter.js";
export { setupSignalHandlers, onShutdown } from "./utils/signal-handler.js";

// Templates
export { getTemplate, listTemplates } from "./templates/index.js";
export { ANALYSIS_SYSTEM_PROMPT } from "./ports/analyzer.js";
