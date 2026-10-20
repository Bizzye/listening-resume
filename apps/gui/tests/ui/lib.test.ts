import { describe, expect, it } from "vitest";
import {
	defaultRecordingTitle,
	fmtClock,
	fmtDuration,
	fmtTotal,
	greeting,
	longDate,
	plural,
	relativeWhen,
	sessionDate,
} from "../../src/shared/lib/format";
import { serviceIssues } from "../../src/shared/lib/health";
import {
	filterSessions,
	sessionPreview,
	sessionTitle,
	templateName,
	transitionToast,
} from "../../src/shared/lib/session";
import { isBusy, isTranscribed, statusBadge } from "../../src/shared/lib/status";
import { makeHealth, makeSession, TEMPLATES } from "./helpers";

describe("duration formatters (design fmt / fmt2)", () => {
	it("fmtClock pads HH:MM:SS", () => {
		expect(fmtClock(0)).toBe("00:00:00");
		expect(fmtClock(65.9)).toBe("00:01:05");
		expect(fmtClock(4358)).toBe("01:12:38");
		expect(fmtClock(-5)).toBe("00:00:00");
	});
	it("fmtDuration is m:ss or h:mm:ss", () => {
		expect(fmtDuration(0)).toBe("0:00");
		expect(fmtDuration(42)).toBe("0:42");
		expect(fmtDuration(2832)).toBe("47:12");
		expect(fmtDuration(4358)).toBe("1:12:38");
		expect(fmtDuration(Number.NaN)).toBe("0:00");
	});
	it("fmtTotal is Xh MMm", () => {
		expect(fmtTotal(0)).toBe("0h 00m");
		expect(fmtTotal(3 * 3600 + 7 * 60 + 59)).toBe("3h 07m");
	});
	it("plural", () => {
		expect(plural(1, "gravação", "gravações")).toBe("1 gravação");
		expect(plural(3, "gravação", "gravações")).toBe("3 gravações");
	});
});

describe("dates (pt-BR)", () => {
	it("greeting by hour", () => {
		expect(greeting(new Date(2026, 6, 10, 9))).toBe("Bom dia");
		expect(greeting(new Date(2026, 6, 10, 12))).toBe("Boa tarde");
		expect(greeting(new Date(2026, 6, 10, 17, 59))).toBe("Boa tarde");
		expect(greeting(new Date(2026, 6, 10, 18))).toBe("Boa noite");
		expect(greeting(new Date(2026, 6, 10, 2))).toBe("Boa noite");
	});
	it("longDate", () => {
		expect(longDate(new Date(2026, 6, 10))).toBe("sexta-feira, 10 de julho");
		expect(longDate(new Date(2026, 9, 11))).toBe("domingo, 11 de outubro");
	});
	const now = new Date(2026, 9, 14, 15, 0); // quarta-feira
	it("sessionDate: hoje / ontem / weekday / day month", () => {
		expect(sessionDate("2026-10-14T09:14:00", now)).toBe("Hoje, 09:14");
		expect(sessionDate("2026-10-13T14:00:00", now)).toBe("Ontem, 14:00");
		expect(sessionDate("2026-10-11T09:10:00", now)).toBe("Dom, 09:10");
		expect(sessionDate("2026-07-10T09:10:00", now)).toBe("10 jul");
		expect(sessionDate("2025-07-10T09:10:00", now)).toBe("10 jul 2025");
		expect(sessionDate(null, now)).toBe("—");
		expect(sessionDate("garbage", now)).toBe("—");
	});
	it("relativeWhen for analysis chips", () => {
		expect(relativeWhen(new Date(now.getTime() - 20_000).toISOString(), now)).toBe("agora");
		expect(relativeWhen("2026-10-13T18:22:00", now)).toBe("ontem, 18:22");
	});
	it("defaultRecordingTitle", () => {
		expect(defaultRecordingTitle("2026-07-10T14:05:00")).toBe("Gravação — 10 jul, 14:05");
		expect(defaultRecordingTitle(null)).toBe("Gravação sem título");
	});
});

