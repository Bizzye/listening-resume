import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	FakeTranscriber,
	LocalFileStorage,
	SettingsStore,
	SQLiteRepository,
	setLogLevel,
} from "@listening-resume/core";
import { afterEach, describe, expect, it } from "vitest";
import { toHttpError } from "../../../server/http.js";
import { normalizeMic, normalizeSystem } from "../../../server/routes/audio.js";
import { parseTemplateBody } from "../../../server/routes/templates.js";
import { parseExportFormat } from "../../../server/services/export/index.js";
import { createHealthCheckers, parseFfmpegVersion } from "../../../server/services/health.js";
import { JobRunner } from "../../../server/services/jobs.js";

setLogLevel("error");
const silent = { info() {}, warn() {}, error() {} };

describe("request normalization", () => {
	it("normalizes mic values", () => {
		expect(normalizeMic("none")).toBeNull();
		expect(normalizeMic("")).toBeNull();
		expect(normalizeMic(null)).toBeNull();
		expect(normalizeMic(" @default ")).toBe("@default");
		expect(() => normalizeMic(42)).toThrow(/micDevice/);
		expect(normalizeSystem("Fones")).toBe("Fones");
		expect(() => normalizeSystem("")).toThrow();
	});

	it("rejects control characters in device ids (stdin/argv injection)", () => {
		for (const bad of ["Fones\nq", "Fones\r\nmute-sys", "a\u0000b", "x\u007f"]) {
			expect(() => normalizeSystem(bad)).toThrow(/inválidos/);
			expect(() => normalizeMic(bad)).toThrow(/inválidos/);
		}
		expect(normalizeSystem("Alto-falantes (Realtek(R) Audio)")).toBe(
			"Alto-falantes (Realtek(R) Audio)",
		);
	});

	it("names the offending field and rejects overlong ids (core ValidationError → 400)", () => {
		const capture = (fn: () => unknown) => {
			try {
				fn();
			} catch (err) {
				return toHttpError(err);
			}
			throw new Error("expected a throw");
		};
		expect(capture(() => normalizeSystem("a\nb"))).toEqual({
			status: 400,
			message: "device contém caracteres inválidos",
		});
		expect(capture(() => normalizeMic("a\u0000b"))).toEqual({
			status: 400,
			message: "micDevice contém caracteres inválidos",
		});
		expect(capture(() => normalizeSystem("x".repeat(513)))).toEqual({
			status: 400,
			message: "device muito longo",
		});
		expect(normalizeMic("x".repeat(512))).toHaveLength(512);
	});

	it("parses export formats", () => {
		expect(parseExportFormat("PDF")).toBe("pdf");
		expect(parseExportFormat("markdown")).toBe("md");
		expect(() => parseExportFormat("txt")).toThrow(/Formato inválido/);
	});

	it("shape-checks template bodies", () => {
		expect(parseTemplateBody({ name: "a", prompt: "b" }, false)).toEqual({
			name: "a",
			prompt: "b",
		});
		expect(() => parseTemplateBody({ name: "a" }, false)).toThrow(/prompt/);
		expect(() => parseTemplateBody({ name: 1, prompt: "b" }, false)).toThrow(/texto/);
		expect(parseTemplateBody({ description: "d" }, true)).toEqual({ description: "d" });
	});
});

describe("settings validation (core SettingsStore through the API contract)", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lr-settings-"));
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it("rejects invalid values with a validation-kind error", () => {
		const store = new SettingsStore(path.join(dir, "settings.json"));
		expect(store.update({ exportFormat: "pdf" }).exportFormat).toBe("pdf");
		try {
			store.update({ exportFormat: "odt" as never });
			expect.unreachable();
		} catch (err) {
			expect((err as { kind?: string }).kind).toBe("validation");
		}
	});
});

describe("health checkers", () => {
	it("parses ffmpeg versions", () => {
		expect(parseFfmpegVersion("ffmpeg version 7.1-full_build-www.gyan.dev Copyright")).toBe(
			"7.1-full_build-www.gyan.dev",
		);
		expect(parseFfmpegVersion("nope")).toBeNull();
	});

	it("probes Ollama, ffmpeg (cached) and whisper without throwing", async () => {
		let ffmpegRuns = 0;
		const h = createHealthCheckers({
			fetch: async (url) => {
				expect(url).toBe("http://ollama:11434/api/tags");
				return new Response(
					JSON.stringify({ models: [{ name: "llama3.1:8b" }, { model: "qwen" }] }),
				);
			},
			run: async (cmd) => {
				if (cmd === "ffmpeg") {
					ffmpegRuns++;
					return { code: 0, stdout: "ffmpeg version 7.1 Copyright", stderr: "" };
				}
				throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
			},
			ollamaUrl: "http://ollama:11434/",
			whisperBin: "whisper-cli",
			whisperModelPath: () => __filename,
		});
		expect(await h.ollama()).toEqual({
			ok: true,
			url: "http://ollama:11434",
			models: ["llama3.1:8b", "qwen"],
		});
		expect(await h.ffmpeg()).toEqual({ ok: true, version: "7.1" });
		await h.ffmpeg();
		expect(ffmpegRuns).toBe(1);
		expect(await h.whisper("medium")).toEqual({ ok: false });

		const offline = createHealthCheckers({
			fetch: async () => {
				throw new TypeError("fetch failed");
			},
			run: async () => ({ code: 1, stdout: "", stderr: "" }),
			ollamaUrl: "http://x",
			whisperBin: "w",
			whisperModelPath: () => path.join(os.tmpdir(), "missing-model.bin"),
		});
		expect((await offline.ollama()).ok).toBe(false);
		expect(await offline.ffmpeg()).toEqual({ ok: false, version: null });
		expect(await offline.whisper("small")).toEqual({ ok: false });
	});
});

describe("JobRunner", () => {
	function setup(transcriber: FakeTranscriber) {
		const repo = new SQLiteRepository(":memory:");
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lr-jobs-"));
		const settings = new SettingsStore(path.join(dir, "settings.json"));
		const runner = new JobRunner({
			repo,
			storage: new LocalFileStorage(dir),
			logger: silent,
			settings,
			transcription: { create: () => transcriber },
			rateLimits: { requestsPerMinute: 1000, audioSecondsPerHour: 1e6 },
		});
		const now = new Date().toISOString();
		repo.createSession({
			id: "s1",
			title: null,
			status: "stopped",
			startedAt: now,
			endedAt: now,
			audioSource: null,
			language: "auto",
			createdAt: now,
			exportDir: null,
			lastError: null,
		});
		return { repo, runner, dir };
	}

	it("never lets a failing job escape and records lastError", async () => {
		const { repo, runner, dir } = setup(new FakeTranscriber({ failWith: "boom" }));
		runner.transcribe("s1"); // no chunks → core fails
		expect(runner.isBusy("s1")).toBe(true);
		expect(() => runner.transcribe("s1")).toThrow(/em andamento/);
		await runner.idle();
		expect(runner.isBusy("s1")).toBe(false);
		const s = repo.getSession("s1");
		expect(s?.status).toBe("failed");
		expect(s?.lastError).toBeTruthy();
		repo.close();
		fs.rmSync(dir, { recursive: true, force: true });
	});
});
