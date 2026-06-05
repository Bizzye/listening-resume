import { beforeEach, describe, expect, it, vi } from "vitest";
import { AnalysisService } from "../../../src/application/analysis.service.js";
import { AnalysisError } from "../../../src/domain/errors.js";
import type { Transcript } from "../../../src/domain/models.js";
import type { AnalyzerPort } from "../../../src/ports/analyzer.js";
import type { SessionRepository } from "../../../src/ports/repository.js";

describe("AnalysisService", () => {
	let mockAnalyzer: AnalyzerPort;
	let mockFallback: AnalyzerPort;
	let mockRepo: SessionRepository;
	let service: AnalysisService;

	const template = {
		id: "meeting-summary",
		name: "Meeting Summary",
		systemPrompt: "You are a summarizer.",
		userPromptTemplate: "Summarize: {{transcript}}",
	};

	const mockTranscript: Transcript = {
		id: "t1",
		sessionId: "s1",
		segments: [],
		fullText: "Hello world discussion",
		language: "en",
		provider: "groq",
		model: "whisper",
		createdAt: "2024-01-01",
	};

	beforeEach(() => {
		mockAnalyzer = {
			provider: "ollama",
			model: "llama3.1:8b",
			analyze: vi.fn(),
			isAvailable: vi.fn(),
		};

		mockFallback = {
			provider: "groq",
			model: "llama-3.3-70b",
			analyze: vi.fn(),
			isAvailable: vi.fn(),
		};

		mockRepo = {
			createSession: vi.fn(),
			updateSession: vi.fn(),
			getSession: vi.fn(),
			listSessions: vi.fn(),
			addChunk: vi.fn(),
			updateChunk: vi.fn(),
			getChunks: vi.fn(),
			saveTranscript: vi.fn(),
			getTranscript: vi.fn(),
			saveAnalysis: vi.fn(),
			getAnalyses: vi.fn(),
		};

		service = new AnalysisService(mockAnalyzer, mockFallback, mockRepo);
	});

	it("analyzes session with primary analyzer", async () => {
		vi.mocked(mockRepo.getTranscript).mockReturnValue(mockTranscript);
		vi.mocked(mockAnalyzer.isAvailable).mockResolvedValue(true);
		vi.mocked(mockAnalyzer.analyze).mockResolvedValue({
			content: "Summary of discussion",
			model: "llama3.1:8b",
			provider: "ollama",
		});

		const result = await service.analyzeSession("s1", template);

		expect(result.content).toBe("Summary of discussion");
		expect(result.provider).toBe("ollama");
		expect(mockRepo.saveAnalysis).toHaveBeenCalledTimes(1);
		expect(mockRepo.updateSession).toHaveBeenCalledWith("s1", {
			status: "completed",
		});
	});

	it("falls back when primary is unavailable", async () => {
		vi.mocked(mockRepo.getTranscript).mockReturnValue(mockTranscript);
		vi.mocked(mockAnalyzer.isAvailable).mockResolvedValue(false);
		vi.mocked(mockFallback.analyze).mockResolvedValue({
			content: "Fallback summary",
			model: "llama-3.3-70b",
			provider: "groq",
		});

		const result = await service.analyzeSession("s1", template);

		expect(result.content).toBe("Fallback summary");
		expect(result.provider).toBe("groq");
	});

	it("falls back when primary throws error", async () => {
		vi.mocked(mockRepo.getTranscript).mockReturnValue(mockTranscript);
		vi.mocked(mockAnalyzer.isAvailable).mockResolvedValue(true);
		vi.mocked(mockAnalyzer.analyze).mockRejectedValue(new Error("connection refused"));
		vi.mocked(mockFallback.analyze).mockResolvedValue({
			content: "Fallback result",
			model: "llama-3.3-70b",
			provider: "groq",
		});

		const result = await service.analyzeSession("s1", template);
		expect(result.content).toBe("Fallback result");
	});

	it("throws when no transcript exists", async () => {
		vi.mocked(mockRepo.getTranscript).mockReturnValue(null);

		await expect(service.analyzeSession("s1", template)).rejects.toThrow(AnalysisError);
	});

	it("throws when both primary and fallback are null/fail", async () => {
		vi.mocked(mockRepo.getTranscript).mockReturnValue(mockTranscript);
		vi.mocked(mockAnalyzer.isAvailable).mockResolvedValue(false);

		const serviceNoFallback = new AnalysisService(mockAnalyzer, null, mockRepo);
		await expect(serviceNoFallback.analyzeSession("s1", template)).rejects.toThrow();
	});
});
