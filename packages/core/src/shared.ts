/**
 * Browser-safe entry (`@listening-resume/core/shared`): pure constants, types and helpers with
 * no Node imports, for the GUI frontend bundle. Everything here is also exported from the main
 * (Node-only) entry.
 */

export type { Settings } from "./config/settings.js";
export * from "./constants.js";
export type {
	Analysis,
	AnalysisLanguage,
	AnalysisTemplate,
	AudioChunk,
	ChunkStatus,
	NewTemplate,
	Session,
	SessionStatus,
	SessionSummary,
	Transcript,
	TranscriptSegment,
} from "./domain/models.js";
export { SESSION_STATUS_LABELS, TRANSIENT_STATUSES } from "./domain/states.js";
export { buildTranscriptPreview, isSilenceArtifact } from "./domain/transcript.js";
export type {
	AudioDevice,
	AudioLevels,
	CaptureCapabilities,
	CaptureDevices,
	CaptureSource,
	ResolvedDevices,
} from "./ports/audio-capture.js";
export {
	BUILTIN_TEMPLATES,
	countPromptSections,
	DEFAULT_TEMPLATE_ID,
	FLASHCARDS_TEMPLATE_ID,
	type Flashcard,
	getBuiltinTemplate,
	LEGACY_TEMPLATE_IDS,
	parseFlashcards,
	resolveTemplateId,
	stripInlineMarkdown,
	TEMPLATE_LIMITS,
} from "./templates/index.js";
export { formatDuration, formatTimestamp } from "./utils/format.js";
