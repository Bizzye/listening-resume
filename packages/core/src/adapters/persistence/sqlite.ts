import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { asc, count, desc, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { NotFoundError, ValidationError } from "../../domain/errors.js";
import type {
	Analysis,
	AnalysisTemplate,
	AudioChunk,
	NewTemplate,
	Session,
	SessionStatus,
	Transcript,
	TranscriptSegment,
} from "../../domain/models.js";
import type {
	ListSessionsOptions,
	SessionRepository,
	SessionUpdate,
} from "../../ports/repository.js";
import {
	BUILTIN_TEMPLATES,
	countPromptSections,
	getBuiltinTemplate,
	normalizeTemplateInput,
} from "../../templates/index.js";
import * as schema from "./schema.js";

type SessionRow = typeof schema.sessions.$inferSelect;
type TemplateRow = typeof schema.analysisTemplates.$inferSelect;

function toSession(row: SessionRow): Session {
	return {
		id: row.id,
		title: row.title,
		status: row.status as SessionStatus,
		startedAt: row.startedAt,
		endedAt: row.endedAt,
		audioSource: row.audioSource,
		language: row.language,
		createdAt: row.createdAt,
		exportDir: row.exportDir ?? null,
		lastError: row.lastError ?? null,
	};
}

function toTemplate(row: TemplateRow): AnalysisTemplate {
	return {
		id: row.id,
		name: row.name,
		description: row.description ?? "",
		prompt: row.prompt,
		builtin: false,
		sections: countPromptSections(row.prompt),
		language: "pt-BR",
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

const BUILTIN_READ_ONLY =
	"Templates padrão não podem ser alterados. Crie um novo template para personalizar.";

/** better-sqlite3 + drizzle repository. Pass `":memory:"` for an in-memory database. */
export class SQLiteRepository implements SessionRepository {
	private readonly sqlite: Database.Database;
	private readonly db: BetterSQLite3Database<typeof schema>;

	constructor(dbPath: string) {
		this.sqlite = new Database(dbPath);
		if (dbPath !== ":memory:") this.sqlite.pragma("journal_mode = WAL");
		this.db = drizzle(this.sqlite, { schema });
		this.migrate();
	}

	close(): void {
		this.sqlite.close();
	}

	/** Idempotent: creates missing tables/indexes and adds columns introduced later. */
	private migrate(): void {
		this.sqlite.exec(schema.CREATE_TABLES_SQL);
		for (const [table, columns] of Object.entries(schema.ADDED_COLUMNS)) {
			const existing = new Set(
				(this.sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
					(c) => c.name,
				),
			);
			for (const [column, type] of Object.entries(columns)) {
				if (!existing.has(column)) {
					this.sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
				}
			}
		}
		// Built-ins used to be seeded into the table; they now live in code.
		this.sqlite.exec("DELETE FROM analysis_templates WHERE builtin = 1");
		this.ensureUniqueChunkPaths();
	}

	/**
	 * One chunk row per (session, file): older versions could register a file twice (stop
	 * racing the chunk event). Duplicates are dropped (keeping the first row) before the unique
	 * index is created; idempotent.
	 */
	private ensureUniqueChunkPaths(): void {
		const exists = this.sqlite
			.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
			.get(schema.CHUNK_PATH_INDEX);
		if (exists) return;
		this.sqlite.transaction(() => {
			this.sqlite.exec(
				`DELETE FROM audio_chunks WHERE rowid NOT IN (
					SELECT MIN(rowid) FROM audio_chunks GROUP BY session_id, path
				)`,
			);
			this.sqlite.exec(
				`CREATE UNIQUE INDEX ${schema.CHUNK_PATH_INDEX} ON audio_chunks(session_id, path)`,
			);
		})();
	}

	// --- Sessions ---

	createSession(session: Session): void {
		this.db.insert(schema.sessions).values(session).run();
	}

	updateSession(id: string, data: SessionUpdate): void {
		const values = Object.fromEntries(
			Object.entries(data).filter(([key, v]) => v !== undefined && key !== "id"),
		) as SessionUpdate;
		if (Object.keys(values).length === 0) return;
		this.db.update(schema.sessions).set(values).where(eq(schema.sessions.id, id)).run();
	}

	getSession(id: string): Session | null {
		const row = this.db.select().from(schema.sessions).where(eq(schema.sessions.id, id)).get();
		return row ? toSession(row) : null;
	}

	findSessionByIdPrefix(prefix: string): Session | null {
		const needle = prefix.trim();
		if (!needle) return null;
		const exact = this.getSession(needle);
		if (exact) return exact;
		const rows = this.db
			.select()
			.from(schema.sessions)
			.where(sql`substr(${schema.sessions.id}, 1, ${needle.length}) = ${needle}`)
			.limit(2)
			.all();
		return rows.length === 1 ? toSession(rows[0]) : null;
	}

	listSessions(options: ListSessionsOptions = {}): Session[] {
		const limit = Math.max(1, Math.min(options.limit ?? 50, 1000));
		const query = options.query?.trim();
		const s = schema.sessions;
		let where: SQL | undefined;
		if (query) {
			const pattern = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
			where = or(
				sql`${s.title} LIKE ${pattern} ESCAPE '\\'`,
				sql`EXISTS (SELECT 1 FROM transcripts t WHERE t.session_id = ${s.id} AND t.full_text LIKE ${pattern} ESCAPE '\\')`,
			);
		}
		return this.db
			.select()
			.from(s)
			.where(where)
			.orderBy(desc(sql`COALESCE(${s.startedAt}, ${s.createdAt})`), desc(s.createdAt))
			.limit(limit)
			.all()
			.map(toSession);
	}

	findSessionsByStatus(statuses: readonly SessionStatus[]): Session[] {
		if (statuses.length === 0) return [];
		return this.db
			.select()
			.from(schema.sessions)
			.where(inArray(schema.sessions.status, [...statuses]))
			.all()
			.map(toSession);
	}

	deleteSession(id: string): void {
		this.sqlite.transaction(() => {
			this.db.delete(schema.analyses).where(eq(schema.analyses.sessionId, id)).run();
			this.db.delete(schema.transcripts).where(eq(schema.transcripts.sessionId, id)).run();
			this.db.delete(schema.audioChunks).where(eq(schema.audioChunks.sessionId, id)).run();
			this.db.delete(schema.sessions).where(eq(schema.sessions.id, id)).run();
		})();
	}

	// --- Chunks ---

	addChunk(chunk: AudioChunk): boolean {
		const result = this.db
			.insert(schema.audioChunks)
			.values(chunk)
			.onConflictDoNothing({ target: [schema.audioChunks.sessionId, schema.audioChunks.path] })
			.run();
		return result.changes > 0;
	}

	updateChunk(id: string, data: Partial<Pick<AudioChunk, "status" | "durationMs">>): void {
		const values: Partial<Pick<AudioChunk, "status" | "durationMs">> = {};
		if (data.status !== undefined) values.status = data.status;
		if (data.durationMs !== undefined) values.durationMs = data.durationMs;
		if (Object.keys(values).length === 0) return;
		this.db.update(schema.audioChunks).set(values).where(eq(schema.audioChunks.id, id)).run();
	}

	getChunks(sessionId: string): AudioChunk[] {
		return this.db
			.select()
			.from(schema.audioChunks)
			.where(eq(schema.audioChunks.sessionId, sessionId))
			.orderBy(asc(schema.audioChunks.index))
			.all()
			.map((row) => ({ ...row, status: row.status as AudioChunk["status"] }));
	}

	// --- Transcripts ---

	saveTranscript(transcript: Transcript): void {
		this.sqlite.transaction(() => {
			this.db
				.delete(schema.transcripts)
				.where(eq(schema.transcripts.sessionId, transcript.sessionId))
				.run();
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
		})();
	}

	getTranscript(sessionId: string): Transcript | null {
		const row = this.db
			.select()
			.from(schema.transcripts)
			.where(eq(schema.transcripts.sessionId, sessionId))
			.orderBy(desc(schema.transcripts.createdAt))
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

	// --- Analyses ---

	saveAnalysis(analysis: Analysis): void {
		this.db.insert(schema.analyses).values(analysis).run();
	}

	getAnalyses(sessionId: string): Analysis[] {
		return this.db
			.select()
			.from(schema.analyses)
			.where(eq(schema.analyses.sessionId, sessionId))
			.orderBy(asc(schema.analyses.createdAt))
			.all()
			.map((row) => ({ ...row, content: row.content ?? "" }));
	}

	countAnalyses(sessionId: string): number {
		const row = this.db
			.select({ n: count() })
			.from(schema.analyses)
			.where(eq(schema.analyses.sessionId, sessionId))
			.get();
		return row?.n ?? 0;
	}

	deleteAnalysis(id: string): boolean {
		return this.db.delete(schema.analyses).where(eq(schema.analyses.id, id)).run().changes > 0;
	}

	// --- Templates (built-ins from code + custom rows) ---

	listTemplates(): AnalysisTemplate[] {
		const custom = this.db
			.select()
			.from(schema.analysisTemplates)
			.orderBy(asc(schema.analysisTemplates.createdAt))
			.all()
			.map(toTemplate);
		return [...BUILTIN_TEMPLATES.map((t) => ({ ...t })), ...custom];
	}

	getTemplate(id: string): AnalysisTemplate | null {
		const builtin = getBuiltinTemplate(id);
		if (builtin) return { ...builtin };
		const row = this.db
			.select()
			.from(schema.analysisTemplates)
			.where(eq(schema.analysisTemplates.id, id))
			.get();
		return row ? toTemplate(row) : null;
	}

	createTemplate(data: NewTemplate): AnalysisTemplate {
		const input = normalizeTemplateInput({ ...data, description: data.description ?? "" });
		const now = new Date().toISOString();
		const row: TemplateRow = {
			id: `custom-${randomUUID().slice(0, 8)}`,
			name: input.name,
			description: input.description,
			prompt: input.prompt,
			createdAt: now,
			updatedAt: now,
		};
		this.db.insert(schema.analysisTemplates).values(row).run();
		return toTemplate(row);
	}

	updateTemplate(id: string, data: Partial<NewTemplate>): AnalysisTemplate {
		if (getBuiltinTemplate(id)) throw new ValidationError(BUILTIN_READ_ONLY);
		const input = normalizeTemplateInput(data);
		const changes = this.db
			.update(schema.analysisTemplates)
			.set({ ...input, updatedAt: new Date().toISOString() })
			.where(eq(schema.analysisTemplates.id, id))
			.run().changes;
		if (changes === 0) throw new NotFoundError("Template não encontrado.");
		return this.getTemplate(id) as AnalysisTemplate;
	}

	deleteTemplate(id: string): void {
		if (getBuiltinTemplate(id)) {
			throw new ValidationError("Templates padrão não podem ser apagados.");
		}
		const changes = this.db
			.delete(schema.analysisTemplates)
			.where(eq(schema.analysisTemplates.id, id))
			.run().changes;
		if (changes === 0) throw new NotFoundError("Template não encontrado.");
	}
}
