import { describe, expect, it } from "vitest";
import { selectAnalyzers } from "../../../src/adapters/analysis/select.js";
import { FakeAnalyzer } from "../../../src/adapters/fake/fake-analyzer.js";

describe("selectAnalyzers", () => {
	const ollama = new FakeAnalyzer();
	const groq = new FakeAnalyzer();

	it("uses Ollama as primary and Groq as fallback by default", () => {
		expect(selectAnalyzers("ollama", ollama, groq).primary).toBe(ollama);
		expect(selectAnalyzers("ollama", ollama, groq).fallback).toBe(groq);
	});

	it("makes Groq primary with Ollama as fallback when the provider is groq", () => {
		expect(selectAnalyzers("groq", ollama, groq).primary).toBe(groq);
		expect(selectAnalyzers("groq", ollama, groq).fallback).toBe(ollama);
	});

	it("keeps Ollama primary with no fallback when groq is requested but no key exists", () => {
		expect(selectAnalyzers("groq", ollama, null).primary).toBe(ollama);
		expect(selectAnalyzers("groq", ollama, null).fallback).toBe(null);
		expect(selectAnalyzers("ollama", ollama, null).primary).toBe(ollama);
		expect(selectAnalyzers("ollama", ollama, null).fallback).toBe(null);
	});
});
