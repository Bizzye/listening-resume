import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	EnvFileGroqKeyStore,
	maskKey,
	parseEnv,
	replaceEnvVar,
	validateGroqKey,
	writeFileAtomic,
} from "../../../server/services/groq-key.js";

const KEY = "gsk_abcdefghijklmnopqrstuvwxyz1234";

describe("groq key store", () => {
	const dirs: string[] = [];
	const tmp = () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "lr-key-"));
		dirs.push(d);
		return path.join(d, "cfg", ".env");
	};
	afterEach(() => {
		for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
	});

	it("persists the key next to other variables and removes it on clear", () => {
		const envPath = tmp();
		fs.mkdirSync(path.dirname(envPath), { recursive: true });
		fs.writeFileSync(envPath, "OTHER=1\nGROQ_API_KEY=old\n");
		const store = new EnvFileGroqKeyStore(envPath);
		expect(store.get()).toBe("old");
		store.set(KEY);
		expect(parseEnv(fs.readFileSync(envPath, "utf-8"))).toEqual({ OTHER: "1", GROQ_API_KEY: KEY });
		expect(new EnvFileGroqKeyStore(envPath).get()).toBe(KEY);
		store.clear();
		expect(store.get()).toBe("");
		expect(parseEnv(fs.readFileSync(envPath, "utf-8"))).toEqual({ OTHER: "1" });
	});

	it("rewrites atomically, keeping comments, blank lines, other vars and CRLF endings", () => {
		const envPath = tmp();
		fs.mkdirSync(path.dirname(envPath), { recursive: true });
		fs.writeFileSync(envPath, "# config\r\nOTHER=1\r\n\r\nexport GROQ_API_KEY=old\r\nLAST=2\r\n");
		new EnvFileGroqKeyStore(envPath).set(KEY);
		expect(fs.readFileSync(envPath, "utf-8")).toBe(
			`# config\r\nOTHER=1\r\n\r\nLAST=2\r\nGROQ_API_KEY=${KEY}\r\n`,
		);
		// no temp files left behind
		expect(fs.readdirSync(path.dirname(envPath))).toEqual([".env"]);
	});

	it("replaceEnvVar adds, replaces and removes a variable", () => {
		expect(replaceEnvVar("", "K", "v")).toBe("K=v\n");
		expect(replaceEnvVar("A=1\nK=old\n", "K", "new")).toBe("A=1\nK=new\n");
		expect(replaceEnvVar("A=1\n K = old\n", "K", "")).toBe("A=1\n");
		expect(replaceEnvVar("K=1\n", "K", "")).toBe("");
		expect(replaceEnvVar("KEY2=1\n", "K", "")).toBe("KEY2=1\n");
	});

	it("writeFileAtomic replaces the target and cleans up its temp file", () => {
		const file = tmp();
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "old");
		writeFileAtomic(file, "new");
		expect(fs.readFileSync(file, "utf-8")).toBe("new");
		expect(fs.readdirSync(path.dirname(file))).toEqual([".env"]);
	});

	it("prefers the saved key over the environment fallback", () => {
		const envPath = tmp();
		expect(new EnvFileGroqKeyStore(envPath, "from-env").get()).toBe("from-env");
		new EnvFileGroqKeyStore(envPath).set(KEY);
		expect(new EnvFileGroqKeyStore(envPath, "from-env").get()).toBe(KEY);
	});

	it("parses quoted values and ignores comments", () => {
		expect(parseEnv("# c\nA='x'\nB=\"y\"\n\nbad line\n")).toEqual({ A: "x", B: "y" });
	});

	it("masks keys", () => {
		expect(maskKey(KEY)).toBe("gsk_********...1234");
		expect(maskKey("")).toBeNull();
	});
});

describe("validateGroqKey", () => {
	const fetchStatus = (status: number) => async () => new Response("{}", { status });

	it("accepts a key the API accepts", async () => {
		expect(await validateGroqKey(KEY, fetchStatus(200))).toEqual({ valid: true });
	});
	it("reports rejected keys, bad formats and network errors", async () => {
		expect((await validateGroqKey(KEY, fetchStatus(401))).valid).toBe(false);
		expect((await validateGroqKey("nope", fetchStatus(200))).error).toMatch(/gsk_/);
		expect((await validateGroqKey("", fetchStatus(200))).valid).toBe(false);
		const offline = async () => {
			throw new TypeError("fetch failed");
		};
		expect(await validateGroqKey(KEY, offline)).toEqual({
			valid: false,
			error: expect.stringMatching(/conexão/),
		});
	});
	it("sends the key as a bearer token to the models endpoint", async () => {
		let seen: { url: string; auth: string | null } | null = null;
		await validateGroqKey(KEY, async (url, init) => {
			seen = { url, auth: new Headers(init?.headers).get("authorization") };
			return new Response("{}");
		});
		expect(seen).toEqual({ url: "https://api.groq.com/openai/v1/models", auth: `Bearer ${KEY}` });
	});
});
