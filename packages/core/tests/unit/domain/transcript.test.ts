import { describe, expect, it } from "vitest";
import { describeFailure } from "../../../src/application/error-messages.js";
import {
	AnalysisError,
	ConflictError,
	NotFoundError,
	RecordingInProgressError,
	TranscriptionError,
	ValidationError,
} from "../../../src/domain/errors.js";
import { buildTranscriptPreview, isSilenceArtifact } from "../../../src/domain/transcript.js";

const seg = (text: string) => ({ start: 0, end: 1, text });

describe("buildTranscriptPreview", () => {
	it("skips Whisper silence hallucinations", () => {
		expect(isSilenceArtifact(" Obrigado. ")).toBe(true);
		expect(
			buildTranscriptPreview({
				segments: [seg("Thank you."), seg("Bom dia, pessoal."), seg("Obrigado."), seg("Vamos lá.")],
				fullText: "",
			}),
		).toBe("Bom dia, pessoal. Vamos lá.");
	});

	it("truncates at a word boundary with an ellipsis", () => {
		const text = "palavra ".repeat(40).trim();
		const preview = buildTranscriptPreview({ segments: [seg(text)], fullText: text }, 50);
		expect(preview?.endsWith("…")).toBe(true);
		expect(preview?.length).toBeLessThanOrEqual(51);
		expect(preview).not.toContain("palavra p…");
	});

	it("returns null when there is nothing meaningful", () => {
		expect(buildTranscriptPreview(null)).toBeNull();
		expect(buildTranscriptPreview({ segments: [seg("you")], fullText: "you" })).toBeNull();
		expect(buildTranscriptPreview({ segments: [], fullText: "texto livre" })).toBe("texto livre");
	});
});

describe("domain errors", () => {
	it("carry an HTTP-mappable kind", () => {
		expect(new ValidationError("x").kind).toBe("validation");
		expect(new NotFoundError("x").kind).toBe("not_found");
		expect(new ConflictError("x").kind).toBe("conflict");
		const busy = new RecordingInProgressError("s1");
		expect(busy.kind).toBe("conflict");
		expect(busy.sessionId).toBe("s1");
		expect(new TranscriptionError("x").kind).toBe("internal");
	});
});

describe("describeFailure", () => {
	it("maps provider errors to friendly pt-BR messages", () => {
		expect(
			describeFailure(
				new TranscriptionError("Groq HTTP 401: Invalid API Key", { upstream: true }),
				"transcription",
			),
		).toMatch(/Chave da API do Groq inválida/);
		expect(describeFailure(new Error("429 rate_limit_exceeded"), "transcription")).toMatch(
			/Limite de uso do Groq/,
		);
		expect(describeFailure(new Error("fetch failed"), "transcription")).toMatch(/Sem conexão/);
		expect(describeFailure(new Error("connect ECONNREFUSED 127.0.0.1:11434"), "analysis")).toMatch(
			/Ollama/,
		);
		expect(
			describeFailure(
				new AnalysisError('Ollama (x): model "x" not found, try pulling it first', {
					upstream: true,
				}),
				"analysis",
			),
		).toMatch(/ollama pull/);
	});

	it("passes our own pt-BR domain messages through and prefixes the rest", () => {
		expect(
			describeFailure(new TranscriptionError("Nenhum áudio foi gravado."), "transcription"),
		).toBe("Nenhum áudio foi gravado.");
		expect(
			describeFailure(
				new TranscriptionError("Groq HTTP 500: boom", { upstream: true }),
				"transcription",
			),
		).toBe("Falha na transcrição: Groq HTTP 500: boom");
		expect(describeFailure(new Error("weird"), "analysis")).toBe("Falha na análise: weird");
		expect(describeFailure("", "analysis")).toBe("Falha na análise.");
	});
});
