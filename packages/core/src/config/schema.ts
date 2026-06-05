import path from "node:path";
import { z } from "zod/v4";

export const audioConfigSchema = z.object({
	backend: z
		.enum(["ffmpeg-pulse", "ffmpeg-wasapi"])
		.default(process.platform === "win32" ? "ffmpeg-wasapi" : "ffmpeg-pulse"),
	device: z.string().default(process.platform === "win32" ? "Stereo Mix" : "default.monitor"),
	micDevice: z.string().nullable().default(null),
	micVolume: z.number().min(0).max(2).default(1.2),
	chunkSeconds: z.number().min(5).max(300).default(120),
	sampleRate: z.number().default(16000),
	channels: z.number().default(1),
});

export const transcriptionConfigSchema = z.object({
	provider: z.enum(["groq", "whisper-cpp", "openai"]).default("groq"),
	model: z.string().default("whisper-large-v3-turbo"),
	language: z.string().default("auto"),
	prompt: z.string().default(""),
	fallback: z
		.object({
			provider: z.enum(["groq", "whisper-cpp", "openai"]).default("whisper-cpp"),
			model: z.string().default("small"),
		})
		.optional(),
});

export const analysisConfigSchema = z.object({
	provider: z.enum(["ollama", "groq", "openai", "anthropic"]).default("ollama"),
	model: z.string().default("llama3.1:8b"),
	defaultTemplate: z.string().default("meeting-summary"),
	prompt: z.string().default(""),
	fallback: z
		.object({
			provider: z.enum(["ollama", "groq", "openai", "anthropic"]).default("groq"),
			model: z.string().default("llama-3.3-70b-versatile"),
		})
		.optional(),
});

export const rateLimitsConfigSchema = z.object({
	groqRpm: z.number().default(18),
	groqAudioSecondsPerHour: z.number().default(7000),
});

export const storageConfigSchema = z.object({
	dataDir: z
		.string()
		.default(
			process.platform === "win32"
				? path.join(process.env.LOCALAPPDATA || "~", "listening-resume")
				: "~/.local/share/listening-resume",
		),
	exportDir: z
		.string()
		.default(
			process.platform === "win32"
				? path.join(process.env.USERPROFILE || "~", "Documents", "listening-resume")
				: path.join(process.env.HOME || "~", "Documents", "listening-resume"),
		),
});

export const appConfigSchema = z.object({
	audio: z.preprocess((v) => v ?? {}, audioConfigSchema),
	transcription: z.preprocess((v) => v ?? {}, transcriptionConfigSchema),
	analysis: z.preprocess((v) => v ?? {}, analysisConfigSchema),
	rateLimits: z.preprocess((v) => v ?? {}, rateLimitsConfigSchema),
	storage: z.preprocess((v) => v ?? {}, storageConfigSchema),
});

export type AppConfig = z.infer<typeof appConfigSchema>;
