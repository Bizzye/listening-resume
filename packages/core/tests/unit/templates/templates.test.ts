import { describe, expect, it } from "vitest";
import {
	BUILTIN_TEMPLATES,
	buildSystemPrompt,
	countPromptSections,
	DEFAULT_TEMPLATE_ID,
	getBuiltinTemplate,
	isBuiltinTemplateId,
	normalizeTemplateInput,
	parseFlashcards,
	renderTemplatePrompt,
	resolveTemplateId,
	stripInlineMarkdown,
} from "../../../src/templates/index.js";

describe("built-in templates", () => {
	it("are the 5 pt-BR templates from the design", () => {
		expect(BUILTIN_TEMPLATES.map((t) => [t.id, t.name, t.sections])).toEqual([
			["videoaula-extracao", "Videoaula — Extração Total", 5],
			["ata-reuniao", "Ata de Reunião", 4],
			["resumo-executivo", "Resumo Executivo", 2],
			["flashcards-anki", "Flashcards (Anki)", 1],
			["podcast-artigo", "Podcast → Artigo", 3],
		]);
		for (const t of BUILTIN_TEMPLATES) {
			expect(t).toMatchObject({ builtin: true, language: "pt-BR" });
			expect(t.description.length).toBeGreaterThan(10);
			expect(t.prompt).toContain("{transcricao}");
			expect(t.prompt).toContain("{titulo}");
		}
		expect(DEFAULT_TEMPLATE_ID).toBe("resumo-executivo");
	});

	it("section templates ask for Markdown `##` sections matching their count", () => {
		for (const t of BUILTIN_TEMPLATES.filter((t) => t.id !== "flashcards-anki")) {
			const headings = t.prompt.match(/^## /gm)?.length ?? 0;
			expect(headings).toBeGreaterThanOrEqual(t.sections);
		}
	});

	it("flashcards template demands pergunta;resposta lines only", () => {
		const prompt = getBuiltinTemplate("flashcards-anki")?.prompt ?? "";
		expect(prompt).toContain("pergunta;resposta");
		expect(prompt).toMatch(/sem Markdown/);
	});

	it("resolves legacy ids", () => {
		expect(resolveTemplateId("meeting-summary")).toBe("ata-reuniao");
		expect(resolveTemplateId("action-items")).toBe("ata-reuniao");
		expect(resolveTemplateId("custom-1")).toBe("custom-1");
		expect(getBuiltinTemplate("meeting-summary")?.id).toBe("ata-reuniao");
		expect(isBuiltinTemplateId("resumo-executivo")).toBe(true);
		expect(isBuiltinTemplateId("custom-1")).toBe(false);
	});
});

describe("renderTemplatePrompt", () => {
	it("fills {transcricao} and {titulo}", () => {
		expect(
			renderTemplatePrompt("T: {titulo}\n{transcricao}\n({titulo})", {
				transcript: "texto",
				title: "Aula",
			}),
		).toBe("T: Aula\ntexto\n(Aula)");
	});

	it("accepts the legacy {{transcript}} variable", () => {
		expect(renderTemplatePrompt("Resuma: {{transcript}}", { transcript: "abc" })).toBe(
			"Resuma: abc",
		);
	});

	it("appends the transcript when the prompt has no variable", () => {
		const out = renderTemplatePrompt("Avalie o candidato.  ", { transcript: "fala" });
		expect(out).toBe('Avalie o candidato.\n\nTranscrição:\n"""\nfala\n"""');
	});

	it("defaults the title and keeps `$` sequences in the transcript literal", () => {
		expect(renderTemplatePrompt("{titulo}|{transcricao}", { transcript: "R$ 10 $& $1" })).toBe(
			"Sem título|R$ 10 $& $1",
		);
	});

	it("does not substitute variables that appear inside the transcript", () => {
		expect(renderTemplatePrompt("{transcricao}", { transcript: "{titulo}", title: "X" })).toBe(
			"{titulo}",
		);
	});
});

describe("system prompt", () => {
	it("is language specific", () => {
		expect(buildSystemPrompt()).toContain("português do Brasil");
		expect(buildSystemPrompt("pt-BR")).toContain("português do Brasil");
		expect(buildSystemPrompt("en")).toContain("ALWAYS answer in English");
	});
});

describe("helpers", () => {
	it("counts sections from headings or numbered items", () => {
		expect(countPromptSections("## A\n## B\n### C")).toBe(3);
		expect(countPromptSections("produza: 1) conceitos; 2) fórmulas; 3) glossário")).toBe(3);
		expect(countPromptSections("Resuma.")).toBe(1);
	});

	it("normalizes and validates template input", () => {
		expect(normalizeTemplateInput({ name: "  A ", prompt: " p ", description: " d " })).toEqual({
			name: "A",
			prompt: "p",
			description: "d",
		});
		expect(normalizeTemplateInput({})).toEqual({});
		expect(() => normalizeTemplateInput({ description: "x".repeat(281) })).toThrow(/280/);
		expect(() => normalizeTemplateInput({ prompt: "x".repeat(20_001) })).toThrow(/20000/);
	});

	it("parses flashcards tolerating bullets, numbering and blank lines", () => {
		expect(
			parseFlashcards(
				"- O que é ΔS?;Q/T\n2) Quem fala?;A Carla;\n\nsem separador\n;sem frente\n* A;B;C",
			),
		).toEqual([
			{ front: "O que é ΔS?", back: "Q/T" },
			{ front: "Quem fala?", back: "A Carla" },
			{ front: "A", back: "B;C" },
		]);
	});
});

describe("stripInlineMarkdown", () => {
	it("drops bold / inline-code markers and wrapping quotes", () => {
		expect(stripInlineMarkdown("  **Resumo** de `x`  ")).toBe("Resumo de x");
		expect(stripInlineMarkdown(' "citação" ')).toBe("citação");
		expect(stripInlineMarkdown('"**a**"')).toBe("a");
		expect(stripInlineMarkdown("sem marcação")).toBe("sem marcação");
		expect(stripInlineMarkdown("**")).toBe("**");
	});
});
