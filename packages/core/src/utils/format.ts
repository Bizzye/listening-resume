/** `m:ss` or `h:mm:ss`. */
export function formatTimestamp(seconds: number): string {
	const total = Math.max(0, Math.floor(seconds));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const ss = String(s).padStart(2, "0");
	return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** `1 h 12 min`, `4 min 05 s`, `38 s`. */
export function formatDuration(seconds: number): string {
	const total = Math.max(0, Math.round(seconds));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	if (h > 0) return `${h} h ${String(m).padStart(2, "0")} min`;
	if (m > 0) return `${m} min ${String(s).padStart(2, "0")} s`;
	return `${s} s`;
}
