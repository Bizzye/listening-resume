import { AnalysisError } from "../../domain/errors.js";
import type { AnalyzeRequest, AnalyzeResult, AnalyzerPort } from "../../ports/analyzer.js";

export interface FakeAnalyzerOptions {
	provider?: string;
	model?: string;
	available?: boolean;
	/** Fail every call with this message (to test error/fallback paths). */
	failWith?: string;
	delayMs?: number;
}

const FLASHCARDS = [
	"O que a entropia mede na visão estatística?;O número de microestados compatíveis com o macroestado",
	"O que a 2ª Lei afirma para sistemas isolados?;A entropia nunca diminui: ΔS ≥ 0",
	"Quem revisa o documento de requisitos?;A Carla, até sexta-feira",
	"O que é preciso antes de contratar?;Aprovação do financeiro",
	"Qual a leitura para a próxima semana?;O capítulo vinte",
	"Qual risco foi levantado?;Dependência do time de infraestrutura para o deploy",
	"O que a gravação de teste captura?;O som do computador junto com o microfone",
	"Qual o primeiro ponto da pauta?;O cronograma de entregas do próximo trimestre",
];

const BULLETS = [
	"**Cronograma**: entregas do próximo trimestre definidas como prioridade.",
	"**Responsável**: a Carla revisa o documento de requisitos até sexta-feira.",
	"**Orçamento**: contratação depende da aprovação do financeiro.",
	"**Risco**: dependência do time de infraestrutura para o deploy.",
	"**Tarefa**: ler o capítulo vinte e trazer dúvidas da lista oito.",
];

/**
 * Deterministic pt-BR analyzer. Mirrors the `## ` sections the prompt asks for; answers
 * `pergunta;resposta` lines when the prompt asks for flashcards only.
 */
export class FakeAnalyzer implements AnalyzerPort {
	readonly provider: string;
	readonly model: string;
	/** Requests received, in order. */
	readonly requests: AnalyzeRequest[] = [];
	available: boolean;
	failWith: string | undefined;
	private readonly delayMs: number;

	constructor(options: FakeAnalyzerOptions = {}) {
		this.provider = options.provider ?? "fake";
		this.model = options.model ?? "fake-llm";
		this.available = options.available ?? true;
		this.failWith = options.failWith;
		this.delayMs = options.delayMs ?? 0;
	}

	async isAvailable(): Promise<boolean> {
		return this.available;
	}

	async analyze(request: AnalyzeRequest): Promise<AnalyzeResult> {
		this.requests.push(request);
		if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
		if (this.failWith) throw new AnalysisError(this.failWith);
		return {
			content: this.render(request.userPrompt),
			model: request.model ?? this.model,
			provider: this.provider,
			tokensUsed: Math.ceil(request.userPrompt.length / 4),
		};
	}

	private render(prompt: string): string {
		const headings = [
			...new Set(
				[...prompt.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim()).filter((h) => h.length < 80),
			),
		];
		if (headings.length === 0 && /pergunta;resposta/.test(prompt)) {
			return FLASHCARDS.join("\n");
		}
		const sections = headings.length > 0 ? headings : ["Resumo"];
		return sections
			.map((heading, i) => {
				const body = /flashcard/i.test(heading)
					? FLASHCARDS.slice(0, 4).join("\n")
					: [0, 1, 2].map((j) => `- ${BULLETS[(i + j) % BULLETS.length]}`).join("\n");
				return `## ${heading}\n\n${body}`;
			})
			.join("\n\n");
	}
}
