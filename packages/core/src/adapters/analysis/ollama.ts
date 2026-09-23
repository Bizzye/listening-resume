import { Ollama } from "ollama";
import { AnalysisError } from "../../domain/errors.js";
import type { AnalyzeOptions, AnalyzeResult, AnalyzerPort } from "../../ports/analyzer.js";

export class OllamaAdapter implements AnalyzerPort {
	private client: Ollama;
	readonly provider = "ollama";
	readonly model: string;

	constructor(model = "llama3.1:8b", host = "http://127.0.0.1:11434") {
		this.client = new Ollama({ host });
		this.model = model;
	}

	async analyze(options: AnalyzeOptions): Promise<AnalyzeResult> {
		const userPrompt = options.template.userPromptTemplate.replace(
			"{{transcript}}",
			options.transcript,
		);

		const { ANALYSIS_SYSTEM_PROMPT } = await import("../../ports/analyzer.js");
		const systemPrompt = options.extraPrompt
			? `${ANALYSIS_SYSTEM_PROMPT}\n\nInstruções adicionais: ${options.extraPrompt}`
			: ANALYSIS_SYSTEM_PROMPT;

		try {
			const response = await this.client.chat({
				model: this.model,
				messages: [
					{ role: "system", content: systemPrompt },
					{ role: "user", content: userPrompt },
				],
				options: {
					// Ollama defaults num_ctx to ~2048, which silently truncates long
					// lecture transcripts — the model would only "see" the first minutes.
					// 8192 fits an ~40min class AND keeps the 8B model fully on an 8GB
					// GPU (bigger spills to CPU and the analysis crawls). For long
					// lectures, Groq (70B, 128k ctx) is the configured primary.
					num_ctx: 8192,
					num_predict: 4096,
					temperature: 0.3,
				},
			});

			return {
				content: response.message.content,
				model: this.model,
				provider: this.provider,
				tokensUsed: response.eval_count,
			};
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "Unknown error";
			throw new AnalysisError(`Ollama analysis failed: ${message}`);
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
}
