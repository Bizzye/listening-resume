import { ValidationError } from "../domain/errors.js";
import type { AnalysisLanguage, AnalysisTemplate, NewTemplate } from "../domain/models.js";
import { BUILTIN_TEMPLATES, LEGACY_TEMPLATE_IDS } from "./builtin.js";

export {
	BUILTIN_TEMPLATES,
	DEFAULT_TEMPLATE_ID,
	FLASHCARDS_TEMPLATE_ID,
	LEGACY_TEMPLATE_IDS,
} from "./builtin.js";

/** Maps legacy ids (`meeting-summary`, `action-items`) to their current built-in id. */
export function resolveTemplateId(id: string): string {
	return LEGACY_TEMPLATE_IDS[id] ?? id;
}

export function getBuiltinTemplate(id: string): AnalysisTemplate | null {
	const resolved = resolveTemplateId(id);
	return BUILTIN_TEMPLATES.find((t) => t.id === resolved) ?? null;
}

export function isBuiltinTemplateId(id: string): boolean {
	return getBuiltinTemplate(id) !== null;
}

const TRANSCRIPT_VARS = /\{transcricao\}|\{\{\s*transcript\s*\}\}/g;
const TITLE_VARS = /\{titulo\}|\{\{\s*title\s*\}\}/g;

export interface PromptVariables {
	transcript: string;
	title?: string | null;
}

/**
 * Fills `{transcricao}` / `{titulo}` (and legacy `{{transcript}}`). Prompts without a
 * transcript variable get the transcript appended, so custom prompts can be plain text.
 */
export function renderTemplatePrompt(prompt: string, vars: PromptVariables): string {
	const title = vars.title?.trim() || "Sem título";
	// Function replacers: transcripts may contain `$&`-style sequences.
	const withTitle = prompt.replace(TITLE_VARS, () => title);
	if (withTitle.search(TRANSCRIPT_VARS) >= 0) {
		return withTitle.replace(TRANSCRIPT_VARS, () => vars.transcript);
	}
	return `${withTitle.trimEnd()}\n\nTranscrição:\n"""\n${vars.transcript}\n"""`;
}

const SYSTEM_PROMPTS: Record<AnalysisLanguage, string> = {
	"pt-BR": `Você é um assistente que transforma transcrições de áudio (aulas, reuniões, podcasts, palestras) em documentos claros, fiéis e bem estruturados.
Regras:
- Responda SEMPRE em português do Brasil.
- Formate a resposta em Markdown, com seções "## ", exceto quando as instruções pedirem outro formato — nesse caso siga o formato pedido à risca.
- Baseie-se apenas na transcrição: não invente nomes, números, datas ou fatos. Quando algo estiver inaudível ou ambíguo, sinalize com [?].
- Preserve nomes próprios, siglas, números e termos técnicos exatamente como foram ditos.
- Transcrições automáticas têm erros: corrija palavras obviamente mal reconhecidas pelo contexto.
- Entregue apenas o documento final, sem preâmbulos ("Claro! Aqui está…") e sem comentários ao final.`,
	en: `You are an assistant that turns audio transcripts (lectures, meetings, podcasts, talks) into clear, faithful, well-structured documents.
Rules:
- ALWAYS answer in English, even though the instructions below are written in Portuguese: translate the section headings and all content.
- Format the answer in Markdown with "## " sections, unless the instructions ask for another format — in that case follow it exactly (e.g. "question;answer" lines).
- Rely only on the transcript: never invent names, numbers, dates or facts. Mark inaudible or ambiguous passages with [?].
- Keep proper names, acronyms, numbers and technical terms exactly as spoken.
- Automatic transcripts contain errors: fix obviously misrecognized words from context.
- Deliver only the final document — no preamble and no closing remarks.`,
};

export function buildSystemPrompt(language: AnalysisLanguage = "pt-BR"): string {
	return SYSTEM_PROMPTS[language];
}

/** Display-only estimate of how many sections a (custom) prompt asks for. */
export function countPromptSections(prompt: string): number {
	const headings = prompt.match(/^\s*#{2,3}\s+\S/gm)?.length ?? 0;
	if (headings > 0) return headings;
	const numbered = prompt.match(/(?:^|\s)\d{1,2}[).]\s+\S/g)?.length ?? 0;
	return Math.max(1, numbered);
}

export const TEMPLATE_LIMITS = { name: 80, description: 280, prompt: 20_000 } as const;

/** Validates + trims user input for a custom template. Throws `ValidationError` (pt-BR). */
export function normalizeTemplateInput(data: NewTemplate): Required<NewTemplate>;
export function normalizeTemplateInput(data: Partial<NewTemplate>): Partial<NewTemplate>;
export function normalizeTemplateInput(data: Partial<NewTemplate>): Partial<NewTemplate> {
	const out: Partial<NewTemplate> = {};
	if (data.name !== undefined) {
		const name = String(data.name).trim();
		if (!name) throw new ValidationError("O nome do template é obrigatório.");
		if (name.length > TEMPLATE_LIMITS.name) {
			throw new ValidationError(`O nome pode ter no máximo ${TEMPLATE_LIMITS.name} caracteres.`);
		}
		out.name = name;
	}
	if (data.description !== undefined) {
		const description = String(data.description ?? "").trim();
		if (description.length > TEMPLATE_LIMITS.description) {
			throw new ValidationError(
				`A descrição pode ter no máximo ${TEMPLATE_LIMITS.description} caracteres.`,
			);
		}
		out.description = description;
	}
	if (data.prompt !== undefined) {
		const prompt = String(data.prompt).trim();
		if (!prompt) throw new ValidationError("O prompt do template é obrigatório.");
		if (prompt.length > TEMPLATE_LIMITS.prompt) {
			throw new ValidationError(
				`O prompt pode ter no máximo ${TEMPLATE_LIMITS.prompt} caracteres.`,
			);
		}
		out.prompt = prompt;
	}
	return out;
}

export interface Flashcard {
	front: string;
	back: string;
}

/** Drops bold / inline-code markers and wrapping CSV quotes (section titles, flashcards). Pure. */
export const stripInlineMarkdown = (text: string): string =>
	text
		.replace(/\*\*(.+?)\*\*/g, "$1")
		.replace(/`(.+?)`/g, "$1")
		.trim()
		.replace(/^"(.*)"$/, "$1")
		.trim();

/**
 * Parses `pergunta;resposta` lines. Tolerates what models add around them: list markers or
 * numbering, bold/code markup, CSV-style quotes, a trailing `;`, headings, code fences and a
 * `pergunta;resposta` header row. Only the first `;` separates front from back. Pure.
 */
export function parseFlashcards(content: string): Flashcard[] {
	const cards: Flashcard[] = [];
	for (const raw of content.split(/\r?\n/)) {
		const line = raw
			.trim()
			.replace(/^(?:[-*+•]|\d{1,3}[.)])\s+/, "")
			.trim();
		if (!line || line.startsWith("#") || line.startsWith("```")) continue;
		const sep = line.indexOf(";");
		if (sep <= 0) continue;
		const front = stripInlineMarkdown(line.slice(0, sep));
		const back = stripInlineMarkdown(
			line
				.slice(sep + 1)
				.trim()
				.replace(/;+$/, ""),
		);
		if (!front || !back) continue;
		if (/^pergunta$/i.test(front) && /^resposta$/i.test(back)) continue; // header row
		cards.push({ front, back });
	}
	return cards;
}
