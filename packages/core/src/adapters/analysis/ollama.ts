import { Ollama } from "ollama";
import type {
  AnalyzerPort,
  AnalyzeOptions,
  AnalyzeResult,
} from "../../ports/analyzer.js";
import { AnalysisError } from "../../domain/errors.js";

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
