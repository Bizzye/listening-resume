import { Ollama } from "ollama";
import { DEFAULT_ANALYSIS_MODEL, DEFAULT_OLLAMA_HOST } from "../../constants.js";
import { AnalysisError, errorMessage } from "../../domain/errors.js";
import type { AnalyzeRequest, AnalyzeResult, AnalyzerPort } from "../../ports/analyzer.js";

/**
 * Ollama defaults num_ctx to ~2048, which silently truncates long lecture transcripts — the model
 * would only "see" the first minutes. 8192 fits an ~40 min class AND keeps an 8B model fully on an
 * 8 GB GPU (a bigger context spills to CPU and the analysis crawls). For long lectures, Groq
 * (70B, 128k context) is the better primary (`config.analysis.provider = "groq"`).
 * Low temperature keeps the output faithful to the transcript.
 */
export const OLLAMA_CHAT_OPTIONS = { num_ctx: 8192, num_predict: 4096, temperature: 0.3 } as const;

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
				options: { ...OLLAMA_CHAT_OPTIONS },
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
