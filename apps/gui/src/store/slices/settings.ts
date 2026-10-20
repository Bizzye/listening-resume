import { api, errorMessage } from "../../shared/api/client";
import type { Settings, Theme } from "../../shared/api/types";
import { readStoredTheme, storeTheme } from "../../shared/lib/storage";
import type { SliceCreator } from "../types";

export interface SettingsSlice {
	settings: Settings | null;
	/** Mirrors settings.theme; initialised from localStorage so the first paint is right. */
	theme: Theme;
	loadSettings: () => Promise<Settings>;
	/** Optimistic PATCH; rolls back and toasts on failure. */
	updateSettings: (patch: Partial<Settings>) => Promise<boolean>;
	toggleTheme: () => void;
}

export const createSettingsSlice: SliceCreator<SettingsSlice> = (set, get) => ({
	settings: null,
	theme: readStoredTheme(),
	loadSettings: async () => {
		const settings = await api.getSettings();
		storeTheme(settings.theme);
		set({ settings, theme: settings.theme });
		return settings;
	},
	updateSettings: async (patch) => {
		const prev = get().settings;
		if (prev) set({ settings: { ...prev, ...patch } });
		if (patch.theme) {
			storeTheme(patch.theme);
			set({ theme: patch.theme });
		}
		try {
			const settings = await api.patchSettings(patch);
			set({ settings, theme: settings.theme });
			return true;
		} catch (err) {
			if (prev) {
				set({ settings: prev, theme: prev.theme });
				storeTheme(prev.theme);
			}
			get().pop(`Não foi possível salvar: ${errorMessage(err)}`, "err");
			return false;
		}
	},
	toggleTheme: () => {
		const next: Theme = get().theme === "dark" ? "light" : "dark";
		void get().updateSettings({ theme: next });
	},
});
