import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type {
	Analysis,
	AudioChunk,
	Session,
	Transcript,
	TranscriptSegment,
} from "../../domain/models.js";
import type { AnalysisTemplate } from "../../ports/analyzer.js";
import type { SessionRepository } from "../../ports/repository.js";
import { actionItemsTemplate } from "../../templates/action-items.js";
import { meetingSummaryTemplate } from "../../templates/meeting-summary.js";
import { videoaulaInsanaTemplate } from "../../templates/videoaula-insana.js";
import * as schema from "./schema.js";

export class SQLiteRepository implements SessionRepository {
	private db: ReturnType<typeof drizzle>;
	private sqlite: Database.Database;

	constructor(dbPath: string) {
		this.sqlite = new Database(dbPath);
		this.sqlite.pragma("journal_mode = WAL");
		this.db = drizzle(this.sqlite, { schema });
		this.migrate(this.sqlite);
	}

	close(): void {
		this.sqlite.close();
	}

	private migrate(sqlite: Database.Database): void {
		sqlite.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT,
        status TEXT NOT NULL,
        started_at TEXT,
        ended_at TEXT,
        audio_source TEXT,
        language TEXT NOT NULL DEFAULT 'auto',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audio_chunks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        "index" INTEGER NOT NULL,
        path TEXT NOT NULL,
        duration_ms INTEGER,
        sample_rate INTEGER NOT NULL DEFAULT 16000,
        status TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transcripts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        segments_json TEXT,
        full_text TEXT,
        language TEXT,
        provider TEXT,
        model TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS analyses (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        template_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        content TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS analysis_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        user_prompt_template TEXT NOT NULL,
        builtin INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
		this.seedBuiltinTemplates();
	}

	private seedBuiltinTemplates(): void {
		const now = new Date().toISOString();
		const builtins = [meetingSummaryTemplate, actionItemsTemplate, videoaulaInsanaTemplate];
		for (const t of builtins) {
			const existing = this.db
				.select()
				.from(schema.analysisTemplates)
				.where(eq(schema.analysisTemplates.id, t.id))
				.get();
			if (!existing) {
				this.db
					.insert(schema.analysisTemplates)
					.values({
						id: t.id,
						name: t.name,
						userPromptTemplate: t.userPromptTemplate,
						builtin: 1,
						createdAt: now,
						updatedAt: now,
					})
					.run();
			} else {
				// Update builtin templates if content changed
				this.db
					.update(schema.analysisTemplates)
					.set({
						name: t.name,
						userPromptTemplate: t.userPromptTemplate,
						updatedAt: now,
					})
					.where(eq(schema.analysisTemplates.id, t.id))
					.run();
			}
		}
	}

	createSession(session: Session): void {
		this.db
			.insert(schema.sessions)
			.values({
				id: session.id,
				title: session.title,
				status: session.status,
				startedAt: session.startedAt,
				endedAt: session.endedAt,
				audioSource: session.audioSource,
				language: session.language,
				createdAt: session.createdAt,
			})
			.run();
	}

	updateSession(id: string, data: Partial<Session>): void {
		const mapped: Record<string, unknown> = {};
		if (data.title !== undefined) mapped.title = data.title;
		if (data.status !== undefined) mapped.status = data.status;
		if (data.startedAt !== undefined) mapped.startedAt = data.startedAt;
		if (data.endedAt !== undefined) mapped.endedAt = data.endedAt;
		if (data.audioSource !== undefined) mapped.audioSource = data.audioSource;
		if (data.language !== undefined) mapped.language = data.language;

		this.db.update(schema.sessions).set(mapped).where(eq(schema.sessions.id, id)).run();
	}

	getSession(id: string): Session | null {
		const row = this.db.select().from(schema.sessions).where(eq(schema.sessions.id, id)).get();
		if (!row) return null;
		return {
			id: row.id,
			title: row.title,
			status: row.status as Session["status"],
			startedAt: row.startedAt,
			endedAt: row.endedAt,
			audioSource: row.audioSource,
			language: row.language,
			createdAt: row.createdAt,
		};
	}

	listSessions(limit = 20): Session[] {
		const rows = this.db.select().from(schema.sessions).limit(limit).all();
		return rows.map((row) => ({
			id: row.id,
			title: row.title,
			status: row.status as Session["status"],
			startedAt: row.startedAt,
			endedAt: row.endedAt,
			audioSource: row.audioSource,
			language: row.language,
			createdAt: row.createdAt,
		}));
	}

	addChunk(chunk: AudioChunk): void {
		this.db
			.insert(schema.audioChunks)
			.values({
				id: chunk.id,
				sessionId: chunk.sessionId,
				index: chunk.index,
				path: chunk.path,
				durationMs: chunk.durationMs,
				sampleRate: chunk.sampleRate,
				status: chunk.status,
			})
			.run();
	}

	updateChunk(id: string, data: Partial<AudioChunk>): void {
		const mapped: Record<string, unknown> = {};
		if (data.status !== undefined) mapped.status = data.status;
		if (data.durationMs !== undefined) mapped.durationMs = data.durationMs;
		this.db.update(schema.audioChunks).set(mapped).where(eq(schema.audioChunks.id, id)).run();
	}

	getChunks(sessionId: string): AudioChunk[] {
		const rows = this.db
			.select()
			.from(schema.audioChunks)
			.where(eq(schema.audioChunks.sessionId, sessionId))
			.all();
		return rows.map((row) => ({
			id: row.id,
			sessionId: row.sessionId,
			index: row.index,
			path: row.path,
			durationMs: row.durationMs,
			sampleRate: row.sampleRate,
			status: row.status as AudioChunk["status"],
		}));
	}

	saveTranscript(transcript: Transcript): void {
		this.db
			.insert(schema.transcripts)
			.values({
				id: transcript.id,
				sessionId: transcript.sessionId,
				segmentsJson: JSON.stringify(transcript.segments),
				fullText: transcript.fullText,
				language: transcript.language,
				provider: transcript.provider,
				model: transcript.model,
				createdAt: transcript.createdAt,
			})
			.run();
	}

	getTranscript(sessionId: string): Transcript | null {
		const row = this.db
			.select()
			.from(schema.transcripts)
			.where(eq(schema.transcripts.sessionId, sessionId))
			.get();
		if (!row) return null;
		return {
			id: row.id,
			sessionId: row.sessionId,
			segments: row.segmentsJson ? (JSON.parse(row.segmentsJson) as TranscriptSegment[]) : [],
			fullText: row.fullText ?? "",
			language: row.language,
			provider: row.provider ?? "unknown",
			model: row.model ?? "unknown",
			createdAt: row.createdAt,
		};
	}

	saveAnalysis(analysis: Analysis): void {
		this.db
			.insert(schema.analyses)
			.values({
				id: analysis.id,
				sessionId: analysis.sessionId,
				templateId: analysis.templateId,
				provider: analysis.provider,
				model: analysis.model,
				content: analysis.content,
				createdAt: analysis.createdAt,
			})
			.run();
	}

	getAnalyses(sessionId: string): Analysis[] {
		const rows = this.db
			.select()
			.from(schema.analyses)
			.where(eq(schema.analyses.sessionId, sessionId))
			.all();
		return rows.map((row) => ({
			id: row.id,
			sessionId: row.sessionId,
			templateId: row.templateId,
			provider: row.provider,
			model: row.model,
			content: row.content ?? "",
			createdAt: row.createdAt,
		}));
	}

	deleteAnalysis(id: string): void {
		this.db.delete(schema.analyses).where(eq(schema.analyses.id, id)).run();
	}

	deleteSession(id: string): void {
		this.db.delete(schema.analyses).where(eq(schema.analyses.sessionId, id)).run();
		this.db.delete(schema.transcripts).where(eq(schema.transcripts.sessionId, id)).run();
		this.db.delete(schema.audioChunks).where(eq(schema.audioChunks.sessionId, id)).run();
		this.db.delete(schema.sessions).where(eq(schema.sessions.id, id)).run();
	}

	// --- Template CRUD ---

	listTemplates(): AnalysisTemplate[] {
		const rows = this.db.select().from(schema.analysisTemplates).all();
		return rows.map((row) => ({
			id: row.id,
			name: row.name,
			userPromptTemplate: row.userPromptTemplate,
			builtin: row.builtin === 1,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		}));
	}

	getTemplate(id: string): AnalysisTemplate | undefined {
		const row = this.db
			.select()
			.from(schema.analysisTemplates)
			.where(eq(schema.analysisTemplates.id, id))
			.get();
		if (!row) return undefined;
		return {
			id: row.id,
			name: row.name,
			userPromptTemplate: row.userPromptTemplate,
			builtin: row.builtin === 1,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		};
	}

	createTemplate(
		data: Pick<AnalysisTemplate, "id" | "name" | "userPromptTemplate">,
	): AnalysisTemplate {
		const now = new Date().toISOString();
		this.db
			.insert(schema.analysisTemplates)
			.values({
				id: data.id,
				name: data.name,
				userPromptTemplate: data.userPromptTemplate,
				builtin: 0,
				createdAt: now,
				updatedAt: now,
			})
			.run();
		return { ...data, builtin: false, createdAt: now, updatedAt: now };
	}

	updateTemplate(
		id: string,
		data: Partial<Pick<AnalysisTemplate, "name" | "userPromptTemplate">>,
	): AnalysisTemplate | undefined {
		const existing = this.getTemplate(id);
		if (!existing) return undefined;
		const now = new Date().toISOString();
		const mapped: Record<string, unknown> = { updatedAt: now };
		if (data.name !== undefined) mapped.name = data.name;
		if (data.userPromptTemplate !== undefined) mapped.userPromptTemplate = data.userPromptTemplate;
		this.db
			.update(schema.analysisTemplates)
			.set(mapped)
			.where(eq(schema.analysisTemplates.id, id))
			.run();
		return this.getTemplate(id);
	}

	deleteTemplate(id: string): boolean {
		const existing = this.getTemplate(id);
		if (!existing) return false;
		if (existing.builtin) return false;
		this.db.delete(schema.analysisTemplates).where(eq(schema.analysisTemplates.id, id)).run();
		return true;
	}
}
