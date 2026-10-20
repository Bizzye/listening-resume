import zlib from "node:zlib";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { renderDocx } from "../../../server/services/export/docx.js";
import { parseInline, parseMarkdown } from "../../../server/services/export/markdown-blocks.js";
import { renderPdf, toWinAnsi } from "../../../server/services/export/pdf.js";
import type { RenderDoc } from "../../../server/services/export/render-doc.js";

/** Extract one entry from a zip buffer (stored or deflated) by walking local file headers. */
function readZipEntry(zip: Buffer, name: string): string | null {
	let pos = 0;
	while (pos + 30 <= zip.length && zip.readUInt32LE(pos) === 0x04034b50) {
		const method = zip.readUInt16LE(pos + 8);
		const compSize = zip.readUInt32LE(pos + 18);
		const nameLen = zip.readUInt16LE(pos + 26);
		const extraLen = zip.readUInt16LE(pos + 28);
		const entryName = zip.toString("utf-8", pos + 30, pos + 30 + nameLen);
		const start = pos + 30 + nameLen + extraLen;
		const data = zip.subarray(start, start + compSize);
		if (entryName === name) {
			return (method === 8 ? zlib.inflateRawSync(data) : data).toString("utf-8");
		}
		pos = start + compSize;
	}
	return null;
}

const longText = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(40);

const doc: RenderDoc = {
	title: "Reunião de planejamento — Q3",
	meta: [
		{ label: "Data", value: "11 de outubro de 2026" },
		{ label: "Duração", value: "12:34" },
	],
	sections: [
		{
			kind: "markdown",
			heading: "Ata de reunião",
			subtitle: "Gerado por llama3.1:8b",
			markdown: [
				"## Decisões",
				"- **Cronograma** aprovado → entregas em *outubro*",
				"  - subitem com `código` e ΔS ≥ 0 🎉",
				"1. Primeiro passo",
				"2. Segundo passo",
				"> Citação importante",
				"```",
				"const x = 1;",
				"```",
				"---",
				longText,
			].join("\n"),
		},
		{
			kind: "transcript",
			heading: "Transcrição",
			segments: Array.from({ length: 120 }, (_, i) => ({
				time: `${Math.floor((i * 7.5) / 60)}:${String(Math.floor((i * 7.5) % 60)).padStart(2, "0")}`,
				text: `Segmento ${i} com acentuação: ação, coração, você. ${i % 10 === 0 ? longText : ""}`,
			})),
		},
	],
};

describe("markdown blocks", () => {
	it("parses inline emphasis and code", () => {
		expect(parseInline("a **b** *c* `d` snake_case_name")).toEqual([
			{ text: "a " },
			{ text: "b", bold: true },
			{ text: " " },
			{ text: "c", italic: true },
			{ text: " " },
			{ text: "d", code: true },
			{ text: " snake_case_name" },
		]);
		expect(parseInline("**negrito *itálico* fim**")[1]).toEqual({
			text: "itálico",
			bold: true,
			italic: true,
		});
	});

	it("parses headings, nested lists, quotes, code and rules", () => {
		const blocks = parseMarkdown(
			"# T\n\npara one\nstill para\n\n- a\n  - b\n3) c\n> q\n```\ncode\n```\n***",
		);
		expect(blocks.map((b) => b.type)).toEqual([
			"heading",
			"paragraph",
			"bullet",
			"bullet",
			"ordered",
			"quote",
			"code",
			"rule",
		]);
		expect(blocks[1]).toEqual({ type: "paragraph", inlines: [{ text: "para one still para" }] });
		expect(blocks[3]).toMatchObject({ type: "bullet", depth: 1 });
		expect(blocks[4]).toMatchObject({ type: "ordered", marker: "3." });
	});
});

describe("PDF renderer", () => {
	it("keeps pt-BR accents and maps non-WinAnsi characters", () => {
		expect(toWinAnsi("ação — “você” …")).toBe("ação — “você” …");
		expect(toWinAnsi("ΔS ≥ 0 → ok 🎉")).toBe("DeltaS >= 0 -> ok ");
		expect(toWinAnsi("Łódź ő")).toBe(
			"Łódź ő".replace("Ł", "L").replace("ź", "z").replace("ő", "o"),
		);
	});

	it("produces a valid multi-page PDF", async () => {
		const pdf = await renderPdf(doc);
		expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
		const loaded = await PDFDocument.load(pdf);
		expect(loaded.getPageCount()).toBeGreaterThan(2);
		expect(loaded.getTitle()).toBe("Reunião de planejamento — Q3");
	});

	it("renders an empty document", async () => {
		const pdf = await renderPdf({ title: "Vazio", meta: [], sections: [] });
		expect((await PDFDocument.load(pdf)).getPageCount()).toBe(1);
	});
});

describe("DOCX renderer", () => {
	it("produces a zip with the document text", async () => {
		const docx = await renderDocx(doc);
		expect(docx.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
		const xml = readZipEntry(docx, "word/document.xml");
		expect(xml).toBeTruthy();
		expect(xml).toContain("Reunião de planejamento — Q3");
		expect(xml).toContain("Cronograma");
		expect(xml).toContain("ΔS ≥ 0");
		expect(xml).toContain("Segmento 119");
	});
});
