import type { Theme } from "../api/types";

const THEME_KEY = "lr-theme";

/** localStorage can throw (privacy mode, blocked storage) — never let that break the app. */
export function readStoredTheme(): Theme {
	try {
		return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
	} catch {
		return "dark";
	}
}

export function storeTheme(theme: Theme): void {
	try {
		localStorage.setItem(THEME_KEY, theme);
	} catch {
		// ignore
	}
	document.documentElement.dataset.theme = theme;
}
