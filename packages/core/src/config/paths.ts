import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const APP_DIR = "listening-resume";

/** Overrides the config dir (tests, portable setups). */
export const CONFIG_DIR_ENV = "LISTENING_RESUME_CONFIG_DIR";

/**
 * `LISTENING_RESUME_CONFIG_DIR` > `%APPDATA%\listening-resume` (Windows) /
 * `~/.config/listening-resume`. Holds `.env`, `config.toml`, `settings.json`.
 */
export function resolveConfigDir(): string {
	const override = process.env[CONFIG_DIR_ENV]?.trim();
	if (override) return path.resolve(override);
	if (process.platform === "win32") {
		const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
		return path.join(appData, APP_DIR);
	}
	const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
	return path.join(xdg, APP_DIR);
}

/** `%LOCALAPPDATA%\listening-resume` (Windows) / `~/.local/share/listening-resume`. */
export function defaultDataDir(): string {
	if (process.platform === "win32") {
		const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
		return path.join(local, APP_DIR);
	}
	const xdg = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
	return path.join(xdg, APP_DIR);
}

export function expandHome(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
	return p;
}

let documentsDirCache: string | null = null;

/**
 * The user's Documents folder. On Windows it is read from the shell folders registry key, as
 * it is frequently redirected (OneDrive, localized names); falls back to `~/Documents`.
 */
export function resolveDocumentsDir(): string {
	if (documentsDirCache) return documentsDirCache;
	let dir: string | null = null;
	if (process.platform === "win32") {
		try {
			const out = execFileSync(
				"reg",
				[
					"query",
					"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders",
					"/v",
					"Personal",
				],
				{
					encoding: "utf-8",
					timeout: 3000,
					stdio: ["ignore", "pipe", "ignore"],
					windowsHide: true,
				},
			);
			const match = out.match(/Personal\s+REG_(?:EXPAND_)?SZ\s+(.+)/);
			if (match) {
				dir = match[1]
					.trim()
					.replace(/%([^%]+)%/g, (_, name: string) => process.env[name] ?? `%${name}%`);
			}
		} catch {
			// fall through to the default
		}
	}
	if (!dir || dir.includes("%") || !fs.existsSync(dir)) {
		dir = path.join(os.homedir(), "Documents");
	}
	documentsDirCache = dir;
	return dir;
}

export function defaultExportDir(): string {
	return path.join(resolveDocumentsDir(), "ListeningResume");
}
