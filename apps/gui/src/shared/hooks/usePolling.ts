import { useEffect } from "react";
import { useLatest } from "./useLatest";

/** Calls `fn` every `intervalMs` while `enabled`. Overlapping calls are skipped. */
export function usePolling(fn: () => unknown, intervalMs: number, enabled = true): void {
	const latest = useLatest(fn);
	useEffect(() => {
		if (!enabled) return;
		let inFlight = false;
		const id = setInterval(async () => {
			if (inFlight) return;
			inFlight = true;
			try {
				await latest.current();
			} finally {
				inFlight = false;
			}
		}, intervalMs);
		return () => clearInterval(id);
	}, [enabled, intervalMs, latest]);
}
