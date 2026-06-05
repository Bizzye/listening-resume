import { v4 as uuid } from "uuid";
import { AnalysisError } from "../domain/errors.js";
import type { Analysis } from "../domain/models.js";
import type { AnalysisTemplate, AnalyzeResult, AnalyzerPort } from "../ports/analyzer.js";
import type { SessionRepository } from "../ports/repository.js";
import { logger } from "../utils/logger.js";

export class AnalysisService {
	constructor(
		private analyzer: AnalyzerPort,
		private fallbackAnalyzer: AnalyzerPort | null,
		private repo: SessionRepository,
	) {}

	async analyzeSession(
		sessionId: string,
		template: AnalysisTemplate,
		extraPrompt?: string,
	): Promise<Analysis> {
		const transcript = this.repo.getTranscript(sessionId);
		if (!transcript) {
			throw new AnalysisError("No transcript found for session. Transcribe first.");
		}

		this.repo.updateSession(sessionId, { status: "analyzing" });

		let result: AnalyzeResult | undefined;
		try {
			const available = await this.analyzer.isAvailable();
			if (!available) throw new AnalysisError("Primary analyzer unavailable");

			logger.info(`Analyzing with ${this.analyzer.provider}/${this.analyzer.model}...`);
			result = await this.analyzer.analyze({
				template,
				transcript: transcript.fullText,
				extraPrompt,
			});
		} catch (err) {
			if (!this.fallbackAnalyzer) throw err;
			logger.warn(`Primary analyzer failed, trying fallback...`);
			result = await this.fallbackAnalyzer.analyze({
				template,
				transcript: transcript.fullText,
				extraPrompt,
			});
		}

		const analysis: Analysis = {
			id: uuid(),
			sessionId,
			templateId: template.id,
			provider: result.provider,
			model: result.model,
			content: result.content,
			createdAt: new Date().toISOString(),
		};

		this.repo.saveAnalysis(analysis);
		this.repo.updateSession(sessionId, { status: "completed" });

		return analysis;
	}
}
