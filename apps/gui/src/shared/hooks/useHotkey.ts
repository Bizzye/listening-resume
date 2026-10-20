import { useEffect } from "react";
import { useLatest } from "./useLatest";

export interface HotkeySpec {
	key: string;
	ctrl?: boolean;
	shift?: boolean;
	alt?: boolean;
}

export function matchesHotkey(e: KeyboardEvent, spec: HotkeySpec): boolean {
	const ctrl = e.ctrlKey || e.metaKey;
	return (
		e.key.toLowerCase() === spec.key.toLowerCase() &&
		ctrl === !!spec.ctrl &&
		e.shiftKey === !!spec.shift &&
		e.altKey === !!spec.alt
	);
}

/** Global keydown shortcut; prevents the browser default (Ctrl+Shift+R would hard-reload). */
export function useHotkey(spec: HotkeySpec, handler: () => void, enabled = true): void {
	const latest = useLatest(handler);
	const { key, ctrl, shift, alt } = spec;
	useEffect(() => {
		if (!enabled) return;
		const onKey = (e: KeyboardEvent) => {
			if (!matchesHotkey(e, { key, ctrl, shift, alt })) return;
			e.preventDefault();
			if (!e.repeat) latest.current();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [key, ctrl, shift, alt, enabled, latest]);
}
