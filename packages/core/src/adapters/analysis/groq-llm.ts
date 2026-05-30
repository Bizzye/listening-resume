import Groq from "groq-sdk";
import type {
  AnalyzerPort,
  AnalyzeOptions,
  AnalyzeResult,
} from "../../ports/analyzer.js";
import { AnalysisError } from "../../domain/errors.js";

export class GroqLLMAdapter implements AnalyzerPort {
  private client: Groq;
  readonly provider = "groq";
  readonly model: string;

  constructor(apiKey: string, model = "llama-3.3-70b-versatile") {
    this.client = new Groq({ apiKey });
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
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new AnalysisError("Groq returned empty response");
      }

      return {
        content,
        model: this.model,
        provider: this.provider,
        tokensUsed: response.usage?.total_tokens,
      };
    } catch (error: unknown) {
      if (error instanceof AnalysisError) throw error;
      const message = error instanceof Error ? error.message : "Unknown error";
      throw new AnalysisError(`Groq LLM analysis failed: ${message}`);
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
