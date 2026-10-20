import { describe, expect, it } from "vitest";
import {
	analysisBlocks,
	classifySection,
	parseAnalysisSections,
	parseFlashcards,
	parseFormulaItems,
	parseOrderedList,
	parseTermItems,
} from "../../src/features/session-detail/analysisMarkdown";
import {
	activeSegmentIndex,
	meaningfulSegments,
	segmentViews,
} from "../../src/features/session-detail/transcript";

describe("parseFlashcards", () => {
	it("parses pergunta;resposta lines, skipping header and noise", () => {
		const md = [
			"# Flashcards",
			"pergunta;resposta",
			"O que a entropia mede?;O nº de microestados compatíveis",
			"- **2ª Lei?**; ΔS ≥ 0 em sistemas isolados",
			'"Com aspas";"Resposta; com ponto e vírgula"',
			"linha sem separador",
			";sem frente",
			"",
		].join("\n");
		expect(parseFlashcards(md)).toEqual([
			{ front: "O que a entropia mede?", back: "O nº de microestados compatíveis" },
			{ front: "2ª Lei?", back: "ΔS ≥ 0 em sistemas isolados" },
			{ front: "Com aspas", back: "Resposta; com ponto e vírgula" },
		]);
	});
});

describe("parseAnalysisSections", () => {
	it("splits on # and ## headings, keeping preamble and ### inside", () => {
		const md =
			"Intro solta\n\n## Resumo\nTexto\n### Sub\nMais\n\n## Vazio\n\n# Tarefas\n- a\n```\n## not a heading\n```";
		const secs = parseAnalysisSections(md);
		expect(secs.map((s) => s.title)).toEqual([null, "Resumo", "Tarefas"]);
		expect(secs[1].body).toBe("Texto\n### Sub\nMais");
		expect(secs[2].body).toContain("## not a heading");
	});
	it("strips inline markup from titles", () => {
		expect(parseAnalysisSections("## **Decisões**\nx")[0].title).toBe("Decisões");
	});
});

describe("section classification", () => {
	it("term lists", () => {
		expect(parseTermItems("- **Entropia**: mede desordem\n- **Clausius:** ΔS = Q/T")).toEqual([
			{ term: "Entropia", desc: "mede desordem" },
			{ term: "Clausius", desc: "ΔS = Q/T" },
		]);
		expect(parseTermItems("- solto\n- **A**: b")).toBeNull();
	});
	it("formula lists", () => {
		expect(parseFormulaItems("- `ΔS = Q/T` — Clausius\n- S = k·ln(Ω) — Boltzmann")).toEqual([
			{ expr: "ΔS = Q/T", label: "Clausius" },
			{ expr: "S = k·ln(Ω)", label: "Boltzmann" },
		]);
		expect(parseFormulaItems("texto")).toBeNull();
	});
	it("ordered lists", () => {
		expect(parseOrderedList("1. um\n2) dois")).toEqual(["um", "dois"]);
		expect(parseOrderedList("1. um\ntexto")).toBeNull();
	});
	it("chooses the design block per section", () => {
		expect(classifySection({ title: "Conceitos-chave", body: "- **A**: b" }).kind).toBe("concepts");
		expect(classifySection({ title: "Glossário", body: "- **A**: b" }).kind).toBe("glossary");
		expect(classifySection({ title: "Fórmulas", body: "- `x` — y" }).kind).toBe("formulas");
		expect(classifySection({ title: "Passo a passo", body: "1. a\n2. b" }).kind).toBe("steps");
		expect(classifySection({ title: "Flashcards", body: "p;r" }).kind).toBe("flashcards");
		expect(classifySection({ title: "Resumo", body: "texto" }).kind).toBe("markdown");
	});
	it("renders the flashcards template entirely as cards", () => {
		const blocks = analysisBlocks("a;b\nc;d", "flashcards-anki");
		expect(blocks).toEqual([
			{
				kind: "flashcards",
				title: "Flashcards",
				cards: [
					{ front: "a", back: "b" },
					{ front: "c", back: "d" },
				],
			},
		]);
		expect(analysisBlocks("## Resumo\ntexto", "resumo-executivo")[0].kind).toBe("markdown");
	});
});

describe("transcript helpers", () => {
	const segs = [
		{ start: 0, end: 5, text: "Olá turma" },
		{ start: 5, end: 9, text: "Thank you." },
		{ start: 9, end: 20, text: "Entropia nunca diminui" },
		{ start: 20, end: 30, text: "entropia de novo" },
	];
	it("drops whisper silence artifacts", () => {
		expect(meaningfulSegments(segs).map((s) => s.text)).toEqual([
			"Olá turma",
			"Entropia nunca diminui",
			"entropia de novo",
		]);
	});
	it("active segment = last one started", () => {
		const m = meaningfulSegments(segs);
		expect(activeSegmentIndex(m, 0)).toBe(0);
		expect(activeSegmentIndex(m, 9.5)).toBe(1);
		expect(activeSegmentIndex(m, 100)).toBe(2);
		expect(activeSegmentIndex([], 3)).toBe(-1);
	});
	it("segment classes: on / hit / dim and counts", () => {
		const m = meaningfulSegments(segs);
		const idle = segmentViews(m, 10, "");
		expect(idle.views.map((v) => v.cls)).toEqual(["seg", "seg on", "seg"]);
		expect(idle.count).toBe("3 segmentos");
		const search = segmentViews(m, 10, "ENTROPIA");
		expect(search.views.map((v) => v.cls)).toEqual(["seg dim", "seg hit", "seg hit"]);
		expect(search.count).toBe("2 trechos");
		expect(segmentViews(m, 0, "turma").count).toBe("1 trecho");
	});
});
