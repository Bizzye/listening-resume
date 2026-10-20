export interface AnalyzeRequest {
	systemPrompt: string;
	/** Fully rendered user prompt (template + transcript). */
	userPrompt: string;
	/** Per-call model override; defaults to the adapter's configured model. */
	model?: string;
}

export interface AnalyzeResult {
	content: string;
	model: string;
	provider: string;
	tokensUsed?: number;
}

export interface AnalyzerPort {
	readonly provider: string;
	readonly model: string;
	analyze(request: AnalyzeRequest): Promise<AnalyzeResult>;
	isAvailable(): Promise<boolean>;
}
