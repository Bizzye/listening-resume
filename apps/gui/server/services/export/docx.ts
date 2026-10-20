import {
	AlignmentType,
	BorderStyle,
	Document,
	Footer,
	HeadingLevel,
	Packer,
	PageNumber,
	Paragraph,
	TextRun,
} from "docx";
import { type Block, type Inline, parseMarkdown } from "./markdown-blocks.js";
import type { RenderDoc } from "./render-doc.js";

const MUTED = "6B6B78";
const ACCENT = "3D5AD9";
const FONT = "Calibri";
const MONO = "Consolas";

function runs(inlines: Inline[], color?: string): TextRun[] {
	return inlines.map(
		(i) =>
			new TextRun({
				text: i.text,
				bold: i.bold,
				italics: i.italic,
				font: i.code ? MONO : undefined,
				color,
			}),
	);
}

const HEADINGS = [
	HeadingLevel.HEADING_2,
	HeadingLevel.HEADING_2,
	HeadingLevel.HEADING_3,
	HeadingLevel.HEADING_4,
] as const;

function blockToParagraphs(b: Block): Paragraph[] {
	switch (b.type) {
		case "heading":
			// Section titles are Heading 1; markdown headings nest below them.
			return [new Paragraph({ heading: HEADINGS[b.level - 1], children: runs(b.inlines) })];
		case "paragraph":
			return [new Paragraph({ children: runs(b.inlines), spacing: { after: 120 } })];
		case "bullet":
			return [new Paragraph({ children: runs(b.inlines), bullet: { level: b.depth } })];
		case "ordered":
			// Keep the model's own numbers (lists restart per section) with a hanging indent.
			return [
				new Paragraph({
					children: [new TextRun(`${b.marker} `), ...runs(b.inlines)],
					indent: { left: 360 * (b.depth + 1), hanging: 280 },
				}),
			];
		case "quote":
			return [
				new Paragraph({
					children: runs(b.inlines, MUTED),
					indent: { left: 360 },
					border: { left: { style: BorderStyle.SINGLE, size: 12, color: ACCENT, space: 8 } },
				}),
			];
		case "code":
			return b.text.split("\n").map(
				(l) =>
					new Paragraph({
						children: [new TextRun({ text: l || " ", font: MONO, size: 18 })],
						indent: { left: 240 },
						spacing: { after: 0 },
					}),
			);
		case "rule":
			return [
				new Paragraph({
					children: [],
					border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "D9D9E0", space: 1 } },
				}),
			];
	}
}

/** Render a document to a .docx (Office Open XML) buffer. */
export async function renderDocx(doc: RenderDoc): Promise<Buffer> {
	const children: Paragraph[] = [
		new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(doc.title)] }),
		...doc.meta.map(
			(m) =>
				new Paragraph({
					spacing: { after: 40 },
					children: [
						new TextRun({ text: `${m.label}: `, bold: true, color: MUTED }),
						new TextRun({ text: m.value, color: MUTED }),
					],
				}),
		),
	];

	for (const section of doc.sections) {
		children.push(
			new Paragraph({
				heading: HeadingLevel.HEADING_1,
				spacing: { before: 360 },
				children: [new TextRun({ text: section.heading, color: ACCENT })],
			}),
		);
		if (section.kind === "markdown") {
			if (section.subtitle) {
				children.push(
					new Paragraph({
						children: [
							new TextRun({ text: section.subtitle, italics: true, color: MUTED, size: 18 }),
						],
					}),
				);
			}
			for (const b of parseMarkdown(section.markdown)) children.push(...blockToParagraphs(b));
		} else {
			for (const seg of section.segments) {
				children.push(
					new Paragraph({
						spacing: { after: 80 },
						children: [
							new TextRun({ text: `${seg.time}  `, font: MONO, color: ACCENT, size: 18 }),
							new TextRun(seg.text),
						],
					}),
				);
			}
		}
	}

	const document = new Document({
		creator: "Listening Resume",
		title: doc.title,
		styles: { default: { document: { run: { font: FONT, size: 22 } } } },
		sections: [
			{
				footers: {
					default: new Footer({
						children: [
							new Paragraph({
								alignment: AlignmentType.RIGHT,
								children: [
									new TextRun({ children: [PageNumber.CURRENT], color: MUTED, size: 16 }),
									new TextRun({ text: " / ", color: MUTED, size: 16 }),
									new TextRun({ children: [PageNumber.TOTAL_PAGES], color: MUTED, size: 16 }),
								],
							}),
						],
					}),
				},
				children,
			},
		],
	});
	return Packer.toBuffer(document);
}
