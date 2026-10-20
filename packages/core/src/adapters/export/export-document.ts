import { SESSION_STATUS_LABELS } from "../../domain/states.js";
import type { ExportData } from "../../ports/exporter.js";
import {
	FLASHCARDS_TEMPLATE_ID,
	type Flashcard,
	getBuiltinTemplate,
	parseFlashcards,
	resolveTemplateId,
} from "../../templates/index.js";
import { formatDuration, formatTimestamp } from "../../utils/format.js";

/**
 * Format-agnostic export model: session + analyses + transcript as ordered sections, so the
 * Markdown exporter and the GUI's PDF/DOCX renderers produce the same document.
 */
export interface ExportDocument {
	title: string;
	/** Label/value pairs shown under the title (pt-BR labels). */
	metadata: { label: string; value: string }[];
	analyses: ExportAnalysisSection[];
	transcript: ExportTranscriptSection | null;
	/** Filesystem-safe base name without extension, e.g. `2026-10-11_Aula 12`. */
	fileBaseName: string;
}

export interface ExportAnalysisSection {
	id: string;
	templateId: string;
	/** Template name (falls back to the id). */
	heading: string;
	provider: string;
	model: string;
	createdAt: string;
	/** Markdown produced by the model. */
	markdown: string;
	/** Parsed cards when the analysis came from the flashcards template. */
	flashcards: Flashcard[] | null;
}

export interface ExportTranscriptSection {
	heading: string;
	language: string | null;
	provider: string;
	model: string;
	segments: { start: number; end: number; timestamp: string; text: string }[];
}

export function sessionDisplayTitle(session: ExportData["session"]): string {
	return session.title?.trim() || `Sessão ${session.id.slice(0, 8)}`;
}

/** Date prefix + title, stripped of characters invalid in Windows/Unix file names. */
export function exportFileBaseName(session: ExportData["session"]): string {
	const date = (session.startedAt ?? session.createdAt).slice(0, 10);
	const title = sessionDisplayTitle(session)
		// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point
		.replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[. ]+$/, "")
		.slice(0, 80)
		.trim();
	return `${date}_${title || "sessao"}`;
}

function formatDate(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	return new Intl.DateTimeFormat("pt-BR", { dateStyle: "long", timeStyle: "short" }).format(date);
}

export function buildExportDocument(data: ExportData): ExportDocument {
	const { session, transcript } = data;
	const names = new Map((data.templates ?? []).map((t) => [t.id, t.name]));
	const templateName = (id: string) => names.get(id) ?? getBuiltinTemplate(id)?.name ?? id;

	const metadata: ExportDocument["metadata"] = [
		{ label: "Data", value: formatDate(session.startedAt ?? session.createdAt) },
	];
	if (data.durationSec !== undefined && data.durationSec > 0) {
		metadata.push({ label: "Duração", value: formatDuration(data.durationSec) });
	}
	if (session.audioSource) metadata.push({ label: "Origem", value: session.audioSource });
	metadata.push({ label: "Status", value: SESSION_STATUS_LABELS[session.status] });

	return {
		title: sessionDisplayTitle(session),
		metadata,
		analyses: data.analyses.map((a) => ({
			id: a.id,
			templateId: a.templateId,
			heading: templateName(a.templateId),
			provider: a.provider,
			model: a.model,
			createdAt: a.createdAt,
			markdown: a.content.trim(),
			flashcards:
				resolveTemplateId(a.templateId) === FLASHCARDS_TEMPLATE_ID
					? parseFlashcards(a.content)
					: null,
		})),
		transcript: transcript
			? {
					heading: "Transcrição",
					language: transcript.language,
					provider: transcript.provider,
					model: transcript.model,
					segments: transcript.segments.map((seg) => ({
						start: seg.start,
						end: seg.end,
						timestamp: formatTimestamp(seg.start),
						text: seg.text.trim(),
					})),
				}
			: null,
		fileBaseName: exportFileBaseName(session),
	};
}

/** Demotes Markdown headings by `levels` so model output nests under a section heading. */
export function demoteHeadings(markdown: string, levels = 1): string {
	let inFence = false;
	return markdown
		.split("\n")
		.map((line) => {
			if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
			if (inFence) return line;
			const m = line.match(/^(#{1,6})(\s.*)$/);
			if (!m) return line;
			return `${"#".repeat(Math.min(6, m[1].length + levels))}${m[2]}`;
		})
		.join("\n");
}
