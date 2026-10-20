import type { Health, Settings } from "../api/types";

/** Human (pt-BR) list of what is not working, for the dashboard status line. */
export function serviceIssues(
	health: Health | null,
	provider: Settings["transcriptionProvider"] | undefined,
): string[] {
	if (!health) return ["serviço local indisponível"];
	const s = health.services;
	const issues: string[] = [];
	if (!s.capture.ok) issues.push("captura de áudio indisponível");
	if (provider === "groq" ? !s.groq.configured : !s.whisper.ok)
		issues.push(provider === "groq" ? "Groq sem chave" : "Whisper indisponível");
	if (!s.ollama.ok) issues.push("Ollama offline");
	if (!s.ffmpeg.ok) issues.push("FFmpeg não encontrado");
	return issues;
}
