import { PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from "pdf-lib";
import { type Block, type Inline, parseMarkdown } from "./markdown-blocks.js";
import type { RenderDoc } from "./render-doc.js";

// ── WinAnsi (cp1252) safety ────────────────────────────────────────────────────────────────
// Standard PDF fonts only encode WinAnsi. Latin-1 covers every pt-BR accent; anything else is
// mapped to a close ASCII equivalent (or dropped) instead of crashing the export.

const CP1252_EXTRAS = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
const REPLACEMENTS: Record<string, string> = {
	"→": "->",
	"←": "<-",
	"↔": "<->",
	"⇒": "=>",
	"≥": ">=",
	"≤": "<=",
	"≠": "!=",
	"≈": "~",
	"−": "-",
	"✓": "v",
	"✔": "v",
	"✗": "x",
	"☐": "[ ]",
	"☑": "[x]",
	Ł: "L",
	ł: "l",
	Δ: "Delta",
	π: "pi",
	"∑": "Sum",
	"√": "sqrt",
	"∞": "inf",
	" ": " ",
	" ": " ",
	"​": "",
};

export function toWinAnsi(text: string): string {
	let out = "";
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		if (ch === "\t") out += "    ";
		else if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) out += ch;
		else if (CP1252_EXTRAS.includes(ch)) out += ch;
		else if (ch in REPLACEMENTS) out += REPLACEMENTS[ch];
		else {
			// Try the base letter (e.g. "ő" → "o"); otherwise drop (emoji, CJK, symbols).
			const base = ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
			out += /^[\x20-\x7e]+$/.test(base) ? base : "";
		}
	}
	return out;
}

// ── Layout ─────────────────────────────────────────────────────────────────────────────────

const A4: [number, number] = [595.28, 841.89];
const MARGIN_X = 56;
const MARGIN_TOP = 60;
const MARGIN_BOTTOM = 56;
const INK = rgb(0.11, 0.11, 0.13);
const MUTED = rgb(0.42, 0.42, 0.47);
const ACCENT = rgb(0.24, 0.35, 0.85);

interface Fonts {
	regular: PDFFont;
	bold: PDFFont;
	italic: PDFFont;
	boldItalic: PDFFont;
	mono: PDFFont;
}

interface Run {
	text: string;
	font: PDFFont;
	color?: ReturnType<typeof rgb>;
}

class PdfLayout {
	page!: PDFPage;
	y = 0;
	readonly width = A4[0] - MARGIN_X * 2;

	constructor(
		readonly doc: PDFDocument,
		readonly fonts: Fonts,
	) {
		this.newPage();
	}

	newPage(): void {
		this.page = this.doc.addPage(A4);
		this.y = A4[1] - MARGIN_TOP;
	}

	ensure(height: number): void {
		if (this.y - height < MARGIN_BOTTOM) this.newPage();
	}

	gap(h: number): void {
		this.y -= h;
	}

	fontFor(i: Inline): PDFFont {
		if (i.code) return this.fonts.mono;
		if (i.bold && i.italic) return this.fonts.boldItalic;
		if (i.bold) return this.fonts.bold;
		if (i.italic) return this.fonts.italic;
		return this.fonts.regular;
	}

	/** Word-wrap styled runs into lines that fit `maxWidth`. */
	wrap(runs: Run[], size: number, maxWidth: number): Run[][] {
		const lines: Run[][] = [];
		let line: Run[] = [];
		let width = 0;
		const push = (r: Run, w: number) => {
			const prev = line[line.length - 1];
			if (prev && prev.font === r.font && prev.color === r.color) prev.text += r.text;
			else line.push({ ...r });
			width += w;
		};
		const breakLine = () => {
			const last = line[line.length - 1];
			if (last) last.text = last.text.trimEnd();
			lines.push(line);
			line = [];
			width = 0;
		};
		for (const run of runs) {
			for (const token of run.text.split(/(\s+)/)) {
				if (!token) continue;
				const isSpace = /^\s+$/.test(token);
				const text = isSpace ? " " : token;
				if (isSpace && line.length === 0) continue;
				let w = run.font.widthOfTextAtSize(text, size);
				if (!isSpace && width + w > maxWidth && line.length > 0) breakLine();
				if (!isSpace && w > maxWidth) {
					// Hard-break very long tokens (URLs, hashes).
					let chunk = "";
					for (const ch of text) {
						const cw = run.font.widthOfTextAtSize(chunk + ch, size);
						if (cw > maxWidth && chunk) {
							push({ ...run, text: chunk }, run.font.widthOfTextAtSize(chunk, size));
							breakLine();
							chunk = "";
						}
						chunk += ch;
					}
					w = run.font.widthOfTextAtSize(chunk, size);
					push({ ...run, text: chunk }, w);
					continue;
				}
				push({ ...run, text }, w);
			}
		}
		if (line.length) breakLine();
		return lines;
	}

	/** Draw wrapped runs; `prefix` (bullet / number / timestamp) hangs in the indent. */
	paragraph(
		runs: Run[],
		opts: {
			size?: number;
			indent?: number;
			prefix?: Run;
			prefixWidth?: number;
			after?: number;
		} = {},
	): void {
		const size = opts.size ?? 10.5;
		const lineHeight = size * 1.45;
		const indent = opts.indent ?? 0;
		const prefixWidth = opts.prefix ? (opts.prefixWidth ?? 14) : 0;
		const x0 = MARGIN_X + indent + prefixWidth;
		const lines = this.wrap(
			runs.map((r) => ({ ...r, text: toWinAnsi(r.text) })),
			size,
			this.width - indent - prefixWidth,
		);
		lines.forEach((line, idx) => {
			this.ensure(lineHeight);
			this.y -= lineHeight;
			if (idx === 0 && opts.prefix) {
				this.page.drawText(toWinAnsi(opts.prefix.text), {
					x: MARGIN_X + indent,
					y: this.y,
					size,
					font: opts.prefix.font,
					color: opts.prefix.color ?? MUTED,
				});
			}
			let x = x0;
			for (const r of line) {
				if (!r.text) continue;
				this.page.drawText(r.text, { x, y: this.y, size, font: r.font, color: r.color ?? INK });
				x += r.font.widthOfTextAtSize(r.text, size);
			}
		});
		this.gap(opts.after ?? size * 0.5);
	}

