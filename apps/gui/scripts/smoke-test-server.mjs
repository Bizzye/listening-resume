// Smoke test for the packaged server bundle.
//
// Boots resources/server-bundle.mjs with the bundled node + node_modules exactly
// as the installed app does, then probes GET /api/devices (+ the DB-backed routes). Catches the
// class of bug where a native module (e.g. better-sqlite3) is missing/ABI-mismatched and the
// server crashes on startup — which otherwise only surfaces in the installed .exe.
//
// Port: `LR_PORT`/`PORT` if set, otherwise a free ephemeral port — so the smoke test never
// collides with an installed app (or `pnpm dev`) holding 3456. Data/config dirs are throwaway
// temp dirs (LR_DATA_DIR / LR_CONFIG_DIR) so the user's database is never touched.
//
// Exits non-zero (failing the build) if the server doesn't come up.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureNativeAbi } from "./native-abi.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const guiDir = resolve(__dirname, "..");
const resourcesDir = resolve(guiDir, "src-tauri/resources");
const serverBundle = resolve(resourcesDir, "server-bundle.mjs");
const nodeModules = resolve(resourcesDir, "node_modules");

if (!existsSync(serverBundle)) {
	console.error(`✗ server bundle not found: ${serverBundle} (run build:server first)`);
	process.exit(1);
}

// Prefer the bundled node (what the installed app runs); fall back to the current node.
const isWin = process.platform === "win32";
const bundledNode = resolve(resourcesDir, "bin", isWin ? "node.exe" : "node");
const nodeBin = existsSync(bundledNode) ? bundledNode : process.execPath;

// download-deps-win.ps1 runs after build:server, so re-check the native ABI against the node
// we're about to use (no-op when it already matches).
const pnpmModules = resolve(guiDir, "../../node_modules/.pnpm");
if (!ensureNativeAbi({ nodeBin, nodeModules, pnpmModules })) process.exit(1);

function freePort() {
	return new Promise((res, rej) => {
		const srv = createServer();
		srv.once("error", rej);
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address();
			srv.close(() => res(port));
		});
	});
}

const PORT = Number(process.env.LR_PORT || process.env.PORT || (await freePort()));
const BASE = `http://localhost:${PORT}/api`;
const tmpRoot = mkdtempSync(join(tmpdir(), "lr-smoke-"));

console.log(`Smoke test: ${nodeBin}\n  -> ${serverBundle} (port ${PORT})`);

let stderr = "";
const server = spawn(nodeBin, [serverBundle], {
	env: {
		...process.env,
		NODE_PATH: nodeModules,
		LR_PORT: String(PORT),
		LR_DATA_DIR: join(tmpRoot, "data"),
		LR_CONFIG_DIR: join(tmpRoot, "config"),
	},
	stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", () => {});
server.stderr.on("data", (d) => {
	stderr += d.toString();
});

let exited = false;
let exitInfo = "";
server.on("exit", (code, signal) => {
	exited = true;
	exitInfo = `code=${code} signal=${signal}`;
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function finish(code, msg) {
	if (msg) {
		console.error(`✗ ${msg}`);
		if (stderr.trim()) console.error(`--- server stderr ---\n${stderr.trim()}`);
	}
	try {
		server.kill();
	} catch {}
	await sleep(300); // Windows keeps the SQLite file locked briefly after kill
	rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	process.exit(code);
}

// Poll for up to ~15s.
let res = null;
for (let attempt = 0; attempt < 30 && !res; attempt++) {
	if (exited) await finish(1, `server crashed on startup (${exitInfo})`);
	await sleep(500);
	res = await fetch(`${BASE}/devices`).catch(() => null); // null = not up yet
}
if (!res) await finish(1, "server did not respond within 15s");
if (res.status !== 200) {
	await finish(1, `GET /api/devices returned HTTP ${res.status}: ${await res.text()}`);
}
const body = await res.json();
if (!Array.isArray(body.devices)) await finish(1, "response missing 'devices' array");
console.log(`✓ server booted and listed ${body.devices.length} device(s)`);

// DB-backed routes prove the native module (better-sqlite3) loaded with the right ABI.
for (const route of ["/sessions", "/settings", "/templates"]) {
	const r = await fetch(`${BASE}${route}`);
	if (r.status !== 200) await finish(1, `GET /api${route} returned HTTP ${r.status}`);
}
console.log("✓ sessions, settings and templates endpoints OK");
await finish(0);
