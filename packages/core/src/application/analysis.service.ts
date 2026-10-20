import { randomUUID } from "node:crypto";
import { AnalysisError, errorMessage, NotFoundError, ValidationError } from "../domain/errors.js";
import type {
	Analysis,
	AnalysisLanguage,
	AnalysisTemplate,
	SessionStatus,
	Transcript,
} from "../domain/models.js";
import { assertTransition } from "../domain/states.js";
import type { AnalyzeRequest, AnalyzeResult, AnalyzerPort } from "../ports/analyzer.js";
import type { SessionRepository } from "../ports/repository.js";
import { buildSystemPrompt, renderTemplatePrompt } from "../templates/index.js";
import { formatTimestamp } from "../utils/format.js";
import { logger } from "../utils/logger.js";
import { describeFailure } from "./error-messages.js";
import { statusFromArtifacts } from "./session-status.js";

export interface AnalyzeSessionOptions {
	/** Language of the generated analysis (default "pt-BR"). */
	language?: AnalysisLanguage;
	/** Model override for the PRIMARY analyzer (e.g. the Ollama model chosen in settings). */
	model?: string;
	/** Extra instructions appended to the system prompt. */
	extraInstructions?: string;
}

const UNAVAILABLE_MESSAGE =
	"O Ollama não está em execução. Inicie-o (`ollama serve`) ou configure uma chave do Groq como alternativa.";

/** Transcript as `[m:ss] text` lines, so the model can cite timestamps. Pure. */
export function formatTranscriptForPrompt(transcript: Transcript): string {
	if (transcript.segments.length === 0) return transcript.fullText.trim();
	return transcript.segments.map((s) => `[${formatTimestamp(s.start)}] ${s.text}`).join("\n");
}

/**
 * Runs a template over a session's transcript: primary analyzer (Ollama), falling back to the
 * secondary (Groq) when the primary is unavailable or fails. Status: → analyzing → completed;
 * on failure the previous status is restored and `lastError` set (pt-BR).
 */
export class AnalysisService {
	constructor(
		private readonly analyzer: AnalyzerPort,
		private readonly fallbackAnalyzer: AnalyzerPort | null,
		private readonly repo: SessionRepository,
	) {}

	async analyzeSession(
		sessionId: string,
		template: AnalysisTemplate,
		options: AnalyzeSessionOptions = {},
	): Promise<Analysis> {
		const session = this.repo.getSession(sessionId);
		if (!session) throw new NotFoundError("Sessão não encontrada.");
		const transcript = this.repo.getTranscript(sessionId);
		if (!transcript) {
			throw new ValidationError("Transcreva a sessão antes de gerar uma análise.");
		}
		const transcriptText = formatTranscriptForPrompt(transcript);
		if (!transcriptText) {
			throw new ValidationError("A transcrição está vazia — não há o que analisar.");
		}

		const extra = options.extraInstructions?.trim();
		const request: AnalyzeRequest = {
			systemPrompt: extra
				? `${buildSystemPrompt(options.language)}\n\nInstruções adicionais: ${extra}`
				: buildSystemPrompt(options.language),
			userPrompt: renderTemplatePrompt(template.prompt, {
				transcript: transcriptText,
				title: session.title,
			}),
		};

		// Throws ConflictError while recording / transcribing / analyzing.
		assertTransition(session.status, "analyzing");

		const previous: SessionStatus =
			session.status === "completed"
				? "completed"
				: (statusFromArtifacts(this.repo, sessionId) ?? "transcribed");
		// Synchronous before the first await: callers see `analyzing` right away.
		this.repo.updateSession(sessionId, { status: "analyzing", lastError: null });

		let result: AnalyzeResult;
		try {
			result = await this.runWithFallback(request, options.model);
		} catch (err) {
			const message = describeFailure(err, "analysis");
			logger.error(`Analysis of ${sessionId} failed: ${errorMessage(err)}`);
			this.repo.updateSession(sessionId, { status: previous, lastError: message });
			throw new AnalysisError(message);
		}

		const analysis: Analysis = {
			id: randomUUID(),
			sessionId,
			templateId: template.id,
			provider: result.provider,
			model: result.model,
			content: result.content,
			createdAt: new Date().toISOString(),
		};
		this.repo.saveAnalysis(analysis);
		this.repo.updateSession(sessionId, { status: "completed", lastError: null });
		return analysis;
	}

	private async runWithFallback(request: AnalyzeRequest, model?: string): Promise<AnalyzeResult> {
		try {
			if (!(await this.analyzer.isAvailable())) throw new AnalysisError(UNAVAILABLE_MESSAGE);
			logger.info(`Analyzing with ${this.analyzer.provider}/${model ?? this.analyzer.model}...`);
			return await this.analyzer.analyze({ ...request, model });
		} catch (err) {
			if (!this.fallbackAnalyzer) throw err;
			logger.warn(
				`${this.analyzer.provider} failed (${errorMessage(err)}); falling back to ${this.fallbackAnalyzer.provider}`,
			);
			return await this.fallbackAnalyzer.analyze(request);
		}
	}
}
