import { useEffect } from "react";
import { useLatest } from "./useLatest";

/** Runs `handler` on any document click while enabled (closes popovers on outside click). */
export function useDocumentClick(handler: () => void, enabled: boolean): void {
	const latest = useLatest(handler);
	useEffect(() => {
		if (!enabled) return;
		const onClick = () => latest.current();
		document.addEventListener("click", onClick);
		return () => document.removeEventListener("click", onClick);
	}, [enabled, latest]);
}
