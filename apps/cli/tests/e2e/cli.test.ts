import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appConfigSchema, createWav, FAKE_DEVICES, SQLiteRepository } from "@listening-resume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolvePreferences } from "../../src/cli.js";

const CLI_PATH = path.resolve(__dirname, "../../src/index.ts");
const TEST_ROOT = path.join(os.tmpdir(), `lr-e2e-${Date.now()}`);
const TEST_DATA_DIR = path.join(TEST_ROOT, "data");
/** Hermetic config dir: fake capture backend, no user settings/.env leaking in. */
const TEST_CONFIG_DIR = path.join(TEST_ROOT, "config");
const SESSION_ID = "c0ffee00-1111-4222-8333-444455556666";

function runCli(args: string, env: Record<string, string> = {}) {
	const result = spawnSync(`"${process.execPath}" --import tsx "${CLI_PATH}" ${args}`, {
		shell: true,
		encoding: "utf-8",
		cwd: path.resolve(__dirname, "../.."),
		env: {
			...process.env,
			LISTENING_RESUME_DATA_DIR: TEST_DATA_DIR,
			LISTENING_RESUME_CONFIG_DIR: TEST_CONFIG_DIR,
			GROQ_API_KEY: "",
			...env,
		},
		timeout: 30000,
	});
	return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.status ?? 1 };
}

/** A finished session (1 s WAV + transcript + analysis) written straight through the core repo. */
function seedSession(): void {
	const audioDir = path.join(TEST_DATA_DIR, "sessions", SESSION_ID, "audio");
	fs.mkdirSync(audioDir, { recursive: true });
	const wav = path.join(audioDir, "chunk_0000.wav");
	fs.writeFileSync(wav, createWav(new Int16Array(16000), { sampleRate: 16000, channels: 1 }));

	const repo = new SQLiteRepository(path.join(TEST_DATA_DIR, "listening-resume.db"));
	const now = new Date().toISOString();
	repo.createSession({
		id: SESSION_ID,
		title: "Aula de Termodinâmica",
		status: "completed",
		startedAt: now,
		endedAt: now,
		audioSource: "Áudio do sistema",
		language: "pt",
		createdAt: now,
		exportDir: null,
		lastError: null,
	});
	repo.addChunk({
		id: "chunk-1",
		sessionId: SESSION_ID,
		index: 0,
		path: wav,
		durationMs: 1000,
		sampleRate: 16000,
		status: "transcribed",
	});
	repo.saveTranscript({
		id: "tr-1",
		sessionId: SESSION_ID,
		segments: [{ start: 0, end: 1, text: "A entropia de um sistema isolado nunca diminui." }],
		fullText: "A entropia de um sistema isolado nunca diminui.",
		language: "pt",
		provider: "fake",
		model: "fake",
		createdAt: now,
	});
	repo.saveAnalysis({
		id: "an-1",
		sessionId: SESSION_ID,
		templateId: "resumo-executivo",
		provider: "fake",
		model: "fake",
		content: "## Contexto\n\nAula sobre a segunda lei.",
		createdAt: now,
	});
	repo.close();
}

