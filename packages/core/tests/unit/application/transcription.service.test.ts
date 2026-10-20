import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeTranscriber } from "../../../src/adapters/fake/fake-transcriber.js";
import { LocalFileStorage } from "../../../src/adapters/persistence/local-files.js";
import { SQLiteRepository } from "../../../src/adapters/persistence/sqlite.js";
import { TranscriptionService } from "../../../src/application/transcription.service.js";
import { ConflictError, NotFoundError, TranscriptionError } from "../../../src/domain/errors.js";
import type { Session } from "../../../src/domain/models.js";
import type { TranscriptionProvider } from "../../../src/ports/transcriber.js";
import { makeSession, makeTempDir, writeToneWav } from "../../helpers.js";

const limits = { requestsPerMinute: 100, audioSecondsPerHour: 100_000 };

describe("TranscriptionService", () => {
	let dir: string;
	let cleanup: () => void;
	let repo: SQLiteRepository;
	let session: Session;

	function addChunks(seconds: number[]): void {
		seconds.forEach((s, index) => {
			const file = writeToneWav(path.join(dir, session.id, `chunk_${index}.wav`), s);
			repo.addChunk({
				id: `${session.id}-${index}`,
				sessionId: session.id,
				index,
				path: file,
				durationMs: index === 1 ? null : s * 1000, // null → read from the WAV header
				sampleRate: 16000,
				status: "recorded",
			});
		});
	}

	beforeEach(() => {
		({ dir, cleanup } = makeTempDir());
		repo = new SQLiteRepository(":memory:");
		session = makeSession({ status: "stopped", lastError: "erro antigo" });
		repo.createSession(session);
	});
	afterEach(() => {
		repo.close();
		cleanup();
	});

	it("transcribes chunks in order, offsetting by the real chunk durations", async () => {
		addChunks([4, 6, 2]);
		const transcriber = new FakeTranscriber({ segmentsPerChunk: 2 });
		const service = new TranscriptionService(transcriber, repo, limits);

		const transcript = await service.transcribeSession(session.id);
		expect(transcript.segments.map((s) => [s.start, s.end])).toEqual([
			[0, 2],
			[2, 4],
			[4, 7],
			[7, 10],
			[10, 11],
			[11, 12],
		]);
		expect(transcript.fullText.split(" ").length).toBeGreaterThan(10);
		expect(transcript).toMatchObject({ provider: "fake", model: "fake-whisper", language: "pt" });
		expect(repo.getTranscript(session.id)?.id).toBe(transcript.id);
		expect(repo.getSession(session.id)).toMatchObject({
			status: "transcribed",
			lastError: null,
			language: "pt",
		});
		expect(repo.getChunks(session.id).every((c) => c.status === "transcribed")).toBe(true);
	});

	it("passes language/prompt and keeps an explicit language", async () => {
		addChunks([1]);
		const transcriber = new FakeTranscriber();
		const spy = vi.spyOn(transcriber, "transcribe");
		const service = new TranscriptionService(transcriber, repo, limits);
		const t = await service.transcribeSession(session.id, { language: "en", prompt: "Kubernetes" });
		expect(spy).toHaveBeenCalledWith(expect.any(String), { language: "en", prompt: "Kubernetes" });
		expect(t.language).toBe("en");
	});

	it("picks the provider per call through a factory", async () => {
		addChunks([1]);
		const made: (TranscriptionProvider | undefined)[] = [];
		const service = new TranscriptionService(
			(provider) => {
				made.push(provider);
				return new FakeTranscriber({ provider: provider ?? "default" });
			},
			repo,
			limits,
		);
		expect(
			(await service.transcribeSession(session.id, { provider: "whisper-cpp" })).provider,
		).toBe("whisper-cpp");
		expect((await service.transcribeSession(session.id, { provider: "groq" })).provider).toBe(
			"groq",
		);
		expect(made).toEqual(["whisper-cpp", "groq"]);
	});

	it("re-transcription replaces the transcript", async () => {
		addChunks([1]);
		const service = new TranscriptionService(new FakeTranscriber(), repo, limits);
		const first = await service.transcribeSession(session.id);
		const second = await service.transcribeSession(session.id);
		expect(second.id).not.toBe(first.id);
		expect(repo.getTranscript(session.id)?.id).toBe(second.id);
	});

	it("only rate-limits providers that count against the Groq quota", async () => {
		addChunks([1, 1]);
		const local = new TranscriptionService(new FakeTranscriber(), repo, limits);
		const localSpy = vi.spyOn(
			(local as unknown as { limiter: { waitForSlot: () => Promise<void> } }).limiter,
			"waitForSlot",
		);
		await local.transcribeSession(session.id);
		expect(localSpy).not.toHaveBeenCalled();

		const remote = new TranscriptionService(
			new FakeTranscriber({ rateLimited: true }),
			repo,
			limits,
		);
		const remoteSpy = vi.spyOn(
			(remote as unknown as { limiter: { waitForSlot: (s: number) => Promise<void> } }).limiter,
			"waitForSlot",
		);
		await remote.transcribeSession(session.id);
		expect(remoteSpy.mock.calls.map((c) => c[0])).toEqual([1, 1]);
	});

	it("marks the session failed with a human-readable lastError", async () => {
		addChunks([1]);
		const service = new TranscriptionService(
			new FakeTranscriber({ failWith: "Groq HTTP 429: rate_limit_exceeded" }),
			repo,
			limits,
		);
		const err = await service.transcribeSession(session.id).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(TranscriptionError);
		expect((err as Error).message).toMatch(/Limite de uso do Groq/);
		expect(repo.getSession(session.id)).toMatchObject({
			status: "failed",
			lastError: (err as Error).message,
		});
		expect(repo.getTranscript(session.id)).toBeNull();
	});

	it("fails clearly without audio, with a missing file, or when the factory throws", async () => {
		const storage = new LocalFileStorage(dir);
		const service = new TranscriptionService(new FakeTranscriber(), repo, limits, storage);
		await expect(service.transcribeSession(session.id)).rejects.toThrow(/Nenhum áudio/);
		expect(repo.getSession(session.id)?.lastError).toMatch(/Nenhum áudio/);

		repo.addChunk({
			id: "gone",
			sessionId: session.id,
			index: 0,
			path: path.join(dir, "gone.wav"),
			durationMs: 1000,
			sampleRate: 16000,
			status: "recorded",
		});
		await expect(service.transcribeSession(session.id)).rejects.toThrow(
			"Arquivo de áudio não encontrado: gone.wav",
		);

		const noKey = new TranscriptionService(
			() => {
				throw new TranscriptionError("Chave da API do Groq não configurada.");
			},
			repo,
			limits,
		);
		await expect(noKey.transcribeSession(session.id)).rejects.toThrow(/não configurada/);
		expect(repo.getSession(session.id)).toMatchObject({
			status: "failed",
			lastError: "Chave da API do Groq não configurada.",
		});
	});

	it("rejects unknown and still-recording sessions without touching them", async () => {
		const service = new TranscriptionService(new FakeTranscriber(), repo, limits);
		await expect(service.transcribeSession("nope")).rejects.toBeInstanceOf(NotFoundError);
		const recording = makeSession({ status: "recording" });
		repo.createSession(recording);
		await expect(service.transcribeSession(recording.id)).rejects.toBeInstanceOf(ConflictError);
		expect(repo.getSession(recording.id)?.status).toBe("recording");
	});

	it("refuses (409) to start while the session is already transcribing or analyzing", async () => {
		addChunks([1]);
		const service = new TranscriptionService(new FakeTranscriber(), repo, limits);
		for (const status of ["transcribing", "analyzing"] as const) {
			repo.updateSession(session.id, { status });
			await expect(service.transcribeSession(session.id)).rejects.toBeInstanceOf(ConflictError);
			expect(repo.getSession(session.id)?.status).toBe(status);
		}
	});

	it("a failed re-transcription keeps the previous transcript and settles back", async () => {
		addChunks([1]);
		await new TranscriptionService(new FakeTranscriber(), repo, limits).transcribeSession(
			session.id,
		);
		const failing = new TranscriptionService(
			new FakeTranscriber({ failWith: "Groq HTTP 429: rate_limit_exceeded" }),
			repo,
			limits,
		);
		await expect(failing.transcribeSession(session.id)).rejects.toBeInstanceOf(TranscriptionError);
		expect(repo.getSession(session.id)).toMatchObject({
			status: "transcribed",
			lastError: expect.stringMatching(/Limite de uso do Groq/),
		});
		expect(repo.getTranscript(session.id)).not.toBeNull();

		repo.saveAnalysis({
			id: "a-1",
			sessionId: session.id,
			templateId: "resumo-executivo",
			provider: "fake",
			model: "fake",
			content: "x",
			createdAt: new Date().toISOString(),
		});
		repo.updateSession(session.id, { status: "completed" });
		await failing.transcribeSession(session.id).catch(() => {});
		expect(repo.getSession(session.id)?.status).toBe("completed");
	});
});
