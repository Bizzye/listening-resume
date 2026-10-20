import { AnalysisError, DomainError, errorMessage, TranscriptionError } from "../domain/errors.js";

type Stage = "transcription" | "analysis";

const RULES: { test: RegExp; message: (stage: Stage) => string }[] = [
	{
		test: /HTTP 401|invalid[_ ]api[_ ]key|unauthorized/i,
		message: () => "Chave da API do Groq inválida. Verifique-a em Configurações.",
	},
	{
		test: /HTTP 429|rate[_ ]limit|too many requests/i,
		message: () => "Limite de uso do Groq atingido. Aguarde alguns minutos e tente novamente.",
	},
	{
		test: /HTTP 413|too large|request entity/i,
		message: () => "Arquivo de áudio grande demais para o provedor de transcrição.",
	},
	{
		test: /model ['"]?[^'"]*['"]? not found|pull the model|try pulling/i,
		message: () =>
			"Modelo de análise não encontrado no Ollama. Baixe-o com `ollama pull <modelo>` ou escolha outro em Configurações.",
	},
	{
		test: /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|fetch failed|connection error|network|socket hang up/i,
		message: (stage) =>
			stage === "analysis"
				? "Não foi possível conectar ao serviço de análise. Verifique se o Ollama está em execução ou sua conexão com a internet."
				: "Sem conexão com o serviço de transcrição. Verifique sua internet e tente novamente.",
	},
];

/**
 * Turns a provider/adapter error into a short pt-BR message for `Session.lastError`.
 * Domain errors (already pt-BR) pass through; upstream provider errors get a prefix.
 */
export function describeFailure(err: unknown, stage: Stage): string {
	const raw = errorMessage(err).trim();
	for (const rule of RULES) {
		if (rule.test.test(raw)) return rule.message(stage);
	}
	const prefix = stage === "transcription" ? "Falha na transcrição" : "Falha na análise";
	if (!raw) return `${prefix}.`;
	const upstream =
		(err instanceof TranscriptionError || err instanceof AnalysisError) && err.upstream;
	if (err instanceof DomainError && !upstream) return raw; // already user-facing pt-BR
	return `${prefix}: ${raw.length > 300 ? `${raw.slice(0, 300)}…` : raw}`;
}

export interface CaptureWarning {
	/** pt-BR text for the UI. */
	message: string;
	/** A named device is unavailable and the system default is being captured instead. */
	fallback: boolean;
}

export const DEVICE_FALLBACK_MESSAGE = "Dispositivo indisponível — usando o padrão do sistema";

/**
 * Turns a raw capture warning (the native binary's `WARN:` text, in English) into a pt-BR
 * message for the UI. Messages already in pt-BR (e.g. the clock resync) pass through. Pure.
 */
export function describeCaptureWarning(raw: string): CaptureWarning {
	const text = raw.trim();
	if (/falling back to the system default/i.test(text)) {
		return { message: DEVICE_FALLBACK_MESSAGE, fallback: true };
	}
	if (/^relógio saltou/i.test(text)) return { message: text, fallback: false };
	return { message: `Aviso da captura de áudio: ${text}`, fallback: false };
}
