// Launches the API server for Playwright with a FRESH, isolated data + config dir per run.
//
//   node e2e/support/start-server.mjs            → hermetic fake backend (LR_FAKE_CAPTURE=1)
//   node e2e/support/start-server.mjs --real     → real capture (wasapi-capture.exe on Windows)
//   --chunk-seconds <n>  fake chunk length (default 5 → many chunks/segments from short recordings)
//   --delay <ms>         fake transcription/analysis latency per call (default 600)
//
// The dirs live under <os tmp>/lr-e2e/<mode>/ and are wiped on every start, so each run begins
// with an empty database and a first-run settings.json (onboarding not done).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { E2E_API_PORT, e2eRoot } from "./paths.mjs";

const real = process.argv.includes("--real");
const arg = (name, fallback) => {
	const i = process.argv.indexOf(name);
	return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const chunkSeconds = Number(arg("--chunk-seconds", "5"));
const guiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const root = e2eRoot(real ? "real" : "fake");
const dataDir = path.join(root, "data");
const configDir = path.join(root, "config");

fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(configDir, { recursive: true });
if (!real) {
	// Short chunks → several chunks (and transcript segments) from a few seconds of fake audio.
	fs.writeFileSync(
		path.join(configDir, "config.toml"),
		`[audio]\nchunk_seconds = ${chunkSeconds}\n`,
	);
}

const env = {
	...process.env,
	LR_PORT: String(E2E_API_PORT),
	LR_DATA_DIR: dataDir,
	LR_CONFIG_DIR: configDir,
};
if (real) delete env.LR_FAKE_CAPTURE;
else {
	env.LR_FAKE_CAPTURE = "1";
	env.LR_FAKE_DELAY_MS = arg("--delay", env.LR_FAKE_DELAY_MS ?? "600");
}

console.log(`[e2e] starting ${real ? "REAL" : "fake"} API server (data: ${root})`);
const child = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
	cwd: guiDir,
	env,
	stdio: "inherit",
});

const stop = () => {
	if (!child.killed) child.kill();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("exit", stop);
child.on("exit", (code) => process.exit(code ?? 0));
