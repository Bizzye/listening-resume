export { GroqLLMAdapter } from "./adapters/analysis/groq-llm.js";
export { OLLAMA_CHAT_OPTIONS, OllamaAdapter } from "./adapters/analysis/ollama.js";
export {
	type AnalysisProvider,
	type AnalyzerPair,
	selectAnalyzers,
} from "./adapters/analysis/select.js";
export {
	assertDeviceId,
	buildCaptureArgs,
	buildMeterArgs,
	buildToneArgs,
	type CaptureEvent,
	type DeviceChange,
	LineSplitter,
	MAX_DEVICE_ID_LENGTH,
	muteCommand,
	parseCaptureLine,
	switchCommand,
} from "./adapters/audio/capture-protocol.js";
export { createCaptureAdapter, defaultCaptureBackend } from "./adapters/audio/factory.js";
export {
	FAKE_DEVICES,
	FakeCaptureAdapter,
	type FakeCaptureOptions,
} from "./adapters/audio/fake-capture.js";
export {
	buildPulseArgs,
	type CommandRunner,
	FFmpegPulseAdapter,
	type FFmpegPulseAdapterOptions,
	toPulseSource,
} from "./adapters/audio/ffmpeg-pulse.js";
export {
	acknowledgedSources,
	type BinaryLookupContext,
	type DeviceEvent,
	deviceEventMatches,
	findWasapiBinary,
	WASAPI_BINARY_ENV,
	WASAPI_BINARY_NAME,
	WasapiCaptureAdapter,
	type WasapiCaptureAdapterOptions,
	wasapiBinaryCandidates,
} from "./adapters/audio/wasapi-capture.js";
export * from "./adapters/export/export-document.js";
export { MarkdownExporter, renderMarkdown } from "./adapters/export/markdown.js";
export { FakeAnalyzer, type FakeAnalyzerOptions } from "./adapters/fake/fake-analyzer.js";
export {
	FAKE_TRANSCRIPT_LINES,
	FakeTranscriber,
	type FakeTranscriberOptions,
} from "./adapters/fake/fake-transcriber.js";
export { LocalFileStorage } from "./adapters/persistence/local-files.js";
export { SQLiteRepository } from "./adapters/persistence/sqlite.js";
export {
	createTranscriber,
	MISSING_GROQ_KEY_MESSAGE,
	type TranscriberConfig,
	type WhisperModel,
	whisperModelPath,
} from "./adapters/transcription/factory.js";
export { GroqWhisperAdapter } from "./adapters/transcription/groq-whisper.js";
export { parseWhisperCppJson, WhisperCppAdapter } from "./adapters/transcription/whisper-cpp.js";
export * from "./application/analysis.service.js";
export {
	type CaptureWarning,
	DEVICE_FALLBACK_MESSAGE,
	describeCaptureWarning,
	describeFailure,
} from "./application/error-messages.js";
export * from "./application/import.service.js";
export * from "./application/recording.service.js";
export { statusFromArtifacts } from "./application/session-status.js";
export * from "./application/transcription.service.js";
export { loadConfig, resolveDataDir } from "./config/loader.js";
export {
	CONFIG_DIR_ENV,
	defaultDataDir,
	defaultExportDir,
	expandHome,
	resolveConfigDir,
	resolveDocumentsDir,
} from "./config/paths.js";
export {
	type AppConfig,
	analysisConfigSchema,
	appConfigSchema,
	audioConfigSchema,
	rateLimitsConfigSchema,
	storageConfigSchema,
	transcriptionConfigSchema,
} from "./config/schema.js";
export {
	defaultSettings,
	defaultSettingsPath,
	renameWithRetry,
	SETTINGS_FILE_NAME,
	type Settings,
	type SettingsPatch,
	SettingsStore,
	settingsSchema,
} from "./config/settings.js";
export {
	DEFAULT_ANALYSIS_MODEL,
	DEFAULT_CHANNELS,
	DEFAULT_CHUNK_SECONDS,
	DEFAULT_GROQ_LLM_MODEL,
	DEFAULT_GROQ_WHISPER_MODEL,
	DEFAULT_MIC_VOLUME,
	DEFAULT_OLLAMA_HOST,
	DEFAULT_SAMPLE_RATE,
} from "./constants.js";
export * from "./domain/errors.js";
export * from "./domain/models.js";
export * from "./domain/states.js";
export * from "./domain/transcript.js";
export * from "./ports/analyzer.js";
export * from "./ports/audio-capture.js";
export * from "./ports/exporter.js";
export * from "./ports/file-storage.js";
export * from "./ports/repository.js";
export * from "./ports/transcriber.js";
export * from "./templates/index.js";
export { formatDuration, formatTimestamp } from "./utils/format.js";
export { Listeners } from "./utils/listeners.js";
export { type LogLevel, logger, setLogLevel } from "./utils/logger.js";
export {
	ProcessRegistry,
	type ProcessRunner,
	type RunOptions,
	type RunResult,
	run,
	tail,
	waitForExit,
	writeLine,
} from "./utils/process.js";
export { SlidingWindowLimiter } from "./utils/rate-limiter.js";
export { onShutdown, setupSignalHandlers } from "./utils/signal-handler.js";
export * from "./utils/wav.js";
