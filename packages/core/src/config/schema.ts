import { z } from "zod/v4";
import {
	DEFAULT_ANALYSIS_MODEL,
	DEFAULT_CHANNELS,
	DEFAULT_CHUNK_SECONDS,
	DEFAULT_GROQ_LLM_MODEL,
	DEFAULT_GROQ_WHISPER_MODEL,
	DEFAULT_MIC_VOLUME,
	DEFAULT_OLLAMA_HOST,
	DEFAULT_SAMPLE_RATE,
	SYSTEM_DEFAULT_DEVICE,
} from "../constants.js";
import { DEFAULT_TEMPLATE_ID } from "../templates/builtin.js";

const LEGACY_BACKENDS: Record<string, string> = {
	"ffmpeg-wasapi": "wasapi",
	"ffmpeg-pulse": "pulse",
};

export const audioConfigSchema = z.object({
	backend: z
		.preprocess(
			(v) => (typeof v === "string" ? (LEGACY_BACKENDS[v] ?? v) : v),
			z.enum(["wasapi", "pulse", "fake"]),
		)
		.default(process.platform === "win32" ? "wasapi" : "pulse"),
	/** Device id or `@default` (follows the OS default output). */
	device: z.string().default(SYSTEM_DEFAULT_DEVICE),
	/**
	 * Low-level fallback only: the user's device/mic preferences live in `settings.json`
	 * (`SettingsStore`), which the GUI and the CLI read first. Same default as the settings.
	 */
	micDevice: z.string().nullable().default(SYSTEM_DEFAULT_DEVICE),
	micVolume: z.number().min(0).max(2).default(DEFAULT_MIC_VOLUME),
	chunkSeconds: z.number().min(5).max(300).default(DEFAULT_CHUNK_SECONDS),
	sampleRate: z.number().int().min(8000).max(48000).default(DEFAULT_SAMPLE_RATE),
	channels: z.number().int().min(1).max(2).default(DEFAULT_CHANNELS),
});

export const transcriptionConfigSchema = z.object({
	provider: z.enum(["groq", "whisper-cpp"]).default("groq"),
	/** Groq Whisper model. */
	model: z.string().default(DEFAULT_GROQ_WHISPER_MODEL),
	language: z.string().default("auto"),
	prompt: z.string().default(""),
	/** whisper.cpp CLI executable (name on PATH or absolute path). */
	whisperBinary: z.string().default("whisper-cli"),
	/** Directory with `ggml-<model>.bin` files; default `<dataDir>/models`. */
	whisperModelsDir: z.string().nullable().default(null),
	whisperModel: z.enum(["small", "medium", "large-v3"]).default("medium"),
});

export const analysisConfigSchema = z.object({
	provider: z.enum(["ollama", "groq"]).default("ollama"),
	model: z.string().default(DEFAULT_ANALYSIS_MODEL),
	/** Lazy: `OLLAMA_HOST` may come from a `.env` loaded after this module was imported. */
	ollamaHost: z.string().default(() => process.env.OLLAMA_HOST || DEFAULT_OLLAMA_HOST),
	defaultTemplate: z.string().default(DEFAULT_TEMPLATE_ID),
	/** Extra instructions appended to every analysis system prompt. */
	prompt: z.string().default(""),
	fallback: z
		.object({
			provider: z.enum(["ollama", "groq"]).default("groq"),
			model: z.string().default(DEFAULT_GROQ_LLM_MODEL),
		})
		.optional(),
});

export const rateLimitsConfigSchema = z.object({
	groqRpm: z.number().default(18),
	groqAudioSecondsPerHour: z.number().default(7000),
});

export const storageConfigSchema = z.object({
	/** Empty = platform default (see `defaultDataDir`). */
	dataDir: z.string().default(""),
});

const section = <T extends z.ZodType>(schema: T) => z.preprocess((v) => v ?? {}, schema);

export const appConfigSchema = z.object({
	audio: section(audioConfigSchema),
	transcription: section(transcriptionConfigSchema),
	analysis: section(analysisConfigSchema),
	rateLimits: section(rateLimitsConfigSchema),
	storage: section(storageConfigSchema),
});

export type AppConfig = z.infer<typeof appConfigSchema>;
