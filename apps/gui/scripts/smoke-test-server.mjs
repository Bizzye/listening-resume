// Smoke test for the packaged server bundle.
//
// Boots resources/server-bundle.mjs with the bundled node + node_modules exactly
// as the installed app does, then probes GET /api/devices. Catches the class of bug
// where a native module (e.g. better-sqlite3) is missing/ABI-mismatched and the
// server crashes on startup — which otherwise only surfaces in the installed .exe.
//
// Exits non-zero (failing the build) if the server doesn't come up.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

const PORT = 3456;
const URL = `http://localhost:${PORT}/api/devices`;

console.log(`Smoke test: ${nodeBin}\n  -> ${serverBundle}`);

let stderr = "";
const server = spawn(nodeBin, [serverBundle], {
  env: { ...process.env, NODE_PATH: nodeModules },
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

function fail(msg) {
  console.error(`✗ ${msg}`);
  if (stderr.trim()) console.error(`--- server stderr ---\n${stderr.trim()}`);
  try {
    server.kill();
  } catch {}
  process.exit(1);
}

// Poll for up to ~15s.
for (let attempt = 0; attempt < 30; attempt++) {
  if (exited) fail(`server crashed on startup (${exitInfo})`);
  await sleep(500);
  try {
    const res = await fetch(URL);
    if (res.status !== 200) fail(`GET /api/devices returned HTTP ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body.devices)) fail("response missing 'devices' array");
    console.log(`✓ server booted and listed ${body.devices.length} device(s)`);
    server.kill();
    process.exit(0);
  } catch {
    // not up yet — keep polling
  }
}

fail("server did not respond within 15s");
