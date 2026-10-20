import type { ExportDocument } from "@listening-resume/core";

/** Layout-ready view of core's `ExportDocument` shared by the PDF and DOCX renderers. */
export interface RenderDoc {
	title: string;
	/** Key facts shown under the title (Data, Duração, Origem…). */
	meta: Array<{ label: string; value: string }>;
	sections: RenderSection[];
}

export type RenderSection =
	| { kind: "markdown"; heading: string; subtitle?: string; markdown: string }
	| { kind: "transcript"; heading: string; segments: Array<{ time: string; text: string }> };

/** Analyses first (flashcards as Q/A list), then the timestamped transcript. */
export function toRenderDoc(doc: ExportDocument): RenderDoc {
	const sections: RenderSection[] = doc.analyses.map((a) => ({
		kind: "markdown",
		heading: a.heading,
		subtitle: `Gerado por ${a.provider} · ${a.model}`,
		markdown:
			a.flashcards && a.flashcards.length > 0
				? a.flashcards.map((c, i) => `${i + 1}. **${c.front}** — ${c.back}`).join("\n")
				: a.markdown,
	}));
	if (doc.transcript) {
		sections.push({
			kind: "transcript",
			heading: doc.transcript.heading,
			segments: doc.transcript.segments.map((s) => ({ time: s.timestamp, text: s.text })),
		});
	}
	return { title: doc.title, meta: doc.metadata, sections };
}
