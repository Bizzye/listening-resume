import { Ollama } from "ollama";
import { DEFAULT_ANALYSIS_MODEL, DEFAULT_OLLAMA_HOST } from "../../constants.js";
import { AnalysisError, errorMessage } from "../../domain/errors.js";
import type { AnalyzeRequest, AnalyzeResult, AnalyzerPort } from "../../ports/analyzer.js";

const MIN_CONTEXT = 8192;
const MAX_CONTEXT = 32768;
const OUTPUT_BUDGET = 2048;

/** Context size (tokens) fitting a prompt of `chars` characters plus the answer. Pure. */
export function contextWindowFor(chars: number): number {
	const needed = Math.ceil(chars / 3) + OUTPUT_BUDGET; // ~3 chars/token for pt-BR, conservative
	const pow2 = 2 ** Math.ceil(Math.log2(Math.max(needed, 1)));
	return Math.min(MAX_CONTEXT, Math.max(MIN_CONTEXT, pow2));
}

export class OllamaAdapter implements AnalyzerPort {
	readonly provider = "ollama";
	readonly model: string;
	readonly host: string;
	private readonly client: Ollama;

	constructor(model = DEFAULT_ANALYSIS_MODEL, host = DEFAULT_OLLAMA_HOST) {
		this.model = model;
		this.host = host;
		this.client = new Ollama({ host });
	}

	async analyze(request: AnalyzeRequest): Promise<AnalyzeResult> {
		const model = request.model ?? this.model;
		try {
			const response = await this.client.chat({
				model,
				messages: [
					{ role: "system", content: request.systemPrompt },
					{ role: "user", content: request.userPrompt },
				],
				// Ollama's default context (2–4k tokens) silently truncates long transcripts.
				options: {
					num_ctx: contextWindowFor(request.systemPrompt.length + request.userPrompt.length),
				},
			});
			const content = response.message.content.trim();
			if (!content)
				throw new AnalysisError("Ollama returned an empty response", { upstream: true });
			return { content, model, provider: this.provider, tokensUsed: response.eval_count };
		} catch (error: unknown) {
			if (error instanceof AnalysisError) throw error;
			throw new AnalysisError(`Ollama (${model}): ${errorMessage(error)}`, { upstream: true });
		}
	}

	async isAvailable(): Promise<boolean> {
		try {
			await this.client.list();
			return true;
		} catch {
			return false;
		}
	}

	/** Installed model names (empty when Ollama is offline). */
	async listModels(): Promise<string[]> {
		try {
			const { models } = await this.client.list();
			return models.map((m) => m.name).sort();
		} catch {
			return [];
		}
	}
}
