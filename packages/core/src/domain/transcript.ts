import type { Transcript } from "./models.js";

/** Phrases Whisper hallucinates on silence; never useful as a preview. */
const SILENCE_ARTIFACTS = new Set([
	"you",
	"bye.",
	"off",
	"off.",
	"thanks.",
	"thank you.",
	"thank you for watching.",
	"thanks for watching.",
	"obrigado.",
	"obrigada.",
	"tchau.",
	"tchau, tchau.",
	"legendas pela comunidade amara.org",
	"...",
]);

export function isSilenceArtifact(text: string): boolean {
	return SILENCE_ARTIFACTS.has(text.trim().toLowerCase());
}

/** First meaningful words of a transcript (for session cards), or null. */
export function buildTranscriptPreview(
	transcript: Pick<Transcript, "segments" | "fullText"> | null,
	maxChars = 140,
): string | null {
	if (!transcript) return null;
	const texts =
		transcript.segments.length > 0
			? transcript.segments.map((s) => s.text.trim()).filter((t) => t && !isSilenceArtifact(t))
			: [transcript.fullText.trim()];
	const joined = texts.join(" ").replace(/\s+/g, " ").trim();
	if (!joined) return null;
	if (joined.length <= maxChars) return joined;
	const cut = joined.slice(0, maxChars);
	const lastSpace = cut.lastIndexOf(" ");
	return `${(lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
