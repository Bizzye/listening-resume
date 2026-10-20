import type { AnalyzerPort } from "../../ports/analyzer.js";

export type AnalysisProvider = "ollama" | "groq";

export interface AnalyzerPair {
	primary: AnalyzerPort;
	fallback: AnalyzerPort | null;
}

/**
 * Respects the configured analysis provider. Groq (cloud 70B, 128k context) extracts far more
 * from long lectures; Ollama (local 8B) is the private, free option. Whichever isn't primary
 * becomes the automatic fallback. Groq can only lead when a key is configured. Pure.
 */
export function selectAnalyzers(
	provider: AnalysisProvider,
	ollama: AnalyzerPort,
	groq: AnalyzerPort | null,
): AnalyzerPair {
	if (provider === "groq" && groq) return { primary: groq, fallback: ollama };
	return { primary: ollama, fallback: groq };
}
