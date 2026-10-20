import type { SessionStatus } from "../api/types";
import { SESSION_STATUS_LABELS } from "./core-shared";

export interface StatusBadgeInfo {
	label: string;
	/** Badge classes from the design (`bdg st-*`). */
	cls: string;
	/** Dot classes (`dt`, plus `pulse` while work is in progress). */
	dotCls: string;
}

/** Design badge styling per status; the wording comes from core (`SESSION_STATUS_LABELS`). */
const STYLES: Record<SessionStatus, Omit<StatusBadgeInfo, "label">> = {
	created: { cls: "bdg st-n", dotCls: "dt" },
	recording: { cls: "bdg st-err", dotCls: "dt pulse" },
	stopped: { cls: "bdg st-n", dotCls: "dt" },
	transcribing: { cls: "bdg st-ac", dotCls: "dt pulse" },
	transcribed: { cls: "bdg st-n", dotCls: "dt" },
	analyzing: { cls: "bdg st-ac", dotCls: "dt pulse" },
	completed: { cls: "bdg st-ok", dotCls: "dt" },
	failed: { cls: "bdg st-err", dotCls: "dt" },
};

export function statusBadge(status: SessionStatus): StatusBadgeInfo {
	const known = status in STYLES ? status : "stopped";
	return { label: SESSION_STATUS_LABELS[known], ...STYLES[known] };
}

/** Statuses during which the server is doing background work on the session. */
export function isBusy(status: SessionStatus): boolean {
	return status === "transcribing" || status === "analyzing";
}

/** Statuses where a transcript is expected to exist. */
export function isTranscribed(status: SessionStatus): boolean {
	return status === "transcribed" || status === "analyzing" || status === "completed";
}
