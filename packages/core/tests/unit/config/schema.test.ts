import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, resolveDataDir } from "../../../src/config/loader.js";
import { resolveConfigDir } from "../../../src/config/paths.js";
import { appConfigSchema } from "../../../src/config/schema.js";
import { makeTempDir } from "../../helpers.js";

describe("appConfigSchema", () => {
	it("provides defaults for an empty config", () => {
		const config = appConfigSchema.parse({});
		expect(config.audio).toMatchObject({
			backend: process.platform === "win32" ? "wasapi" : "pulse",
			device: "@default",
			micDevice: "@default", // same default as settings.json
			chunkSeconds: 120,
			sampleRate: 16000,
			channels: 1,
		});
		expect(config.transcription).toMatchObject({
			provider: "groq",
			model: "whisper-large-v3-turbo",
			whisperBinary: "whisper-cli",
			whisperModel: "medium",
		});
		expect(config.analysis).toMatchObject({
			provider: "ollama",
			model: "llama3.1:8b",
			defaultTemplate: "resumo-executivo",
		});
		expect(config.rateLimits.groqRpm).toBe(18);
		expect(config.storage.dataDir).toBe("");
	});

	it("maps legacy backend names", () => {
		expect(appConfigSchema.parse({ audio: { backend: "ffmpeg-wasapi" } }).audio.backend).toBe(
			"wasapi",
		);
		expect(appConfigSchema.parse({ audio: { backend: "ffmpeg-pulse" } }).audio.backend).toBe(
			"pulse",
		);
		expect(appConfigSchema.parse({ audio: { backend: "fake" } }).audio.backend).toBe("fake");
	});

	it("validates ranges and providers", () => {
		expect(() => appConfigSchema.parse({ audio: { chunkSeconds: 2 } })).toThrow();
		expect(() => appConfigSchema.parse({ audio: { channels: 3 } })).toThrow();
		expect(() => appConfigSchema.parse({ transcription: { provider: "openai" } })).toThrow();
		expect(() => appConfigSchema.parse({ analysis: { provider: "anthropic" } })).toThrow();
		expect(() => appConfigSchema.parse({ audio: { backend: "dshow" } })).toThrow();
	});
});

describe("loadConfig / resolveDataDir", () => {
	let dir: string;
	let cleanup: () => void;
	const savedDataDir = process.env.LISTENING_RESUME_DATA_DIR;

	beforeEach(() => {
		({ dir, cleanup } = makeTempDir());
		delete process.env.LISTENING_RESUME_DATA_DIR;
	});
	afterEach(() => {
		if (savedDataDir === undefined) delete process.env.LISTENING_RESUME_DATA_DIR;
		else process.env.LISTENING_RESUME_DATA_DIR = savedDataDir;
		cleanup();
	});

	it("resolves the Ollama host lazily (OLLAMA_HOST from a .env loaded later)", () => {
		const saved = process.env.OLLAMA_HOST;
		try {
			delete process.env.OLLAMA_HOST;
			expect(appConfigSchema.parse({}).analysis.ollamaHost).toBe("http://127.0.0.1:11434");
			fs.writeFileSync(path.join(dir, ".env"), "OLLAMA_HOST=http://gpu-box:11434\n");
			expect(loadConfig(dir).analysis.ollamaHost).toBe("http://gpu-box:11434");
		} finally {
			if (saved === undefined) delete process.env.OLLAMA_HOST;
			else process.env.OLLAMA_HOST = saved;
		}
	});

	it("LISTENING_RESUME_CONFIG_DIR overrides the config dir", () => {
		const saved = process.env.LISTENING_RESUME_CONFIG_DIR;
		try {
			process.env.LISTENING_RESUME_CONFIG_DIR = dir;
			expect(resolveConfigDir()).toBe(path.resolve(dir));
		} finally {
			if (saved === undefined) delete process.env.LISTENING_RESUME_CONFIG_DIR;
			else process.env.LISTENING_RESUME_CONFIG_DIR = saved;
		}
	});

	it("reads snake_case TOML from the config dir", () => {
		fs.writeFileSync(
			path.join(dir, "config.toml"),
			'[audio]\nchunk_seconds = 60\nmic_device = "Mic"\n[storage]\ndata_dir = "~/lr-data"\n',
		);
		const config = loadConfig(dir);
		expect(config.audio.chunkSeconds).toBe(60);
		expect(config.audio.micDevice).toBe("Mic");
		expect(resolveDataDir(config)).toMatch(/lr-data$/);
		expect(resolveDataDir(config)).not.toContain("~");
	});

	it("rejects invalid files with a ConfigError", () => {
		fs.writeFileSync(path.join(dir, "config.toml"), "[audio\nbroken");
		expect(() => loadConfig(dir)).toThrow(/Failed to parse/);
		fs.writeFileSync(path.join(dir, "config.toml"), "[audio]\nchannels = 9\n");
		expect(() => loadConfig(dir)).toThrow(/Invalid configuration/);
	});

	it("LISTENING_RESUME_DATA_DIR overrides everything; default is platform specific", () => {
		const config = loadConfig(dir);
		expect(resolveDataDir(config)).toMatch(/listening-resume$/);
		process.env.LISTENING_RESUME_DATA_DIR = path.join(dir, "override");
		expect(resolveDataDir(config)).toBe(path.join(dir, "override"));
	});
});
