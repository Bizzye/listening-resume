import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SQLiteRepository } from "../../../src/adapters/persistence/sqlite.js";
import type { Analysis, AudioChunk, Session, Transcript } from "../../../src/domain/models.js";

describe("SQLiteRepository", () => {
	let repo: SQLiteRepository;
	let dbPath: string;

	beforeEach(() => {
		dbPath = path.join(os.tmpdir(), `test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
		repo = new SQLiteRepository(dbPath);
	});

	afterEach(() => {
		try {
			fs.unlinkSync(dbPath);
		} catch {}
		try {
			fs.unlinkSync(`${dbPath}-journal`);
		} catch {}
		try {
			fs.unlinkSync(`${dbPath}-wal`);
		} catch {}
		try {
			fs.unlinkSync(`${dbPath}-shm`);
		} catch {}
	});

	const makeSession = (overrides?: Partial<Session>): Session => ({
		id: "session-1",
		title: "Test Session",
		status: "created",
		startedAt: null,
		endedAt: null,
		audioSource: "default.monitor",
		language: "auto",
		createdAt: "2024-01-15T10:00:00Z",
		...overrides,
	});

	describe("sessions", () => {
		it("creates and retrieves a session", () => {
			const session = makeSession();
			repo.createSession(session);

			const retrieved = repo.getSession("session-1");
			expect(retrieved).toEqual(session);
		});

		it("updates session fields", () => {
			repo.createSession(makeSession());
			repo.updateSession("session-1", {
				status: "recording",
				startedAt: "2024-01-15T10:01:00Z",
			});

			const updated = repo.getSession("session-1");
			expect(updated?.status).toBe("recording");
			expect(updated?.startedAt).toBe("2024-01-15T10:01:00Z");
		});

		it("lists sessions", () => {
			repo.createSession(makeSession({ id: "s1" }));
			repo.createSession(makeSession({ id: "s2" }));
			repo.createSession(makeSession({ id: "s3" }));

			const list = repo.listSessions(2);
			expect(list).toHaveLength(2);
		});

		it("returns null for nonexistent session", () => {
			expect(repo.getSession("nonexistent")).toBeNull();
		});
	});

	describe("chunks", () => {
		it("adds and retrieves chunks", () => {
			repo.createSession(makeSession());

			const chunk: AudioChunk = {
				id: "chunk-1",
				sessionId: "session-1",
				index: 0,
				path: "/tmp/chunk_0000.wav",
				durationMs: 30000,
				sampleRate: 16000,
				status: "recorded",
			};

			repo.addChunk(chunk);
			const chunks = repo.getChunks("session-1");
			expect(chunks).toHaveLength(1);
			expect(chunks[0]).toEqual(chunk);
		});

		it("updates chunk status", () => {
			repo.createSession(makeSession());
			repo.addChunk({
				id: "chunk-1",
				sessionId: "session-1",
				index: 0,
				path: "/tmp/chunk.wav",
				durationMs: 30000,
				sampleRate: 16000,
				status: "recorded",
			});

			repo.updateChunk("chunk-1", { status: "transcribed" });
			const chunks = repo.getChunks("session-1");
			expect(chunks[0].status).toBe("transcribed");
		});
	});

	describe("transcripts", () => {
		it("saves and retrieves transcript", () => {
			repo.createSession(makeSession());

			const transcript: Transcript = {
				id: "t-1",
				sessionId: "session-1",
				segments: [{ start: 0, end: 5, text: "Hello" }],
				fullText: "Hello",
				language: "en",
				provider: "groq",
				model: "whisper-large-v3-turbo",
				createdAt: "2024-01-15T10:05:00Z",
			};

			repo.saveTranscript(transcript);
			const retrieved = repo.getTranscript("session-1");
			expect(retrieved).toEqual(transcript);
		});

		it("returns null when no transcript", () => {
			repo.createSession(makeSession());
			expect(repo.getTranscript("session-1")).toBeNull();
		});
	});

	describe("analyses", () => {
		it("saves and retrieves analyses", () => {
			repo.createSession(makeSession());

			const analysis: Analysis = {
				id: "a-1",
				sessionId: "session-1",
				templateId: "meeting-summary",
				provider: "ollama",
				model: "llama3.1:8b",
				content: "Summary content here.",
				createdAt: "2024-01-15T10:10:00Z",
			};

			repo.saveAnalysis(analysis);
			const analyses = repo.getAnalyses("session-1");
			expect(analyses).toHaveLength(1);
			expect(analyses[0]).toEqual(analysis);
		});

		it("supports multiple analyses per session", () => {
			repo.createSession(makeSession());

			repo.saveAnalysis({
				id: "a-1",
				sessionId: "session-1",
				templateId: "meeting-summary",
				provider: "ollama",
				model: "llama3.1:8b",
				content: "Summary",
				createdAt: "2024-01-15T10:10:00Z",
			});

			repo.saveAnalysis({
				id: "a-2",
				sessionId: "session-1",
				templateId: "action-items",
				provider: "ollama",
				model: "llama3.1:8b",
				content: "Action items",
				createdAt: "2024-01-15T10:11:00Z",
			});

			const analyses = repo.getAnalyses("session-1");
			expect(analyses).toHaveLength(2);
		});
	});
});
