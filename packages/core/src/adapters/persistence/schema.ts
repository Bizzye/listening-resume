import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  title: text("title"),
  status: text("status").notNull(),
  startedAt: text("started_at"),
  endedAt: text("ended_at"),
  audioSource: text("audio_source"),
  language: text("language").notNull().default("auto"),
  createdAt: text("created_at").notNull(),
});

export const audioChunks = sqliteTable("audio_chunks", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  index: integer("index").notNull(),
  path: text("path").notNull(),
  durationMs: integer("duration_ms"),
  sampleRate: integer("sample_rate").notNull().default(16000),
  status: text("status").notNull(),
});

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

export const analysisTemplates = sqliteTable("analysis_templates", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  userPromptTemplate: text("user_prompt_template").notNull(),
  builtin: integer("builtin").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