	rule(): void {
		this.ensure(14);
		this.gap(6);
		this.page.drawLine({
			start: { x: MARGIN_X, y: this.y },
			end: { x: MARGIN_X + this.width, y: this.y },
			thickness: 0.6,
			color: rgb(0.85, 0.85, 0.88),
		});
		this.gap(10);
	}

	inlinesToRuns(inlines: Inline[], color?: ReturnType<typeof rgb>): Run[] {
		return inlines.map((i) => ({ text: i.text, font: this.fontFor(i), color }));
	}

	block(b: Block): void {
		switch (b.type) {
			case "heading": {
				const size = b.level === 1 ? 16 : b.level === 2 ? 13.5 : b.level === 3 ? 12 : 11;
				this.ensure(size * 3.2);
				this.gap(size * 0.5);
				this.paragraph(
					b.inlines.map((i) => ({ text: i.text, font: this.fonts.bold })),
					{ size, after: size * 0.35 },
				);
				break;
			}
			case "paragraph":
				this.paragraph(this.inlinesToRuns(b.inlines));
				break;
			case "bullet":
				this.paragraph(this.inlinesToRuns(b.inlines), {
					indent: 4 + b.depth * 14,
					prefix: { text: b.depth % 2 ? "–" : "•", font: this.fonts.regular },
					after: 3,
				});
				break;
			case "ordered":
				this.paragraph(this.inlinesToRuns(b.inlines), {
					indent: 4 + b.depth * 14,
					prefix: { text: b.marker, font: this.fonts.regular },
					prefixWidth: 20,
					after: 3,
				});
				break;
			case "quote":
				this.paragraph(this.inlinesToRuns(b.inlines, MUTED), {
					indent: 10,
					prefix: { text: "|", font: this.fonts.bold, color: ACCENT },
					prefixWidth: 10,
				});
				break;
			case "code":
				for (const l of b.text.split("\n")) {
					this.paragraph([{ text: l || " ", font: this.fonts.mono }], {
						size: 9,
						indent: 8,
						after: 0,
					});
				}
				this.gap(6);
				break;
			case "rule":
				this.rule();
				break;
		}
	}
}

/** Render a document to PDF bytes with the standard (WinAnsi) fonts. */
export async function renderPdf(doc: RenderDoc): Promise<Buffer> {
	const pdf = await PDFDocument.create();
	pdf.setTitle(toWinAnsi(doc.title));
	pdf.setCreator("Listening Resume");
	pdf.setProducer("Listening Resume");
	pdf.setLanguage("pt-BR");
	const fonts: Fonts = {
		regular: await pdf.embedFont(StandardFonts.Helvetica),
		bold: await pdf.embedFont(StandardFonts.HelveticaBold),
		italic: await pdf.embedFont(StandardFonts.HelveticaOblique),
		boldItalic: await pdf.embedFont(StandardFonts.HelveticaBoldOblique),
		mono: await pdf.embedFont(StandardFonts.Courier),
	};
	const L = new PdfLayout(pdf, fonts);

	L.paragraph([{ text: doc.title, font: fonts.bold }], { size: 20, after: 6 });
	for (const m of doc.meta) {
		L.paragraph(
			[
				{ text: `${m.label}: `, font: fonts.bold, color: MUTED },
				{ text: m.value, font: fonts.regular, color: MUTED },
			],
			{ size: 9.5, after: 1 },
		);
	}
	L.rule();

	for (const section of doc.sections) {
		L.ensure(60);
		L.paragraph([{ text: section.heading, font: fonts.bold, color: ACCENT }], {
			size: 15,
			after: section.kind === "markdown" && section.subtitle ? 2 : 8,
		});
		if (section.kind === "markdown") {
			if (section.subtitle) {
				L.paragraph([{ text: section.subtitle, font: fonts.italic, color: MUTED }], {
					size: 9,
					after: 8,
				});
			}
			for (const b of parseMarkdown(section.markdown)) L.block(b);
		} else {
			for (const seg of section.segments) {
				L.paragraph([{ text: seg.text, font: fonts.regular }], {
					prefix: { text: seg.time, font: fonts.mono, color: ACCENT },
					prefixWidth: 58,
					after: 4,
				});
			}
		}
		L.gap(10);
	}

	// Footer: page numbers.
	const pages = pdf.getPages();
	pages.forEach((page, i) => {
		const label = `${i + 1} / ${pages.length}`;
		const w = fonts.regular.widthOfTextAtSize(label, 8);
		page.drawText(label, {
			x: A4[0] - MARGIN_X - w,
			y: 30,
			size: 8,
			font: fonts.regular,
			color: MUTED,
		});
		page.drawText(toWinAnsi(doc.title).slice(0, 90), {
			x: MARGIN_X,
			y: 30,
			size: 8,
			font: fonts.regular,
			color: MUTED,
		});
	});

	return Buffer.from(await pdf.save());
}
