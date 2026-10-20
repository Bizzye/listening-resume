import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const sessions = sqliteTable("sessions", {
	id: text("id").primaryKey(),
	title: text("title"),
	status: text("status").notNull(),
	startedAt: text("started_at"),
	endedAt: text("ended_at"),
	audioSource: text("audio_source"),
	language: text("language").notNull().default("auto"),
	createdAt: text("created_at").notNull(),
	exportDir: text("export_dir"),
	lastError: text("last_error"),
});

export const audioChunks = sqliteTable(
	"audio_chunks",
	{
		id: text("id").primaryKey(),
		sessionId: text("session_id").notNull(),
		index: integer("index").notNull(),
		path: text("path").notNull(),
		durationMs: integer("duration_ms"),
		sampleRate: integer("sample_rate").notNull().default(16000),
		status: text("status").notNull(),
	},
	(t) => [uniqueIndex("idx_audio_chunks_session_path").on(t.sessionId, t.path)],
);

export const transcripts = sqliteTable("transcripts", {
	id: text("id").primaryKey(),
	sessionId: text("session_id").notNull(),
	segmentsJson: text("segments_json"),
	fullText: text("full_text"),
	language: text("language"),
	provider: text("provider"),
	model: text("model"),
	createdAt: text("created_at").notNull(),
});

export const analyses = sqliteTable("analyses", {
	id: text("id").primaryKey(),
	sessionId: text("session_id").notNull(),
	templateId: text("template_id").notNull(),
	provider: text("provider").notNull(),
	model: text("model").notNull(),
	content: text("content"),
	createdAt: text("created_at").notNull(),
});

/** Custom templates only — built-ins live in code (`templates/builtin.ts`). */
export const analysisTemplates = sqliteTable("analysis_templates", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	description: text("description").notNull().default(""),
	prompt: text("user_prompt_template").notNull(),
	createdAt: text("created_at").notNull(),
	updatedAt: text("updated_at").notNull(),
});

/**
 * DDL for a fresh database; `SQLiteRepository.migrate` adds missing columns to older ones.
 * (`analysis_templates.builtin` is legacy: built-in rows are deleted on migration.)
 */
export const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
	id TEXT PRIMARY KEY,
	title TEXT,
	status TEXT NOT NULL,
	started_at TEXT,
	ended_at TEXT,
	audio_source TEXT,
	language TEXT NOT NULL DEFAULT 'auto',
	created_at TEXT NOT NULL,
	export_dir TEXT,
	last_error TEXT
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
	description TEXT NOT NULL DEFAULT '',
	user_prompt_template TEXT NOT NULL,
	builtin INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audio_chunks_session ON audio_chunks(session_id);
CREATE INDEX IF NOT EXISTS idx_transcripts_session ON transcripts(session_id);
CREATE INDEX IF NOT EXISTS idx_analyses_session ON analyses(session_id);
`;

/** Unique (session_id, path) index on `audio_chunks`, created by the migration. */
export const CHUNK_PATH_INDEX = "idx_audio_chunks_session_path";

/** Columns added after the first release: `table → column → DDL type`. */
export const ADDED_COLUMNS: Record<string, Record<string, string>> = {
	sessions: { export_dir: "TEXT", last_error: "TEXT" },
	analysis_templates: { description: "TEXT NOT NULL DEFAULT ''" },
};