describe("status mapping", () => {
	it("maps every backend status to the design badge", () => {
		expect(statusBadge("created")).toMatchObject({ label: "Gravado", cls: "bdg st-n" });
		expect(statusBadge("stopped")).toMatchObject({ label: "Gravado", cls: "bdg st-n" });
		expect(statusBadge("recording")).toMatchObject({ label: "Gravando…", dotCls: "dt pulse" });
		expect(statusBadge("transcribing")).toEqual({
			label: "Transcrevendo…",
			cls: "bdg st-ac",
			dotCls: "dt pulse",
		});
		expect(statusBadge("transcribed")).toEqual({
			label: "Transcrito",
			cls: "bdg st-n",
			dotCls: "dt",
		});
		expect(statusBadge("analyzing")).toEqual({
			label: "Analisando…",
			cls: "bdg st-ac",
			dotCls: "dt pulse",
		});
		expect(statusBadge("completed")).toEqual({
			label: "Concluído",
			cls: "bdg st-ok",
			dotCls: "dt",
		});
		expect(statusBadge("failed")).toEqual({ label: "Falhou", cls: "bdg st-err", dotCls: "dt" });
	});
	it("busy / transcribed predicates", () => {
		expect(isBusy("transcribing")).toBe(true);
		expect(isBusy("analyzing")).toBe(true);
		expect(isBusy("completed")).toBe(false);
		expect(isTranscribed("completed")).toBe(true);
		expect(isTranscribed("stopped")).toBe(false);
	});
});

describe("session helpers", () => {
	it("title falls back to a dated default", () => {
		expect(sessionTitle(makeSession({ title: "Aula 12" }))).toBe("Aula 12");
		expect(sessionTitle(makeSession({ title: null, startedAt: "2026-07-10T14:05:00" }))).toBe(
			"Gravação — 10 jul, 14:05",
		);
	});
	it("preview depends on status", () => {
		expect(sessionPreview(makeSession({ status: "transcribing" }))).toBe(
			"Transcrição em andamento…",
		);
		expect(
			sessionPreview(makeSession({ status: "failed", preview: null, lastError: "Sem memória" })),
		).toBe("Sem memória");
		expect(sessionPreview(makeSession({ status: "stopped", preview: null }))).toBe(
			"Ainda não transcrita.",
		);
	});
	it("filterSessions matches title and preview, case-insensitive", () => {
		const a = makeSession({ title: "Reunião Pagamentos", preview: "pix parcelado" });
		const b = makeSession({ title: "Aula de Física", preview: "entropia" });
		expect(filterSessions([a, b], "")).toEqual([a, b]);
		expect(filterSessions([a, b], "FÍSICA")).toEqual([b]);
		expect(filterSessions([a, b], "pix")).toEqual([a]);
		expect(filterSessions([a, b], "nada")).toEqual([]);
	});
	it("templateName resolves legacy ids", () => {
		const tpls = [...TEMPLATES, { ...TEMPLATES[0], id: "ata-reuniao", name: "Ata de Reunião" }];
		expect(templateName(tpls, "meeting-summary")).toBe("Ata de Reunião");
		expect(templateName(tpls, "resumo-executivo")).toBe("Resumo Executivo");
		expect(templateName(tpls, "unknown")).toBe("unknown");
	});
	it("transitionToast announces finished background jobs", () => {
		const prev = makeSession({ title: "Aula", status: "transcribing" });
		expect(transitionToast(prev, { ...prev, status: "transcribed" })).toEqual({
			msg: "Transcrição concluída — Aula",
			kind: "ok",
		});
		expect(transitionToast(prev, { ...prev, status: "failed" })?.kind).toBe("err");
		const an = makeSession({ status: "analyzing", analysesCount: 1 });
		expect(transitionToast(an, { ...an, status: "completed", analysesCount: 2 })?.msg).toBe(
			"Análise concluída",
		);
		expect(
			transitionToast(an, { ...an, status: "transcribed", lastError: "Ollama offline" })?.msg,
		).toBe("A análise falhou: Ollama offline");
		expect(transitionToast(prev, prev)).toBeNull();
		// auto-transcribe failure: back to "stopped" with lastError
		expect(
			transitionToast(prev, { ...prev, status: "stopped", lastError: "Chave Groq ausente" }),
		).toEqual({
			msg: "A transcrição falhou — Aula: Chave Groq ausente",
			kind: "err",
		});
		// job not started yet: stopped without error is not a failure
		expect(transitionToast(prev, { ...prev, status: "stopped" })).toBeNull();
		// analysis failure returns to the previous status with lastError
		const done = makeSession({ status: "analyzing", analysesCount: 2 });
		expect(transitionToast(done, { ...done, status: "completed", lastError: "timeout" })).toEqual({
			msg: "A análise falhou: timeout",
			kind: "err",
		});
	});
});

describe("serviceIssues", () => {
	it("is empty when everything is up", () => {
		expect(serviceIssues(makeHealth(), "groq")).toEqual([]);
	});
	it("lists what is down, provider-aware", () => {
		const h = makeHealth({
			ollama: { ok: false, model: "x", url: "" },
			groq: { configured: false },
		});
		expect(serviceIssues(h, "groq")).toEqual(["Groq sem chave", "Ollama offline"]);
		expect(serviceIssues(h, "whisper-cpp")).toEqual(["Ollama offline"]);
		expect(serviceIssues(null, "groq")).toEqual(["serviço local indisponível"]);
	});
});
