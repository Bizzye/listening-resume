import path from "node:path";
import { describe, expect, it } from "vitest";
import { GroqLLMAdapter } from "../../../src/adapters/analysis/groq-llm.js";
import { contextWindowFor, OllamaAdapter } from "../../../src/adapters/analysis/ollama.js";
import { FakeAnalyzer } from "../../../src/adapters/fake/fake-analyzer.js";
import { FakeTranscriber } from "../../../src/adapters/fake/fake-transcriber.js";
import {
	createTranscriber,
	MISSING_GROQ_KEY_MESSAGE,
	whisperModelPath,
} from "../../../src/adapters/transcription/factory.js";
import { GroqWhisperAdapter } from "../../../src/adapters/transcription/groq-whisper.js";
import {
	parseWhisperCppJson,
	WhisperCppAdapter,
} from "../../../src/adapters/transcription/whisper-cpp.js";
import { parseFlashcards } from "../../../src/templates/index.js";
import { makeTempDir, writeToneWav } from "../../helpers.js";

describe("transcriber factory", () => {
	it("builds Groq with a key and refuses without one (pt-BR message)", () => {
		const groq = createTranscriber("groq", { groqApiKey: "gsk_x", whisperModelsDir: "/m" });
		expect(groq).toBeInstanceOf(GroqWhisperAdapter);
		expect(groq.rateLimited).toBe(true);
		expect(() => createTranscriber("groq", { groqApiKey: " ", whisperModelsDir: "/m" })).toThrow(
			MISSING_GROQ_KEY_MESSAGE,
		);
	});

	it("builds whisper.cpp with the ggml model path", () => {
		const local = createTranscriber("whisper-cpp", {
			whisperModelsDir: "/models",
			whisperModel: "large-v3",
		});
		expect(local).toBeInstanceOf(WhisperCppAdapter);
		expect(local.rateLimited).toBe(false);
		expect(local.model).toBe("large-v3");
		expect(whisperModelPath("/models", "small")).toBe(path.join("/models", "ggml-small.bin"));
	});

	it("whisper.cpp reports a missing model without spawning", async () => {
		const adapter = new WhisperCppAdapter("whisper-cli", "/nope/ggml-medium.bin");
		await expect(adapter.transcribe("a.wav")).rejects.toThrow(/Modelo do Whisper não encontrado/);
	});

	it("parses whisper.cpp JSON output", () => {
		const parsed = parseWhisperCppJson({
			result: { language: "pt" },
			transcription: [
				{ offsets: { from: 0, to: 2500 }, text: " Olá " },
				{ offsets: { from: 2500, to: 3000 }, text: "  " },
				{ offsets: { from: 3000, to: 5200 }, text: "mundo" },
			],
		});
		expect(parsed).toEqual({
			language: "pt",
			segments: [
				{ start: 0, end: 2.5, text: "Olá" },
				{ start: 3, end: 5.2, text: "mundo" },
			],
		});
		expect(parseWhisperCppJson({})).toEqual({ language: null, segments: [] });
	});
});

describe("analysis adapters", () => {
	it("sizes the Ollama context to the prompt", () => {
		expect(contextWindowFor(100)).toBe(8192);
		expect(contextWindowFor(30_000)).toBe(16384);
		expect(contextWindowFor(1_000_000)).toBe(32768);
	});

	it("expose provider/model", () => {
		expect(new OllamaAdapter("qwen2.5:14b")).toMatchObject({
			provider: "ollama",
			model: "qwen2.5:14b",
		});
		expect(new GroqLLMAdapter("gsk_x")).toMatchObject({
			provider: "groq",
			model: "llama-3.3-70b-versatile",
		});
	});

	it("OllamaAdapter.listModels is empty when offline", async () => {
		expect(await new OllamaAdapter("x", "http://127.0.0.1:1").listModels()).toEqual([]);
	});
});

describe("fakes", () => {
	it("FakeTranscriber spreads deterministic pt-BR segments over the real WAV duration", async () => {
		const { dir, cleanup } = makeTempDir();
		try {
			const wav = writeToneWav(path.join(dir, "c.wav"), 6);
			const t = new FakeTranscriber({ segmentsPerChunk: 3 });
			const first = await t.transcribe(wav);
			const again = await new FakeTranscriber({ segmentsPerChunk: 3 }).transcribe(wav);
			expect(first).toEqual(again);
			expect(first.duration).toBeCloseTo(6, 5);
			expect(first.segments.map((s) => [s.start, s.end])).toEqual([
				[0, 2],
				[2, 4],
				[4, 6],
			]);
			expect(first.language).toBe("pt");
			expect(first.fullText).toContain("Listening Resume");
			const second = await t.transcribe(wav);
			expect(second.segments[0].text).not.toBe(first.segments[0].text);
			expect(t.calls).toEqual([wav, wav]);
		} finally {
			cleanup();
		}
	});

	it("FakeTranscriber can fail on demand", async () => {
		await expect(new FakeTranscriber({ failWith: "boom" }).transcribe("x.wav")).rejects.toThrow(
			"boom",
		);
	});

	it("FakeAnalyzer mirrors the prompt's sections and honors model overrides", async () => {
		const a = new FakeAnalyzer();
		const res = await a.analyze({
			systemPrompt: "s",
			userPrompt: "Faça:\n## Contexto\nx\n## Pontos principais\ny",
			model: "qwen2.5:14b",
		});
		expect(res.content).toMatch(/^## Contexto\n/);
		expect(res.content).toContain("## Pontos principais");
		expect(res.model).toBe("qwen2.5:14b");
		expect(a.requests).toHaveLength(1);
	});

	it("FakeAnalyzer answers flashcard prompts with pergunta;resposta lines", async () => {
		const res = await new FakeAnalyzer().analyze({
			systemPrompt: "s",
			userPrompt: "Extraia flashcards no formato pergunta;resposta",
		});
		const cards = parseFlashcards(res.content);
		expect(cards.length).toBeGreaterThanOrEqual(8);
		expect(res.content.split("\n")).toHaveLength(cards.length);
	});

	it("FakeAnalyzer availability/failure switches", async () => {
		const a = new FakeAnalyzer({ available: false, failWith: "down" });
		expect(await a.isAvailable()).toBe(false);
		await expect(a.analyze({ systemPrompt: "", userPrompt: "" })).rejects.toThrow("down");
	});
});
