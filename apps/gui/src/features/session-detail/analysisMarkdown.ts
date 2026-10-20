// Turns analysis Markdown into the design's structured blocks (sections with `.an-h`
// headings, key-concept cards, formulas, numbered steps, glossary rows, flip cards).

import {
	FLASHCARDS_TEMPLATE_ID,
	type Flashcard,
	parseFlashcards,
	stripInlineMarkdown as stripInline,
} from "../../shared/lib/core-shared";

export type { Flashcard };
export { FLASHCARDS_TEMPLATE_ID, parseFlashcards };

export interface MdSection {
	title: string | null;
	body: string;
}

/** Splits on `#`/`##` headings; deeper headings stay inside the section body. */
export function parseAnalysisSections(md: string): MdSection[] {
	const sections: MdSection[] = [];
	let cur: MdSection = { title: null, body: "" };
	let inFence = false;
	const flush = () => {
		cur.body = cur.body.trim();
		if (cur.body || cur.title) sections.push(cur);
	};
	for (const line of md.split(/\r?\n/)) {
		if (line.trim().startsWith("```")) inFence = !inFence;
		const m = !inFence ? /^#{1,2}\s+(.+?)\s*#*\s*$/.exec(line) : null;
		if (m) {
			flush();
			cur = { title: stripInline(m[1]), body: "" };
		} else {
			cur.body += `${line}\n`;
		}
	}
	flush();
	return sections.filter((s) => s.body);
}

export interface TermItem {
	term: string;
	desc: string;
}

const TERM_RE = [
	/^[-*+]\s+\*\*(.+?):\*\*\s*(.+)$/, // - **Termo:** descrição
	/^[-*+]\s+\*\*(.+?)\*\*\s*[:—–-]\s*(.+)$/, // - **Termo**: descrição / — descrição
];

/** All list items look like `**Termo**: descrição` → items, else null. */
export function parseTermItems(body: string): TermItem[] | null {
	const lines = body.split(/\r?\n/).filter((l) => l.trim());
	if (!lines.length) return null;
	const items: TermItem[] = [];
	for (const l of lines) {
		const line = l.trim();
		const m = TERM_RE.map((re) => re.exec(line)).find(Boolean);
		if (!m) return null;
		items.push({ term: m[1].trim(), desc: m[2].trim() });
	}
	return items;
}

export interface FormulaItem {
	expr: string;
	label: string;
}

/** List of `` `expr` — legenda `` (or `expr: legenda`) items, else null. */
export function parseFormulaItems(body: string): FormulaItem[] | null {
	const lines = body.split(/\r?\n/).filter((l) => l.trim());
	if (!lines.length) return null;
	const items: FormulaItem[] = [];
	for (const l of lines) {
		const line = l.trim();
		if (!/^[-*+]\s+/.test(line)) return null;
		const content = line.replace(/^[-*+]\s+/, "");
		const code = /^`([^`]+)`\s*(?:[:—–-]\s*(.*))?$/.exec(content);
		if (code) {
			items.push({ expr: code[1].trim(), label: stripInline(code[2] ?? "") });
			continue;
		}
		const split = /^(.+?)\s+[—–]\s+(.+)$/.exec(content);
		if (!split) return null;
		items.push({ expr: stripInline(split[1]), label: stripInline(split[2]) });
	}
	return items;
}

/** Body is a single ordered list → its items (inline markdown kept), else null. */
export function parseOrderedList(body: string): string[] | null {
	const items: string[] = [];
	for (const l of body.split(/\r?\n/)) {
		const line = l.trim();
		if (!line) continue;
		const m = /^\d+[.)]\s+(.+)$/.exec(line);
		if (m) items.push(m[1]);
		else if (items.length && /^\s{2,}\S/.test(l)) items[items.length - 1] += ` ${line}`;
		else return null;
	}
	return items.length ? items : null;
}

export type SectionBlock =
	| { kind: "flashcards"; title: string | null; cards: Flashcard[] }
	| { kind: "concepts"; title: string | null; items: TermItem[] }
	| { kind: "glossary"; title: string | null; items: TermItem[] }
	| { kind: "formulas"; title: string | null; items: FormulaItem[] }
	| { kind: "steps"; title: string | null; items: string[] }
	| { kind: "markdown"; title: string | null; body: string };

export function classifySection(sec: MdSection): SectionBlock {
	const title = sec.title;
	const t = (title ?? "").toLowerCase();
	if (/flashcard|cart(ã|a)o|cart(õ|o)es/.test(t)) {
		const cards = parseFlashcards(sec.body);
		if (cards.length) return { kind: "flashcards", title, cards };
	}
	if (/f(ó|o)rmula/.test(t)) {
		const items = parseFormulaItems(sec.body);
		if (items) return { kind: "formulas", title, items };
	}
	const terms = parseTermItems(sec.body);
	if (terms) {
		if (/gloss(á|a)rio/.test(t)) return { kind: "glossary", title, items: terms };
		if (/conceit/.test(t)) return { kind: "concepts", title, items: terms };
	}
	const steps = parseOrderedList(sec.body);
	if (steps && /passo|etapa|exerc(í|i)cio|step/.test(t))
		return { kind: "steps", title, items: steps };
	return { kind: "markdown", title, body: sec.body };
}

/** Whole analysis → blocks. The flashcards template is rendered entirely as flip cards. */
export function analysisBlocks(content: string, templateId: string): SectionBlock[] {
	if (templateId === FLASHCARDS_TEMPLATE_ID) {
		const cards = parseFlashcards(content);
		if (cards.length) return [{ kind: "flashcards", title: "Flashcards", cards }];
	}
	return parseAnalysisSections(content).map(classifySection);
}
