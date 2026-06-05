import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { parse as parseToml } from "smol-toml";
import { ConfigError } from "../domain/errors.js";
import { type AppConfig, appConfigSchema } from "./schema.js";

const CONFIG_DIR =
	process.platform === "win32"
		? path.join(
				process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
				"listening-resume",
			)
		: path.join(os.homedir(), ".config", "listening-resume");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.toml");

export function loadConfig(): AppConfig {
	loadEnv();

	let rawConfig: Record<string, unknown> = {};

	if (fs.existsSync(CONFIG_FILE)) {
		try {
			const content = fs.readFileSync(CONFIG_FILE, "utf-8");
			rawConfig = parseToml(content) as Record<string, unknown>;
		} catch (err) {
			throw new ConfigError(`Failed to parse config file at ${CONFIG_FILE}: ${err}`);
		}
	}

	// Convert snake_case TOML keys to camelCase
	const mapped = mapConfig(rawConfig);

	const result = appConfigSchema.safeParse(mapped);
	if (!result.success) {
		throw new ConfigError(`Invalid configuration: ${JSON.stringify(result.error.issues)}`);
	}

	return result.data;
}

export function resolveDataDir(config: AppConfig): string {
	const override = process.env.LISTENING_RESUME_DATA_DIR;
	if (override) return path.resolve(override);
	const dir = config.storage.dataDir.replace("~", os.homedir());
	return path.resolve(dir);
}

function mapConfig(raw: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(raw)) {
		const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
		if (value && typeof value === "object" && !Array.isArray(value)) {
			result[camelKey] = mapConfig(value as Record<string, unknown>);
		} else {
			result[camelKey] = value;
		}
	}

	return result;
}
