import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SQLiteRepository } from "../../../src/adapters/persistence/sqlite.js";
import { NotFoundError, ValidationError } from "../../../src/domain/errors.js";
import { BUILTIN_TEMPLATES } from "../../../src/templates/index.js";
import { makeSession, makeTempDir } from "../../helpers.js";

describe("SQLiteRepository", () => {
	let repo: SQLiteRepository;

	beforeEach(() => {
		repo = new SQLiteRepository(":memory:");
	});
	afterEach(() => repo.close());

	describe("sessions", () => {
		it("creates, reads and updates including exportDir/lastError", () => {
			const session = makeSession();
			repo.createSession(session);
			expect(repo.getSession(session.id)).toEqual(session);

			repo.updateSession(session.id, {
				title: "Novo título",
				exportDir: "D:\\Exports",
				lastError: "Falha",
				status: "failed",
			});
			expect(repo.getSession(session.id)).toMatchObject({
				title: "Novo título",
				exportDir: "D:\\Exports",
				lastError: "Falha",
				status: "failed",
			});

			repo.updateSession(session.id, { exportDir: null, lastError: null });
			expect(repo.getSession(session.id)).toMatchObject({ exportDir: null, lastError: null });
			expect(repo.getSession("missing")).toBeNull();
		});

		it("ignores empty updates", () => {
			const session = makeSession();
			repo.createSession(session);
			repo.updateSession(session.id, {});
			repo.updateSession(session.id, { title: undefined });
			expect(repo.getSession(session.id)).toEqual(session);
		});

		it("lists newest first with a limit", () => {
			const old = makeSession({ startedAt: "2026-01-01T10:00:00.000Z" });
			const mid = makeSession({ startedAt: "2026-05-01T10:00:00.000Z" });
			const recent = makeSession({ startedAt: "2026-09-01T10:00:00.000Z" });
			for (const s of [mid, old, recent]) repo.createSession(s);
			expect(repo.listSessions().map((s) => s.id)).toEqual([recent.id, mid.id, old.id]);
			expect(repo.listSessions({ limit: 2 }).map((s) => s.id)).toEqual([recent.id, mid.id]);
		});

		it("searches title and transcript text, escaping LIKE wildcards", () => {
			const a = makeSession({ title: "Aula de Física" });
			const b = makeSession({ title: "Reunião semanal" });
			const c = makeSession({ title: "100% útil" });
			for (const s of [a, b, c]) repo.createSession(s);
			repo.saveTranscript({
				id: "t1",
				sessionId: b.id,
				segments: [],
				fullText: "o rollout do Pix parcelado fica para a sprint 34",
				language: "pt",
				provider: "fake",
				model: "fake",
				createdAt: new Date().toISOString(),
			});
			expect(repo.listSessions({ query: "física" }).map((s) => s.id)).toEqual([a.id]);
			expect(repo.listSessions({ query: "pix PARCELADO" }).map((s) => s.id)).toEqual([b.id]);
			expect(repo.listSessions({ query: "100%" }).map((s) => s.id)).toEqual([c.id]);
			expect(repo.listSessions({ query: "%" }).map((s) => s.id)).toEqual([c.id]);
			expect(repo.listSessions({ query: "   " })).toHaveLength(3);
		});

		it("finds by exact id or unique prefix", () => {
			const a = makeSession({ id: "abc12345-0000-4000-8000-000000000001" });
			const b = makeSession({ id: "abc12399-0000-4000-8000-000000000002" });
			repo.createSession(a);
			repo.createSession(b);
			expect(repo.findSessionByIdPrefix(a.id)?.id).toBe(a.id);
			expect(repo.findSessionByIdPrefix("abc123")).toBeNull(); // ambiguous
			expect(repo.findSessionByIdPrefix("abc1234")?.id).toBe(a.id);
			expect(repo.findSessionByIdPrefix("abc1239")?.id).toBe(b.id);
			expect(repo.findSessionByIdPrefix("zzz")).toBeNull();
			expect(repo.findSessionByIdPrefix("")).toBeNull();
			expect(repo.findSessionByIdPrefix("%")).toBeNull();
		});

		it("finds sessions by status", () => {
			const rec = makeSession({ status: "recording" });
			const tr = makeSession({ status: "transcribing" });
			const done = makeSession({ status: "completed" });
			for (const s of [rec, tr, done]) repo.createSession(s);
			const ids = repo.findSessionsByStatus(["recording", "transcribing"]).map((s) => s.id);
			expect(ids.sort()).toEqual([rec.id, tr.id].sort());
			expect(repo.findSessionsByStatus([])).toEqual([]);
		});

		it("deletes a session with its chunks, transcript and analyses", () => {
			const s = makeSession();
			repo.createSession(s);
			repo.addChunk({
				id: "c1",
				sessionId: s.id,
				index: 0,
				path: "a.wav",
				durationMs: 1000,
				sampleRate: 16000,
				status: "recorded",
			});
			repo.saveAnalysis({
				id: "a1",
				sessionId: s.id,
				templateId: "resumo-executivo",
				provider: "fake",
				model: "fake",
				content: "x",
				createdAt: new Date().toISOString(),
			});
			repo.deleteSession(s.id);
			expect(repo.getSession(s.id)).toBeNull();
			expect(repo.getChunks(s.id)).toEqual([]);
			expect(repo.countAnalyses(s.id)).toBe(0);
		});
	});

	describe("chunks, transcripts, analyses", () => {
		it("addChunk ignores a second row for the same session + path", () => {
			const s = makeSession();
			repo.createSession(s);
			const chunk = {
				id: "c-1",
				sessionId: s.id,
				index: 0,
				path: "x.wav",
				durationMs: 1000,
				sampleRate: 16000,
				status: "recorded" as const,
			};
			expect(repo.addChunk(chunk)).toBe(true);
			expect(repo.addChunk({ ...chunk, id: "c-2" })).toBe(false);
			expect(repo.getChunks(s.id).map((c) => c.id)).toEqual(["c-1"]);
			// The same file name in another session is fine.
			const other = makeSession();
			repo.createSession(other);
			expect(repo.addChunk({ ...chunk, id: "c-3", sessionId: other.id })).toBe(true);
		});

		it("returns chunks ordered by index and updates status/duration", () => {
			const s = makeSession();
			repo.createSession(s);
			for (const index of [2, 0, 1]) {
				repo.addChunk({
					id: `c${index}`,
					sessionId: s.id,
					index,
					path: `chunk_${index}.wav`,
					durationMs: null,
					sampleRate: 16000,
					status: "recorded",
				});
			}
			expect(repo.getChunks(s.id).map((c) => c.index)).toEqual([0, 1, 2]);
			repo.updateChunk("c1", { status: "transcribed", durationMs: 1234 });
			expect(repo.getChunks(s.id)[1]).toMatchObject({ status: "transcribed", durationMs: 1234 });
		});

		it("saveTranscript replaces the previous transcript", () => {
			const s = makeSession();
			repo.createSession(s);
			const base = {
				sessionId: s.id,
				language: "pt",
				provider: "fake",
				model: "fake",
				createdAt: new Date().toISOString(),
			};
			repo.saveTranscript({
				...base,
				id: "t1",
				segments: [{ start: 0, end: 1, text: "primeira" }],
				fullText: "primeira",
			});
			repo.saveTranscript({
				...base,
				id: "t2",
				segments: [{ start: 0, end: 2, text: "segunda" }],
				fullText: "segunda",
			});
			const t = repo.getTranscript(s.id);
			expect(t?.id).toBe("t2");
			expect(t?.segments).toEqual([{ start: 0, end: 2, text: "segunda" }]);
		});

		it("lists analyses oldest first, counts and deletes them", () => {
			const s = makeSession();
			repo.createSession(s);
			const mk = (id: string, createdAt: string) => ({
				id,
				sessionId: s.id,
				templateId: "ata-reuniao",
				provider: "fake",
				model: "fake",
				content: id,
				createdAt,
			});
			repo.saveAnalysis(mk("late", "2026-10-11T12:00:00.000Z"));
			repo.saveAnalysis(mk("early", "2026-10-11T08:00:00.000Z"));
			expect(repo.getAnalyses(s.id).map((a) => a.id)).toEqual(["early", "late"]);
			expect(repo.countAnalyses(s.id)).toBe(2);
			expect(repo.deleteAnalysis("early")).toBe(true);
			expect(repo.deleteAnalysis("early")).toBe(false);
			expect(repo.countAnalyses(s.id)).toBe(1);
		});
	});

	describe("templates", () => {
		it("lists the 5 built-ins first, then custom templates", () => {
			const custom = repo.createTemplate({
				name: "Revisão de Entrevista",
				description: "Avaliação por competência",
				prompt: "## Técnica\n## Comunicação\nAvalie o candidato.",
			});
			const list = repo.listTemplates();
			expect(list.slice(0, 5).map((t) => t.id)).toEqual(BUILTIN_TEMPLATES.map((t) => t.id));
			expect(list[5]).toMatchObject({
				id: custom.id,
				name: "Revisão de Entrevista",
				description: "Avaliação por competência",
				builtin: false,
				sections: 2,
				language: "pt-BR",
			});
			expect(custom.id).toMatch(/^custom-[0-9a-f]{8}$/);
		});

		it("getTemplate resolves legacy ids and custom ids", () => {
			expect(repo.getTemplate("meeting-summary")?.id).toBe("ata-reuniao");
			expect(repo.getTemplate("action-items")?.id).toBe("ata-reuniao");
			const custom = repo.createTemplate({ name: "X", prompt: "Resuma." });
			expect(repo.getTemplate(custom.id)?.description).toBe("");
			expect(repo.getTemplate("nope")).toBeNull();
		});

		it("updates and deletes custom templates", () => {
			const t = repo.createTemplate({ name: "Antigo", prompt: "p" });
			const updated = repo.updateTemplate(t.id, { name: "  Novo  ", description: "d" });
			expect(updated).toMatchObject({ name: "Novo", description: "d", prompt: "p" });
			repo.deleteTemplate(t.id);
			expect(repo.getTemplate(t.id)).toBeNull();
		});

		it("protects built-ins and reports missing templates", () => {
			expect(() => repo.updateTemplate("resumo-executivo", { name: "x" })).toThrow(ValidationError);
			expect(() => repo.deleteTemplate("ata-reuniao")).toThrow(ValidationError);
			expect(() => repo.deleteTemplate("meeting-summary")).toThrow(ValidationError);
			expect(() => repo.updateTemplate("custom-missing", { name: "x" })).toThrow(NotFoundError);
			expect(() => repo.deleteTemplate("custom-missing")).toThrow(NotFoundError);
		});

		it("validates template input", () => {
			expect(() => repo.createTemplate({ name: " ", prompt: "p" })).toThrow(/nome/);
			expect(() => repo.createTemplate({ name: "n", prompt: "" })).toThrow(/prompt/);
			expect(() => repo.createTemplate({ name: "n".repeat(81), prompt: "p" })).toThrow(/80/);
		});
	});
});

