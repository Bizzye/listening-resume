// The ONE place the UI imports what it shares with the core package. Only the browser-safe
// `@listening-resume/core/shared` entry is allowed here — the main entry pulls Node-only code.

export {
	DEFAULT_GROQ_WHISPER_MODEL,
	DEFAULT_TEMPLATE_ID,
	FLASHCARDS_TEMPLATE_ID,
	type Flashcard,
	formatTimestamp,
	isSilenceArtifact,
	parseFlashcards,
	resolveTemplateId,
	SESSION_STATUS_LABELS,
	SYSTEM_DEFAULT_DEVICE,
	stripInlineMarkdown,
} from "@listening-resume/core/shared";
