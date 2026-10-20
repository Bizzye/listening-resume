import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAnalyzer } from "../../../src/adapters/fake/fake-analyzer.js";
import { SQLiteRepository } from "../../../src/adapters/persistence/sqlite.js";
import {
	AnalysisService,
	formatTranscriptForPrompt,
} from "../../../src/application/analysis.service.js";
import {
	AnalysisError,
	ConflictError,
	NotFoundError,
	ValidationError,
} from "../../../src/domain/errors.js";
import type { AnalysisTemplate, Session, Transcript } from "../../../src/domain/models.js";
import { getBuiltinTemplate } from "../../../src/templates/index.js";
import { makeSession } from "../../helpers.js";

const template = getBuiltinTemplate("resumo-executivo") as AnalysisTemplate;

describe("AnalysisService", () => {
	let repo: SQLiteRepository;
	let session: Session;

	const transcript = (sessionId: string): Transcript => ({
		id: `t-${sessionId}`,
		sessionId,
		segments: [
			{ start: 0, end: 4, text: "Bom dia, pessoal." },
			{ start: 65, end: 70, text: "A entropia nunca diminui." },
		],
		fullText: "Bom dia, pessoal. A entropia nunca diminui.",
		language: "pt",
		provider: "fake",
		model: "fake",
		createdAt: new Date().toISOString(),
	});

	beforeEach(() => {
		repo = new SQLiteRepository(":memory:");
		session = makeSession({ status: "transcribed", title: "Aula 12" });
		repo.createSession(session);
		repo.saveTranscript(transcript(session.id));
	});
	afterEach(() => repo.close());

	it("renders the template with title + timestamped transcript and stores the analysis", async () => {
		const analyzer = new FakeAnalyzer();
		const service = new AnalysisService(analyzer, null, repo);
		const analysis = await service.analyzeSession(session.id, template);

		const [request] = analyzer.requests;
		expect(request.systemPrompt).toContain("português do Brasil");
		expect(request.userPrompt).toContain("Título da sessão: Aula 12");
		expect(request.userPrompt).toContain(
			"[0:00] Bom dia, pessoal.\n[1:05] A entropia nunca diminui.",
		);
		expect(request.userPrompt).not.toContain("{transcricao}");
		expect(request.model).toBeUndefined();

		expect(analysis).toMatchObject({ templateId: "resumo-executivo", provider: "fake" });
		expect(analysis.content).toContain("## Contexto");
		expect(repo.getAnalyses(session.id)).toHaveLength(1);
		expect(repo.getSession(session.id)).toMatchObject({ status: "completed", lastError: null });
	});

	it("applies language, model override and extra instructions", async () => {
		const analyzer = new FakeAnalyzer();
		const service = new AnalysisService(analyzer, null, repo);
		const analysis = await service.analyzeSession(session.id, template, {
			language: "en",
			model: "qwen2.5:14b",
			extraInstructions: "Seja breve.",
		});
		const [request] = analyzer.requests;
		expect(request.systemPrompt).toContain("ALWAYS answer in English");
		expect(request.systemPrompt).toContain("Instruções adicionais: Seja breve.");
		expect(request.model).toBe("qwen2.5:14b");
		expect(analysis.model).toBe("qwen2.5:14b");
	});

	it("falls back when the primary is unavailable or fails (without the model override)", async () => {
		const fallback = new FakeAnalyzer({ provider: "groq", model: "llama-3.3-70b-versatile" });
		const offline = new AnalysisService(new FakeAnalyzer({ available: false }), fallback, repo);
		const a = await offline.analyzeSession(session.id, template, { model: "llama3.1:8b" });
		expect(a).toMatchObject({ provider: "groq", model: "llama-3.3-70b-versatile" });
		expect(fallback.requests[0].model).toBeUndefined();

		const broken = new AnalysisService(new FakeAnalyzer({ failWith: "boom" }), fallback, repo);
		expect((await broken.analyzeSession(session.id, template)).provider).toBe("groq");
		expect(repo.countAnalyses(session.id)).toBe(2);
	});

	it("restores the previous status and records lastError on failure", async () => {
		const service = new AnalysisService(new FakeAnalyzer({ available: false }), null, repo);
		const err = await service.analyzeSession(session.id, template).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(AnalysisError);
		expect((err as Error).message).toMatch(/Ollama não está em execução/);
		expect(repo.getSession(session.id)).toMatchObject({
			status: "transcribed",
			lastError: (err as Error).message,
		});

		repo.updateSession(session.id, { status: "completed" });
		const healthy = new AnalysisService(new FakeAnalyzer(), null, repo);
		const failing = new FakeAnalyzer({ failWith: "Ollama (x): connect ECONNREFUSED" });
		await new AnalysisService(failing, null, repo)
			.analyzeSession(session.id, template)
			.catch(() => {});
		expect(repo.getSession(session.id)).toMatchObject({
			status: "completed",
			lastError: expect.stringMatching(/Ollama/),
		});
		await healthy.analyzeSession(session.id, template);
		expect(repo.getSession(session.id)?.lastError).toBeNull();
	});

	it("validates the session and transcript before changing status", async () => {
		const service = new AnalysisService(new FakeAnalyzer(), null, repo);
		await expect(service.analyzeSession("nope", template)).rejects.toBeInstanceOf(NotFoundError);

		const bare = makeSession({ status: "stopped" });
		repo.createSession(bare);
		await expect(service.analyzeSession(bare.id, template)).rejects.toBeInstanceOf(ValidationError);
		expect(repo.getSession(bare.id)?.status).toBe("stopped");

		const empty = makeSession({ status: "transcribed" });
		repo.createSession(empty);
		repo.saveTranscript({ ...transcript(empty.id), segments: [], fullText: "  " });
		await expect(service.analyzeSession(empty.id, template)).rejects.toThrow(/vazia/);
	});

	it("formats transcripts without segments as plain text", () => {
		expect(
			formatTranscriptForPrompt({ ...transcript("x"), segments: [], fullText: " só texto " }),
		).toBe("só texto");
	});

	it("refuses (409) while the session is analyzing, transcribing or recording", async () => {
		const service = new AnalysisService(new FakeAnalyzer(), null, repo);
		for (const status of ["analyzing", "transcribing", "recording"] as const) {
			repo.updateSession(session.id, { status });
			await expect(service.analyzeSession(session.id, template)).rejects.toBeInstanceOf(
				ConflictError,
			);
			expect(repo.getSession(session.id)?.status).toBe(status);
		}
		expect(repo.countAnalyses(session.id)).toBe(0);
	});
});
