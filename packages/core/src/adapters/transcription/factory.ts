import path from "node:path";
import { TranscriptionError } from "../../domain/errors.js";
import type { TranscriberPort, TranscriptionProvider } from "../../ports/transcriber.js";
import { GroqWhisperAdapter } from "./groq-whisper.js";
import { WhisperCppAdapter } from "./whisper-cpp.js";

export type WhisperModel = "small" | "medium" | "large-v3";

export interface TranscriberConfig {
	groqApiKey?: string | null;
	/** Groq Whisper model (default `whisper-large-v3-turbo`). */
	groqModel?: string;
	/** whisper.cpp executable (default `whisper-cli`). */
	whisperBinary?: string;
	/** Directory holding `ggml-<model>.bin`. */
	whisperModelsDir: string;
	whisperModel?: WhisperModel;
}

export const MISSING_GROQ_KEY_MESSAGE =
	"Chave da API do Groq não configurada. Adicione-a em Configurações.";

export function whisperModelPath(modelsDir: string, model: WhisperModel): string {
	return path.join(modelsDir, `ggml-${model}.bin`);
}

/** Builds the transcriber for `provider` — lets callers pick it per call from settings. */
export function createTranscriber(
	provider: TranscriptionProvider,
	config: TranscriberConfig,
): TranscriberPort {
	if (provider === "groq") {
		const key = config.groqApiKey?.trim();
		if (!key) throw new TranscriptionError(MISSING_GROQ_KEY_MESSAGE);
		return new GroqWhisperAdapter(key, config.groqModel);
	}
	const model = config.whisperModel ?? "medium";
	return new WhisperCppAdapter(
		config.whisperBinary ?? "whisper-cli",
		whisperModelPath(config.whisperModelsDir, model),
		model,
	);
}
