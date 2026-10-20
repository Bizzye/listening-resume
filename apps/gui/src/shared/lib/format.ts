// Formatters. Month/weekday names are hard-coded (pt-BR) so output never depends on the
// host ICU data.

import { formatTimestamp } from "./core-shared";

const pad = (n: number) => String(n).padStart(2, "0");

/** HH:MM:SS — the recording timer (design `fmt`). */
export function fmtClock(sec: number): string {
	const s = Math.max(0, Math.floor(sec || 0));
	return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/** m:ss or h:mm:ss — durations and timestamps (design `fmt2` = core `formatTimestamp`). */
export function fmtDuration(sec: number): string {
	return formatTimestamp(Number.isFinite(sec) ? sec : 0);
}

/** "3h 07m" — dashboard total. */
export function fmtTotal(sec: number): string {
	const s = Math.max(0, Math.floor(sec || 0));
	return `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`;
}

export function greeting(d: Date): string {
	const h = d.getHours();
	if (h >= 5 && h < 12) return "Bom dia";
	if (h >= 12 && h < 18) return "Boa tarde";
	return "Boa noite";
}

const WEEKDAYS_LONG = [
	"domingo",
	"segunda-feira",
	"terça-feira",
	"quarta-feira",
	"quinta-feira",
	"sexta-feira",
	"sábado",
];
const WEEKDAYS_SHORT = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const MONTHS_LONG = [
	"janeiro",
	"fevereiro",
	"março",
	"abril",
	"maio",
	"junho",
	"julho",
	"agosto",
	"setembro",
	"outubro",
	"novembro",
	"dezembro",
];
const MONTHS_SHORT = [
	"jan",
	"fev",
	"mar",
	"abr",
	"mai",
	"jun",
	"jul",
	"ago",
	"set",
	"out",
	"nov",
	"dez",
];

/** "sexta-feira, 10 de julho" */
export function longDate(d: Date): string {
	return `${WEEKDAYS_LONG[d.getDay()]}, ${d.getDate()} de ${MONTHS_LONG[d.getMonth()]}`;
}

const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const dayDiff = (d: Date, now: Date) => Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);

function parse(iso: string | null | undefined): Date | null {
	if (!iso) return null;
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? null : d;
}

/** "Hoje, 09:14" · "Ontem, 14:00" · "Ter, 09:10" · "10 jul" · "10 jul 2024" */
export function sessionDate(iso: string | null | undefined, now = new Date()): string {
	const d = parse(iso);
	if (!d) return "—";
	const diff = dayDiff(d, now);
	if (diff === 0) return `Hoje, ${hhmm(d)}`;
	if (diff === 1) return `Ontem, ${hhmm(d)}`;
	if (diff > 1 && diff < 7) return `${WEEKDAYS_SHORT[d.getDay()]}, ${hhmm(d)}`;
	const base = `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
	return d.getFullYear() === now.getFullYear() ? base : `${base} ${d.getFullYear()}`;
}

/** Analysis chip label: "agora" · "hoje, 09:14" · "ontem, 18:22" · "ter, 11:40" · "10 jul" */
export function relativeWhen(iso: string | null | undefined, now = new Date()): string {
	const d = parse(iso);
	if (!d) return "—";
	if (now.getTime() - d.getTime() < 60_000 && now.getTime() >= d.getTime()) return "agora";
	const label = sessionDate(iso, now);
	return label.charAt(0).toLowerCase() + label.slice(1);
}

/** Default title for untitled recordings: "Gravação — 10 jul, 14:05" */
export function defaultRecordingTitle(iso: string | null | undefined): string {
	const d = parse(iso);
	if (!d) return "Gravação sem título";
	return `Gravação — ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}, ${hhmm(d)}`;
}

export function plural(n: number, one: string, many: string): string {
	return `${n} ${n === 1 ? one : many}`;
}
