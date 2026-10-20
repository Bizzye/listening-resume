import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SQLiteRepository } from "@listening-resume/core";
import { afterEach, describe, expect, it } from "vitest";

const guiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address() as net.AddressInfo;
			srv.close(() => resolve(port));
		});
	});
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Boots the real server entry (`server.ts`, fake capture) the way the Tauri shell does —
 * stdin piped + `LR_SHUTDOWN_ON_STDIN_EOF=1` — and closes stdin while recording.
 */
describe("graceful shutdown on stdin EOF (Tauri exit)", () => {
	let child: ChildProcess | null = null;
	let root = "";
	afterEach(async () => {
		if (child && child.exitCode === null) child.kill();
		await sleep(200); // Windows keeps the SQLite file locked briefly
		if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	});

	it("finalizes the active recording and exits 0", { timeout: 40_000 }, async () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "lr-shutdown-"));
		const port = await freePort();
		const base = `http://127.0.0.1:${port}/api`;
		let output = "";
		child = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
			cwd: guiDir,
			env: {
				...process.env,
				LR_FAKE_CAPTURE: "1",
				LR_PORT: String(port),
				LR_DATA_DIR: path.join(root, "data"),
				LR_CONFIG_DIR: path.join(root, "config"),
				LR_SHUTDOWN_ON_STDIN_EOF: "1",
			},
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		child.stdout?.on("data", (d) => {
			output += d.toString();
		});
		child.stderr?.on("data", (d) => {
			output += d.toString();
		});
		const exited = new Promise<{ code: number | null; at: number }>((resolve) =>
			child?.once("exit", (code) => resolve({ code, at: Date.now() })),
		);

		let up = false;
		for (let i = 0; i < 100 && !up; i++) {
			up = await fetch(`${base}/health`).then(
				(r) => r.ok,
				() => false,
			);
			if (!up) await sleep(200);
		}
		expect(up, output).toBe(true);

		const start = await fetch(`${base}/recording/start`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
		});
		expect(start.status).toBe(200);
		const { session } = (await start.json()) as { session: { id: string } };
		await sleep(1500); // ~1.5 s of (fake, real-time) audio still buffered in the open chunk

		const closedAt = Date.now();
		child.stdin?.end();
		const { code, at } = await exited;
		expect(code, output).toBe(0);
		expect(at - closedAt).toBeLessThan(4000); // inside the Tauri shell's 4 s grace period

		const repo = new SQLiteRepository(path.join(root, "data", "listening-resume.db"));
		try {
			const saved = repo.getSession(session.id);
			expect(saved?.status).toBe("stopped");
			expect(saved?.endedAt).toBeTruthy();
			expect(repo.getChunks(session.id).length).toBeGreaterThan(0);
		} finally {
			repo.close();
		}
	});
});