describe("CLI E2E", () => {
	beforeAll(() => {
		fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
		fs.mkdirSync(TEST_CONFIG_DIR, { recursive: true });
		fs.writeFileSync(
			path.join(TEST_CONFIG_DIR, "config.toml"),
			'[audio]\nbackend = "fake"\nchunk_seconds = 5\n',
		);
	});

	afterAll(() => {
		fs.rmSync(TEST_ROOT, { recursive: true, force: true });
	});

	describe("without a database", () => {
		it("shows help text", () => {
			const { stdout } = runCli("--help");
			expect(stdout).toContain("Record system audio");
			expect(stdout).toContain("Commands:");
		});

		it("shows version", () => {
			expect(runCli("--version").stdout).toContain("0.1.0");
		});

		it("lists the capture backend's audio devices", () => {
			const { stdout, exitCode } = runCli("devices");
			expect(exitCode).toBe(0);
			expect(stdout).toContain("Available audio devices");
			for (const device of FAKE_DEVICES) {
				const kind = device.isMonitor ? "output" : "mic";
				expect(stdout).toContain(`[${kind}] ${device.id}`);
			}
			expect(stdout).toContain("@default");
		});

		it("lists the built-in pt-BR templates", () => {
			const { stdout, exitCode } = runCli("templates");
			expect(exitCode).toBe(0);
			for (const id of [
				"videoaula-extracao",
				"ata-reuniao",
				"resumo-executivo",
				"flashcards-anki",
				"podcast-artigo",
			]) {
				expect(stdout).toContain(id);
			}
		});

		it("list reports no sessions", () => {
			const { stdout, exitCode } = runCli("list");
			expect(exitCode).toBe(0);
			expect(stdout).toMatch(/No sessions found/i);
		});

		it("show / transcribe / export fail gracefully", () => {
			expect(runCli("show nonexistent").stdout).toMatch(/No database/i);
			expect(runCli("transcribe nonexistent", { GROQ_API_KEY: "" }).stdout).toMatch(/No database/i);
			const { stdout, exitCode } = runCli("export nonexistent");
			expect(stdout).toMatch(/No database/i);
			expect(exitCode).toBe(1);
		});
	});

	describe("errors", () => {
		it("reports action errors in red with exit code 1", () => {
			const { stderr, exitCode } = runCli("record --duration nope --no-transcribe");
			expect(stderr).toContain("Invalid --duration: nope");
			expect(exitCode).toBe(1);
		});
	});

	describe("with a recorded session", () => {
		beforeAll(seedSession);

		it("lists and searches sessions", () => {
			expect(runCli("list").stdout).toContain(SESSION_ID.slice(0, 8));
			expect(runCli("list -q entropia").stdout).toContain(SESSION_ID.slice(0, 8));
			expect(runCli("list -q inexistente").stdout).toMatch(/No sessions found/i);
		});

		it("shows a session by id prefix", () => {
			const { stdout, exitCode } = runCli(`show ${SESSION_ID.slice(0, 6)}`);
			expect(exitCode).toBe(0);
			expect(stdout).toContain("Aula de Termodinâmica");
			expect(stdout).toContain("1 chunk(s), 1 s");
			expect(stdout).toContain("Resumo Executivo");
		});

		it("reports unknown sessions", () => {
			const { stdout, exitCode } = runCli("show ffffffff");
			expect(stdout).toMatch(/Session not found/);
			expect(exitCode).toBe(1);
		});

		it("exports Markdown to a file", () => {
			const out = path.join(TEST_DATA_DIR, "export.md");
			const { stdout, exitCode } = runCli(`export ${SESSION_ID.slice(0, 8)} -o "${out}"`);
			expect(exitCode).toBe(0);
			expect(stdout).toContain("Exported to");
			const md = fs.readFileSync(out, "utf-8");
			expect(md).toContain("# Aula de Termodinâmica");
			expect(md).toContain("## Resumo Executivo");
			expect(md).toContain("### Contexto");
			expect(md).toContain("**[0:00]** A entropia");
		});

		it("rejects an unknown template", () => {
			const { stdout, exitCode } = runCli(`analyze ${SESSION_ID.slice(0, 8)} -t nope`);
			expect(stdout).toContain("Template not found: nope");
			expect(stdout).toContain("resumo-executivo");
			expect(exitCode).toBe(1);
		});
	});

	describe("record (fake capture backend)", () => {
		it("records for --duration, then stops and registers the audio", () => {
			const { stdout, stderr, exitCode } = runCli("record --duration 1.5 --no-transcribe");
			expect(exitCode).toBe(0);
			expect(stdout).toContain("Recording:");
			expect(stdout).toContain("@default + @default"); // config/settings defaults
			expect(stderr).toMatch(/Recording stopped \(1 chunk\)/); // ora spinners write to stderr

			const repo = new SQLiteRepository(path.join(TEST_DATA_DIR, "listening-resume.db"));
			const recorded = repo.listSessions().find((s) => s.audioSource?.includes("Microfone"));
			expect(recorded).toMatchObject({ status: "stopped", lastError: null });
			const chunks = repo.getChunks(recorded?.id ?? "");
			repo.close();
			expect(chunks).toHaveLength(1);
			expect(chunks[0].durationMs).toBeGreaterThan(1000);
		});

		it("honors settings.json (shared with the GUI) over config.toml", () => {
			const settingsFile = path.join(TEST_CONFIG_DIR, "settings.json");
			fs.writeFileSync(settingsFile, JSON.stringify({ micDevice: null }));
			try {
				const { stdout, exitCode } = runCli("record --duration 0.5 --no-transcribe");
				expect(exitCode).toBe(0);
				expect(stdout).toContain("@default\n"); // no " + mic"
				expect(stdout).not.toContain("@default + ");
			} finally {
				fs.rmSync(settingsFile, { force: true });
			}
		});
	});
});

describe("resolvePreferences", () => {
	const config = appConfigSchema.parse({ audio: { device: "Speakers", micDevice: "Mic" } });

	it("falls back to config.toml for values settings.json doesn't store", () => {
		expect(resolvePreferences(config, {})).toMatchObject({
			systemDevice: "Speakers",
			micDevice: "Mic",
			transcriptionProvider: "groq",
			analysisModel: "llama3.1:8b",
			analysisLanguage: "pt-BR",
			defaultTemplateId: "resumo-executivo",
		});
	});

	it("prefers stored settings, including an explicit null mic", () => {
		expect(
			resolvePreferences(config, {
				systemDevice: "@default",
				micDevice: null,
				analysisModel: "qwen2.5:7b",
				analysisLanguage: "en",
				defaultTemplateId: "ata-reuniao",
			}),
		).toMatchObject({
			systemDevice: "@default",
			micDevice: null,
			analysisModel: "qwen2.5:7b",
			analysisLanguage: "en",
			defaultTemplateId: "ata-reuniao",
		});
	});
});
