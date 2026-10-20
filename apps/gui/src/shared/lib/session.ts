import type { SessionSummary, Template } from "../api/types";
import { resolveTemplateId } from "./core-shared";
import { defaultRecordingTitle, sessionDate } from "./format";

export function sessionTitle(s: Pick<SessionSummary, "title" | "startedAt" | "createdAt">): string {
	return s.title?.trim() || defaultRecordingTitle(s.startedAt ?? s.createdAt);
}

export function sessionSource(s: Pick<SessionSummary, "audioSource">): string {
	return s.audioSource?.trim() || "Áudio do sistema";
}

export function sessionMeta(s: SessionSummary, now = new Date()): string {
	return `${sessionDate(s.startedAt ?? s.createdAt, now)} · ${sessionSource(s)}`;
}

export function sessionPreview(s: SessionSummary): string {
	if (s.status === "transcribing") return "Transcrição em andamento…";
	if (s.status === "recording") return "Gravação em andamento…";
	if (s.status === "failed" && !s.preview) return s.lastError || "A transcrição falhou.";
	return s.preview || "Ainda não transcrita.";
}

/** Case-insensitive filter over title + preview (instant feedback before the server search returns). */
export function filterSessions(list: SessionSummary[], query: string): SessionSummary[] {
	const q = query.trim().toLowerCase();
	if (!q) return list;
	return list.filter((s) =>
		`${sessionTitle(s)} ${s.preview ?? ""} ${s.audioSource ?? ""}`.toLowerCase().includes(q),
	);
}

export function templateName(templates: Template[], id: string): string {
	const real = resolveTemplateId(id);
	return templates.find((t) => t.id === real)?.name ?? id;
}

export interface ToastSpec {
	msg: string;
	kind: "ok" | "ac" | "err";
}

/** Toast to show when a background job on a session finishes (detected by polling). */
export function transitionToast(prev: SessionSummary, next: SessionSummary): ToastSpec | null {
	if (prev.status === next.status) return null;
	const title = sessionTitle(next);
	if (prev.status === "transcribing") {
		if (next.status === "transcribed" || next.status === "completed")
			return { msg: `Transcrição concluída — ${title}`, kind: "ok" };
		// Failure: status "failed", or back to "stopped" with lastError (auto-transcribe).
		if (next.status === "failed" || next.lastError)
			return {
				msg: next.lastError
					? `A transcrição falhou — ${title}: ${next.lastError}`
					: `A transcrição falhou — ${title}`,
				kind: "err",
			};
	}
	if (prev.status === "analyzing") {
		// Failure returns to the previous status (transcribed/completed) and sets lastError.
		if (next.analysesCount > prev.analysesCount) return { msg: "Análise concluída", kind: "ok" };
		return {
			msg: next.lastError ? `A análise falhou: ${next.lastError}` : "A análise falhou",
			kind: "err",
		};
	}
	return null;
}