describe("SQLiteRepository migration", () => {
	let dir: string;
	let cleanup: () => void;
	beforeEach(() => {
		({ dir, cleanup } = makeTempDir());
	});
	afterEach(() => cleanup());

	/** Schema + data as written by the first release. */
	function createLegacyDb(file: string): void {
		const db = new Database(file);
		db.exec(`
			CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, status TEXT NOT NULL, started_at TEXT,
				ended_at TEXT, audio_source TEXT, language TEXT NOT NULL DEFAULT 'auto', created_at TEXT NOT NULL);
			CREATE TABLE audio_chunks (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, "index" INTEGER NOT NULL,
				path TEXT NOT NULL, duration_ms INTEGER, sample_rate INTEGER NOT NULL DEFAULT 16000, status TEXT NOT NULL);
			CREATE TABLE transcripts (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, segments_json TEXT,
				full_text TEXT, language TEXT, provider TEXT, model TEXT, created_at TEXT NOT NULL);
			CREATE TABLE analyses (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, template_id TEXT NOT NULL,
				provider TEXT NOT NULL, model TEXT NOT NULL, content TEXT, created_at TEXT NOT NULL);
			CREATE TABLE analysis_templates (id TEXT PRIMARY KEY, name TEXT NOT NULL,
				user_prompt_template TEXT NOT NULL, builtin INTEGER NOT NULL DEFAULT 0,
				created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
			INSERT INTO sessions VALUES ('s1', 'Antiga', 'completed', '2026-01-01T00:00:00Z', NULL, 'Stereo Mix', 'auto', '2026-01-01T00:00:00Z');
			INSERT INTO analysis_templates VALUES ('meeting-summary', 'Resumo de Reunião', '{{transcript}}', 1, 'x', 'x');
			INSERT INTO analysis_templates VALUES ('custom-old', 'Meu template', 'Resuma: {{transcript}}', 0, 'x', 'x');
		`);
		db.close();
	}

	it("drops duplicate chunk rows before adding the unique (session, path) index", () => {
		const file = path.join(dir, "dups.db");
		createLegacyDb(file);
		const db = new Database(file);
		db.exec(`
			INSERT INTO audio_chunks VALUES ('c1', 's1', 0, 'a.wav', 1000, 16000, 'recorded');
			INSERT INTO audio_chunks VALUES ('c1-dup', 's1', 0, 'a.wav', 1000, 16000, 'recorded');
			INSERT INTO audio_chunks VALUES ('c2', 's1', 1, 'b.wav', 1000, 16000, 'recorded');
		`);
		db.close();

		for (let i = 0; i < 2; i++) {
			const repo = new SQLiteRepository(file);
			expect(repo.getChunks("s1").map((c) => c.id)).toEqual(["c1", "c2"]);
			repo.close();
		}
		const check = new Database(file);
		const index = check
			.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
			.get("idx_audio_chunks_session_path");
		check.close();
		expect(index).toBeTruthy();
	});

	it("adds new columns idempotently, keeps data and drops seeded built-ins", () => {
		const file = path.join(dir, "legacy.db");
		createLegacyDb(file);

		for (let i = 0; i < 2; i++) {
			const repo = new SQLiteRepository(file);
			expect(repo.getSession("s1")).toMatchObject({
				title: "Antiga",
				exportDir: null,
				lastError: i === 0 ? null : "ok",
			});
			repo.updateSession("s1", { lastError: "ok" });
			const ids = repo.listTemplates().map((t) => t.id);
			expect(ids).toContain("custom-old");
			expect(ids).not.toContain("meeting-summary");
			expect(ids.filter((id) => id === "ata-reuniao")).toHaveLength(1);
			expect(repo.getTemplate("custom-old")).toMatchObject({
				description: "",
				prompt: "Resuma: {{transcript}}",
			});
			repo.close();
		}

		const db = new Database(file);
		const cols = (db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map(
			(c) => c.name,
		);
		db.close();
		expect(cols).toEqual(expect.arrayContaining(["export_dir", "last_error"]));
	});
});
