import { describe, expect, it } from "vitest";
import {
	buildExportDocument,
	demoteHeadings,
	exportFileBaseName,
} from "../../../src/adapters/export/export-document.js";
import { MarkdownExporter, renderMarkdown } from "../../../src/adapters/export/markdown.js";
import type { Analysis, Transcript } from "../../../src/domain/models.js";
import { makeSession } from "../../helpers.js";

const session = makeSession({
	title: "Aula 12 — Termodinâmica",
	status: "completed",
	startedAt: "2026-10-11T12:14:00.000Z",
});

const transcript: Transcript = {
	id: "t",
	sessionId: session.id,
	segments: [
		{ start: 0, end: 5, text: " Bom dia, pessoal. " },
		{ start: 3725, end: 3730, text: "Encerrando." },
	],
	fullText: "Bom dia, pessoal. Encerrando.",
	language: "pt",
	provider: "groq",
	model: "whisper-large-v3-turbo",
	createdAt: "2026-10-11T13:00:00.000Z",
};

const analysis = (templateId: string, content: string): Analysis => ({
	id: `a-${templateId}`,
	sessionId: session.id,
	templateId,
	provider: "ollama",
	model: "llama3.1:8b",
	content,
	createdAt: "2026-10-11T13:05:00.000Z",
});

describe("buildExportDocument", () => {
	it("structures session, analyses (by template name) and timestamped transcript", () => {
		const doc = buildExportDocument({
			session,
			transcript,
			analyses: [
				analysis("resumo-executivo", "## Contexto\n\nTexto."),
				analysis("meeting-summary", "legado"),
				analysis("custom-1", "custom"),
				analysis("gone", "deleted template"),
			],
			templates: [
				{
					id: "custom-1",
					name: "Meu Template",
					description: "",
					prompt: "",
					builtin: false,
					sections: 1,
					language: "pt-BR",
				},
			],
			durationSec: 4358,
		});
		expect(doc.title).toBe("Aula 12 — Termodinâmica");
		expect(doc.metadata.map((m) => m.label)).toEqual(["Data", "Duração", "Origem", "Status"]);
		expect(doc.metadata[1].value).toBe("1 h 12 min");
		expect(doc.metadata[3].value).toBe("Concluído");
		expect(doc.analyses.map((a) => a.heading)).toEqual([
			"Resumo Executivo",
			"Ata de Reunião",
			"Meu Template",
			"gone",
		]);
		expect(doc.transcript?.segments.map((s) => [s.timestamp, s.text])).toEqual([
			["0:00", "Bom dia, pessoal."],
			["1:02:05", "Encerrando."],
		]);
		expect(doc.fileBaseName).toBe("2026-10-11_Aula 12 — Termodinâmica");
	});

	it("parses flashcards only for the flashcards template", () => {
		const doc = buildExportDocument({
			session,
			transcript: null,
			analyses: [
				analysis("flashcards-anki", "O que é entropia?;Medida de microestados\nlixo\n"),
				analysis("resumo-executivo", "a;b"),
			],
		});
		expect(doc.analyses[0].flashcards).toEqual([
			{ front: "O que é entropia?", back: "Medida de microestados" },
		]);
		expect(doc.analyses[1].flashcards).toBeNull();
		expect(doc.transcript).toBeNull();
		expect(doc.metadata.map((m) => m.label)).not.toContain("Duração");
	});

	it("makes filesystem-safe file names with a fallback title", () => {
		expect(exportFileBaseName({ ...session, title: 'a<b>:c"/d\\e|f?g*. ' })).toBe(
			"2026-10-11_a b c d e f g",
		);
		expect(exportFileBaseName({ ...session, title: null })).toBe(
			`2026-10-11_Sessão ${session.id.slice(0, 8)}`,
		);
		expect(exportFileBaseName({ ...session, title: "x".repeat(200) })).toHaveLength(11 + 80);
	});

	it("demotes headings outside code fences", () => {
		expect(demoteHeadings("## A\ntext\n```\n## code\n```\n###### deep")).toBe(
			"### A\ntext\n```\n## code\n```\n###### deep",
		);
	});
});

describe("MarkdownExporter", () => {
	it("renders analyses nested under their heading, then the transcript", async () => {
		const md = await new MarkdownExporter().export({
			session,
			transcript,
			analyses: [analysis("resumo-executivo", "## Contexto\n\nTexto.")],
		});
		expect(md.startsWith("# Aula 12 — Termodinâmica\n")).toBe(true);
		expect(md).toContain("**Status:** Concluído");
		expect(md).toContain("## Resumo Executivo\n\n### Contexto");
		expect(md).toContain("## Transcrição\n\n**[0:00]** Bom dia, pessoal.");
		expect(md.indexOf("Resumo Executivo")).toBeLessThan(md.indexOf("Transcrição"));
		expect(md.endsWith("\n")).toBe(true);
	});

	it("renders flashcards as a table with escaped pipes", () => {
		const doc = buildExportDocument({
			session,
			transcript: null,
			analyses: [analysis("flashcards-anki", "A | B?;C")],
		});
		expect(renderMarkdown(doc)).toContain(
			"| Pergunta | Resposta |\n| --- | --- |\n| A \\| B? | C |",
		);
	});
});
