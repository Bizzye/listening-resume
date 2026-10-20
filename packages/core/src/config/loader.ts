import fs from "node:fs";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { parse as parseToml } from "smol-toml";
import { ConfigError } from "../domain/errors.js";
import { defaultDataDir, expandHome, resolveConfigDir } from "./paths.js";
import { type AppConfig, appConfigSchema } from "./schema.js";

/**
 * Loads `.env` (cwd first, then the config dir — existing variables are never overridden)
 * and `<configDir>/config.toml` (snake_case keys), validated with zod.
 */
export function loadConfig(configDir: string = resolveConfigDir()): AppConfig {
	loadEnv({ quiet: true });
	loadEnv({ path: path.join(configDir, ".env"), quiet: true });

	const configFile = path.join(configDir, "config.toml");
	let raw: Record<string, unknown> = {};
	if (fs.existsSync(configFile)) {
		try {
			raw = parseToml(fs.readFileSync(configFile, "utf-8")) as Record<string, unknown>;
		} catch (err) {
			throw new ConfigError(`Failed to parse config file at ${configFile}: ${err}`);
		}
	}

	const result = appConfigSchema.safeParse(snakeToCamelKeys(raw));
	if (!result.success) {
		throw new ConfigError(`Invalid configuration: ${JSON.stringify(result.error.issues)}`);
	}
	return result.data;
}

/** `LISTENING_RESUME_DATA_DIR` env > `storage.data_dir` > platform default. */
export function resolveDataDir(config: AppConfig): string {
	const override = process.env.LISTENING_RESUME_DATA_DIR;
	if (override) return path.resolve(override);
	const configured = config.storage.dataDir.trim();
	return path.resolve(configured ? expandHome(configured) : defaultDataDir());
}

function snakeToCamelKeys(raw: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw)) {
		const camelKey = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
		result[camelKey] =
			value && typeof value === "object" && !Array.isArray(value)
				? snakeToCamelKeys(value as Record<string, unknown>)
				: value;
	}
	return result;
}
