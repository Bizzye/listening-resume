import Groq from "groq-sdk";
import { DEFAULT_GROQ_LLM_MODEL } from "../../constants.js";
import { AnalysisError, errorMessage } from "../../domain/errors.js";
import type { AnalyzeRequest, AnalyzeResult, AnalyzerPort } from "../../ports/analyzer.js";

export class GroqLLMAdapter implements AnalyzerPort {
	readonly provider = "groq";
	readonly model: string;
	private readonly client: Groq;

	constructor(apiKey: string, model = DEFAULT_GROQ_LLM_MODEL) {
		this.client = new Groq({ apiKey });
		this.model = model;
	}

	async analyze(request: AnalyzeRequest): Promise<AnalyzeResult> {
		const model = request.model ?? this.model;
		try {
			const response = await this.client.chat.completions.create({
				model,
				messages: [
					{ role: "system", content: request.systemPrompt },
					{ role: "user", content: request.userPrompt },
				],
				// Low temperature for fidelity to the transcript. max_tokens is kept at
				// 4096 because Groq counts (prompt + max_tokens) against the per-minute
				// token limit (free tier = 12k TPM); 8k tripped 413 "Request too large"
				// on medium lectures. 4096 still yields a long, structured document.
				temperature: 0.3,
				max_tokens: 4096,
			});
			const content = response.choices[0]?.message?.content?.trim();
			if (!content) throw new AnalysisError("Groq returned an empty response", { upstream: true });
			return {
				content,
				model,
				provider: this.provider,
				tokensUsed: response.usage?.total_tokens,
			};
		} catch (error: unknown) {
			if (error instanceof AnalysisError) throw error;
			const status = (error as { status?: number }).status;
			throw new AnalysisError(`Groq${status ? ` HTTP ${status}` : ""}: ${errorMessage(error)}`, {
				upstream: true,
			});
		}
	}

	async isAvailable(): Promise<boolean> {
		try {
			await this.client.models.list();
			return true;
		} catch {
			return false;
		}
	}
}
