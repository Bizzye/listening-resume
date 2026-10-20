import fs from "node:fs";
import path from "node:path";

export interface GroqKeyStore {
	/** Current key, or "" when not configured. */
	get(): string;
	set(key: string): void;
	clear(): void;
}

const KEY_VAR = "GROQ_API_KEY";

export const GROQ_KEY_RE = /^gsk_[a-zA-Z0-9]{20,}$/;

export function isGroqKeyFormat(key: string): boolean {
	return GROQ_KEY_RE.test(key);
}

export function maskKey(key: string): string | null {
	if (!key) return null;
	return `gsk_${"*".repeat(8)}...${key.slice(-4)}`;
}

function unquote(v: string): string {
	if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
		return v.slice(1, -1);
	}
	return v;
}

/** Parse `KEY=value` lines (comments/blank lines ignored, surrounding quotes stripped). */
export function parseEnv(content: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of content.split(/\r?\n/)) {
		const t = line.trim();
		if (!t || t.startsWith("#")) continue;
		const eq = t.indexOf("=");
		if (eq === -1) continue;
		out[t.slice(0, eq).trim()] = unquote(t.slice(eq + 1).trim());
	}
	return out;
}

const varLine = (name: string) => new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`);

/**
 * Replace (or append, or remove when `value` is empty) `name=value` in `.env` content, keeping
 * every other line (comments and blank lines included) and the file's line endings.
 */
export function replaceEnvVar(content: string, name: string, value: string): string {
	const eol = content.includes("\r\n") ? "\r\n" : "\n";
	const re = varLine(name);
	const lines = content ? content.split(/\r?\n/) : [];
	if (lines.length && lines.at(-1) === "") lines.pop(); // trailing newline
	const kept = lines.filter((l) => !re.test(l));
	if (value) kept.push(`${name}=${value}`);
	return kept.length ? `${kept.join(eol)}${eol}` : "";
}

const RENAME_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * tmp + rename. On Windows, rename over a file another process (antivirus, indexer, an editor)
 * has open fails transiently with EPERM/EACCES/EBUSY — retry briefly before giving up.
 */
export function writeFileAtomic(file: string, data: string, mode = 0o600): void {
	const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
	fs.writeFileSync(tmp, data, { mode });
	for (let attempt = 0; ; attempt++) {
		try {
			fs.renameSync(tmp, file);
			return;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code ?? "";
			if (!RENAME_RETRY_CODES.has(code) || attempt >= 9) {
				fs.rmSync(tmp, { force: true });
				throw err;
			}
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
		}
	}
}

/**
 * Groq key persisted as `GROQ_API_KEY=` in the config `.env`
 * (`%APPDATA%\listening-resume\.env` / `~/.config/listening-resume/.env`), owner-only perms.
 * `envFallback` (e.g. process.env / workspace .env) is used when the file has no key, so a key
 * saved through the GUI always wins.
 */
export class EnvFileGroqKeyStore implements GroqKeyStore {
	private key: string;

	constructor(
		private readonly envPath: string,
		envFallback = "",
	) {
		this.key = this.readFromFile() || envFallback;
		this.tightenPermissions();
	}

	get(): string {
		return this.key;
	}

	set(key: string): void {
		this.key = key;
		this.writeKey(key);
	}

	clear(): void {
		this.key = "";
		if (fs.existsSync(this.envPath)) this.writeKey("");
	}

	private readFromFile(): string {
		try {
			if (!fs.existsSync(this.envPath)) return "";
			return parseEnv(fs.readFileSync(this.envPath, "utf-8"))[KEY_VAR] ?? "";
		} catch {
			return "";
		}
	}

	/**
	 * Rewrite the file with only the `GROQ_API_KEY` line changed (other vars, comments and blank
	 * lines are kept), atomically: write a temp file in the same dir, then rename over the
	 * original — a crash never leaves a truncated `.env`.
	 */
	private writeKey(key: string): void {
		const dir = path.dirname(this.envPath);
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const existing = fs.existsSync(this.envPath) ? fs.readFileSync(this.envPath, "utf-8") : "";
		writeFileAtomic(this.envPath, replaceEnvVar(existing, KEY_VAR, key));
		this.tightenPermissions();
	}

	/**
	 * POSIX: 0600 file / 0700 dir. Windows: chmod is a no-op — the file inherits the ACL of
	 * `%APPDATA%\listening-resume`, which by default grants access only to the user, SYSTEM and
	 * Administrators. We deliberately do not rewrite ACLs (icacls) here.
	 */
	private tightenPermissions(): void {
		if (process.platform === "win32") return;
		try {
			if (fs.existsSync(this.envPath)) fs.chmodSync(this.envPath, 0o600);
			fs.chmodSync(path.dirname(this.envPath), 0o700);
		} catch {
			// non-critical
		}
	}
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const GROQ_MODELS_URL = "https://api.groq.com/openai/v1/models";

/** Check a key against Groq's models endpoint. Never throws. */
export async function validateGroqKey(
	key: string,
	fetchImpl: FetchLike,
	timeoutMs = 8000,
): Promise<{ valid: boolean; error?: string }> {
	if (!key) return { valid: false, error: "Nenhuma chave configurada" };
	if (!isGroqKeyFormat(key))
		return { valid: false, error: "Formato inválido (deve começar com gsk_)" };
	try {
		const res = await fetchImpl(GROQ_MODELS_URL, {
			headers: { Authorization: `Bearer ${key}` },
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (res.ok) return { valid: true };
		if (res.status === 401 || res.status === 403) {
			return { valid: false, error: "Chave recusada pela Groq" };
		}
		return { valid: false, error: `Groq respondeu HTTP ${res.status}` };
	} catch {
		return { valid: false, error: "Não foi possível contatar a Groq (sem conexão?)" };
	}
}
