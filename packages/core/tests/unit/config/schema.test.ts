import { describe, expect, it } from "vitest";
import { appConfigSchema } from "../../../src/config/schema.js";

describe("Config Schema", () => {
	it("provides defaults for empty config", () => {
		const result = appConfigSchema.parse({});
		const isWindows = process.platform === "win32";
		expect(result.audio.backend).toBe(isWindows ? "ffmpeg-wasapi" : "ffmpeg-pulse");
		expect(result.audio.device).toBe(isWindows ? "Stereo Mix" : "default.monitor");
		expect(result.audio.chunkSeconds).toBe(120);
		expect(result.audio.sampleRate).toBe(16000);
		expect(result.audio.channels).toBe(1);
		expect(result.transcription.provider).toBe("groq");
		expect(result.transcription.model).toBe("whisper-large-v3-turbo");
		expect(result.analysis.provider).toBe("ollama");
		expect(result.analysis.model).toBe("llama3.1:8b");
		expect(result.analysis.defaultTemplate).toBe("meeting-summary");
		expect(result.rateLimits.groqRpm).toBe(18);
	});

	it("validates chunk seconds range", () => {
		expect(() => appConfigSchema.parse({ audio: { chunkSeconds: 2 } })).toThrow();
		expect(() => appConfigSchema.parse({ audio: { chunkSeconds: 500 } })).toThrow();
	});

	it("accepts valid overrides", () => {
		const result = appConfigSchema.parse({
			audio: { device: "my-device.monitor", chunkSeconds: 60 },
			transcription: { provider: "whisper-cpp", language: "pt" },
			analysis: { provider: "groq", model: "llama-3.3-70b-versatile" },
		});
		expect(result.audio.device).toBe("my-device.monitor");
		expect(result.audio.chunkSeconds).toBe(60);
		expect(result.transcription.provider).toBe("whisper-cpp");
		expect(result.transcription.language).toBe("pt");
		expect(result.analysis.provider).toBe("groq");
	});

	it("rejects invalid providers", () => {
		expect(() => appConfigSchema.parse({ transcription: { provider: "invalid" } })).toThrow();
		expect(() => appConfigSchema.parse({ analysis: { provider: "invalid" } })).toThrow();
	});
});
