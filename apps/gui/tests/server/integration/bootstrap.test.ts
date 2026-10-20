import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type SQLiteRepository, setLogLevel } from "@listening-resume/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildDeps } from "../../../server/bootstrap.js";

setLogLevel("error");

describe("buildDeps process runner", () => {
	let dir: string;
	let built: ReturnType<typeof buildDeps>;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "lr-boot-"));
		built = buildDeps({
			fake: true,
			dataDir: path.join(dir, "data"),
			configDir: path.join(dir, "config"),
		});
	});
	afterEach(() => {
		(built.deps.repo as SQLiteRepository).close();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("runs commands through core's run and tracks them for shutdown", async () => {
		const { deps, processes } = built;
		const pending = deps.run(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
			timeoutMs: 0,
		});
		expect(processes.size).toBe(1);
		expect(processes.killAll()).toBe(1); // what graceful shutdown does
		const result = await pending;
		expect(result.code).not.toBe(0);
		expect(processes.size).toBe(0);
	});

	it("honours the timeout and collects UTF-8 output", async () => {
		const { deps } = built;
		const ok = await deps.run(process.execPath, ["-e", "process.stdout.write('ação')"], {
			timeoutMs: 5000,
		});
		expect(ok).toMatchObject({ code: 0, stdout: "ação", timedOut: false });
		const slow = await deps.run(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
			timeoutMs: 100,
		});
		expect(slow.timedOut).toBe(true);
		expect(built.processes.size).toBe(0);
	});
});
