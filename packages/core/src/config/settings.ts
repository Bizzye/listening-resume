import fs from "node:fs";
import path from "node:path";
import { z } from "zod/v4";
import { DEFAULT_ANALYSIS_MODEL, SYSTEM_DEFAULT_DEVICE } from "../constants.js";
import { ValidationError } from "../domain/errors.js";
import { DEFAULT_TEMPLATE_ID } from "../templates/builtin.js";
import { logger } from "../utils/logger.js";
import { defaultExportDir, resolveConfigDir } from "./paths.js";

/** User preferences edited in the GUI, persisted as `settings.json` in the config dir. */
export const settingsSchema = z.object({
	onboardingDone: z.boolean().default(false),
	theme: z.enum(["dark", "light"]).default("dark"),
	systemDevice: z.string().min(1).default(SYSTEM_DEFAULT_DEVICE),
	/** `null` = record without microphone. */
	micDevice: z.string().min(1).nullable().default(SYSTEM_DEFAULT_DEVICE),
	transcriptionProvider: z.enum(["groq", "whisper-cpp"]).default("groq"),
	whisperModel: z.enum(["small", "medium", "large-v3"]).default("medium"),
	autoTranscribe: z.boolean().default(true),
	silenceDetection: z.boolean().default(true),
	analysisModel: z.string().min(1).default(DEFAULT_ANALYSIS_MODEL),
	analysisLanguage: z.enum(["pt-BR", "en"]).default("pt-BR"),
	defaultTemplateId: z.string().min(1).default(DEFAULT_TEMPLATE_ID),
	exportDir: z
		.string()
		.min(1)
		.default(() => defaultExportDir()),
	exportFormat: z.enum(["md", "pdf", "docx"]).default("md"),
});

export type Settings = z.infer<typeof settingsSchema>;
export type SettingsPatch = Partial<Settings>;

const patchSchema = settingsSchema.partial().strict();

export const SETTINGS_FILE_NAME = "settings.json";

export function defaultSettingsPath(): string {
	return path.join(resolveConfigDir(), SETTINGS_FILE_NAME);
}

export function defaultSettings(): Settings {
	return settingsSchema.parse({});
}

/**
 * Reads/writes `settings.json`. Unknown or invalid stored values fall back to their default
 * (a corrupt file never blocks the app); writes are validated and atomic (tmp + rename).
 */
export class SettingsStore {
	private cache: Settings | null = null;

	constructor(private readonly filePath: string = defaultSettingsPath()) {}

	get path(): string {
		return this.filePath;
	}

	get(): Settings {
		if (!this.cache) this.cache = this.load();
		return { ...this.cache };
	}

	/** Validates and persists a partial update. Throws `ValidationError` on bad input. */
	update(patch: SettingsPatch): Settings {
		const parsed = patchSchema.safeParse(patch ?? {});
		if (!parsed.success) {
			const issue = parsed.error.issues[0];
			const field = issue?.path.join(".") || "settings";
			throw new ValidationError(`Configuração inválida (${field}): ${issue?.message ?? ""}`);
		}
		// Only keys the caller sent (a partial schema may fill in defaults for the others).
		const defined = Object.fromEntries(
			Object.entries(parsed.data).filter(([k, v]) => v !== undefined && k in patch),
		) as SettingsPatch;
		const next: Settings = { ...this.get(), ...defined };
		this.write(next);
		this.cache = next;
		return { ...next };
	}

	/**
	 * Only the values actually persisted in `settings.json` (valid ones), without defaults —
	 * lets callers layer settings over another source (e.g. the CLI over `config.toml`).
	 */
	getExplicit(): SettingsPatch {
		const stored = this.readStored();
		const explicit: Record<string, unknown> = {};
		const shape = settingsSchema.shape;
		// Validated field by field so one bad value doesn't reset everything.
		for (const key of Object.keys(shape) as (keyof Settings)[]) {
			if (!(key in stored)) continue;
			const field = shape[key].safeParse(stored[key]);
			if (field.success) explicit[key] = field.data;
		}
		return explicit as SettingsPatch;
	}

	private readStored(): Record<string, unknown> {
		try {
			const raw: unknown = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
			if (raw && typeof raw === "object" && !Array.isArray(raw)) {
				return raw as Record<string, unknown>;
			}
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
				logger.warn(`settings: ignoring unreadable ${this.filePath}: ${(err as Error).message}`);
			}
		}
		return {};
	}

	private load(): Settings {
		return { ...defaultSettings(), ...this.getExplicit() };
	}

	private write(settings: Settings): void {
		fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
		const tmp = `${this.filePath}.${process.pid}.tmp`;
		try {
			fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
			renameWithRetry(tmp, this.filePath);
		} catch (err) {
			fs.rmSync(tmp, { force: true });
			throw err;
		}
	}
}

/** Windows antivirus/indexers briefly lock freshly written files: rename fails with these. */
const TRANSIENT_RENAME_ERRORS = new Set(["EPERM", "EBUSY", "EACCES"]);
const RENAME_ATTEMPTS = 5;
const RENAME_RETRY_MS = 40;

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** `renameSync` retried a few times on transient (Windows lock) errors. */
export function renameWithRetry(
	from: string,
	to: string,
	rename: (from: string, to: string) => void = fs.renameSync,
): void {
	for (let attempt = 1; ; attempt++) {
		try {
			rename(from, to);
			return;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code ?? "";
			if (attempt >= RENAME_ATTEMPTS || !TRANSIENT_RENAME_ERRORS.has(code)) throw err;
			sleepSync(RENAME_RETRY_MS * attempt);
		}
	}
}
