/**
 * Minimal Markdown → block model used by the PDF/DOCX renderers. Covers what the analysis
 * templates produce: headings, paragraphs, bullet/numbered lists (nested), quotes, code blocks,
 * rules and inline **bold**, *italic*, `code`.
 */

export interface Inline {
	text: string;
	bold?: boolean;
	italic?: boolean;
	code?: boolean;
}

export type Block =
	| { type: "heading"; level: 1 | 2 | 3 | 4; inlines: Inline[] }
	| { type: "paragraph"; inlines: Inline[] }
	| { type: "bullet"; depth: number; inlines: Inline[] }
	| { type: "ordered"; depth: number; marker: string; inlines: Inline[] }
	| { type: "quote"; inlines: Inline[] }
	| { type: "code"; text: string }
	| { type: "rule" };

/** Parse inline emphasis. Unbalanced markers are kept as literal text. */
export function parseInline(text: string): Inline[] {
	const out: Inline[] = [];
	const re = /(\*\*|__)(.+?)\1|`([^`]+)`|(\*|_)(?!\s)(.+?)(?<!\s)\4/g;
	let last = 0;
	for (let m = re.exec(text); m; m = re.exec(text)) {
		// `_` inside words (snake_case) is not emphasis
		if (m[4] === "_" && /\w/.test(text[m.index - 1] ?? "")) continue;
		if (m.index > last) out.push({ text: text.slice(last, m.index) });
		if (m[2] !== undefined) {
			for (const inner of parseInline(m[2])) out.push({ ...inner, bold: true });
		} else if (m[3] !== undefined) {
			out.push({ text: m[3], code: true });
		} else if (m[5] !== undefined) {
			for (const inner of parseInline(m[5])) out.push({ ...inner, italic: true });
		}
		last = m.index + m[0].length;
	}
	if (last < text.length) out.push({ text: text.slice(last) });
	return out.filter((i) => i.text.length > 0);
}

export function parseMarkdown(md: string): Block[] {
	const blocks: Block[] = [];
	const lines = md.replace(/\r\n?/g, "\n").split("\n");
	let para: string[] = [];
	const flush = () => {
		if (para.length) {
			blocks.push({ type: "paragraph", inlines: parseInline(para.join(" ")) });
			para = [];
		}
	};

	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i] as string;
		const line = raw.trimEnd();
		const trimmed = line.trim();

		if (trimmed.startsWith("```")) {
			flush();
			const code: string[] = [];
			for (i++; i < lines.length && !(lines[i] as string).trim().startsWith("```"); i++) {
				code.push(lines[i] as string);
			}
			blocks.push({ type: "code", text: code.join("\n") });
			continue;
		}
		if (!trimmed) {
			flush();
			continue;
		}
		const heading = /^(#{1,6})\s+(.*?)\s*#*$/.exec(trimmed);
		if (heading) {
			flush();
			const level = Math.min(4, (heading[1] as string).length) as 1 | 2 | 3 | 4;
			blocks.push({ type: "heading", level, inlines: parseInline(heading[2] as string) });
			continue;
		}
		if (/^([-*_])(\s*\1){2,}$/.test(trimmed)) {
			flush();
			blocks.push({ type: "rule" });
			continue;
		}
		const indent = (line.match(/^\s*/)?.[0] ?? "").replace(/\t/g, "  ").length;
		const depth = Math.min(3, Math.floor(indent / 2));
		const bullet = /^[-*+•]\s+(.*)$/.exec(trimmed);
		if (bullet) {
			flush();
			blocks.push({ type: "bullet", depth, inlines: parseInline(bullet[1] as string) });
			continue;
		}
		const ordered = /^(\d{1,3})[.)]\s+(.*)$/.exec(trimmed);
		if (ordered) {
			flush();
			blocks.push({
				type: "ordered",
				depth,
				marker: `${ordered[1]}.`,
				inlines: parseInline(ordered[2] as string),
			});
			continue;
		}
		if (trimmed.startsWith(">")) {
			flush();
			blocks.push({ type: "quote", inlines: parseInline(trimmed.replace(/^>\s?/, "")) });
			continue;
		}
		para.push(trimmed);
	}
	flush();
	return blocks;
}
