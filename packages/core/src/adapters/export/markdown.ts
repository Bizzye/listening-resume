import type { ExportData, ExporterPort } from "../../ports/exporter.js";
import { buildExportDocument, demoteHeadings, type ExportDocument } from "./export-document.js";

/** Renders an `ExportDocument` as Markdown (Obsidian-friendly). Pure. */
export function renderMarkdown(doc: ExportDocument): string {
	const out: string[] = [`# ${doc.title}`, ""];
	for (const { label, value } of doc.metadata) out.push(`**${label}:** ${value}  `);
	out.push("");

	for (const analysis of doc.analyses) {
		out.push(`## ${analysis.heading}`, "");
		if (analysis.flashcards && analysis.flashcards.length > 0) {
			out.push("| Pergunta | Resposta |", "| --- | --- |");
			for (const card of analysis.flashcards) {
				out.push(`| ${escapeCell(card.front)} | ${escapeCell(card.back)} |`);
			}
			out.push("");
		} else {
			// Analyses use `##` sections themselves: nest them under the analysis heading.
			out.push(demoteHeadings(analysis.markdown, 1), "");
		}
		out.push("---", "");
	}

	if (doc.transcript) {
		out.push(`## ${doc.transcript.heading}`, "");
		for (const seg of doc.transcript.segments) out.push(`**[${seg.timestamp}]** ${seg.text}`, "");
	}

	return `${out.join("\n").trimEnd()}\n`;
}

function escapeCell(text: string): string {
	return text.replace(/\|/g, "\\|");
}

export class MarkdownExporter implements ExporterPort {
	readonly format = "md";

	async export(data: ExportData): Promise<string> {
		return renderMarkdown(buildExportDocument(data));
	}
}
