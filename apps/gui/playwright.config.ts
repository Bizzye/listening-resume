import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

/**
 * E2E suites (all share one backend on :3456 + Vite on :1420, so they run serially):
 *
 *   playwright test                      → default user-journey suite (hermetic fake backend)
 *   playwright test --grep @screens      → regenerate docs/images/*.png (fake backend)
 *   playwright test --grep @hardware     → REAL capture on this machine (wasapi-capture.exe)
 *
 * `E2E_SUITE=screens|hardware` selects the same suites without --grep. `E2E_REUSE=1` reuses
 * servers that are already running (faster local iteration; state is reset per test anyway).
 */
type Suite = "default" | "screens" | "hardware";

function detectSuite(): Suite {
	const fromEnv = process.env.E2E_SUITE;
	if (fromEnv === "screens" || fromEnv === "hardware") return fromEnv;
	const args = process.argv.join(" ");
	if (args.includes("@hardware")) return "hardware";
	if (args.includes("@screens")) return "screens";
	return "default";
}

// Computed once in the runner process and inherited by the workers (whose argv differs).
process.env.E2E_SUITE ??= detectSuite();
const suite = process.env.E2E_SUITE as Suite;
const hardware = suite === "hardware";
const reuse = process.env.E2E_REUSE === "1";
const outRoot = path.join(os.tmpdir(), "lr-e2e", "playwright");

export default defineConfig({
	testDir: "./e2e",
	outputDir: path.join(outRoot, "test-results"),
	fullyParallel: false,
	workers: 1,
	retries: process.env.CI ? 1 : 0,
	timeout: hardware ? 120_000 : 60_000,
	expect: { timeout: 10_000 },
	reporter: [["list"], ["html", { open: "never", outputFolder: path.join(outRoot, "report") }]],
	grep: suite === "default" ? undefined : new RegExp(`@${suite}`),
	grepInvert: suite === "default" ? /@screens|@hardware/ : undefined,
	use: {
		baseURL: "http://localhost:1420",
		viewport: { width: 1440, height: 900 },
		deviceScaleFactor: suite === "default" ? 1 : 2, // crisp docs/images PNGs
		trace: "on-first-retry",
		locale: "pt-BR",
		timezoneId: "America/Sao_Paulo",
	},
	projects: [{ name: "chromium", use: { browserName: "chromium" } }],
	webServer: [
		{
			command: hardware
				? "node e2e/support/start-server.mjs --real"
				: suite === "screens"
					? // Long imported sessions: 2-min chunks, quick fake jobs.
						"node e2e/support/start-server.mjs --chunk-seconds 120 --delay 150"
					: "node e2e/support/start-server.mjs",
			url: "http://localhost:3456/api/health",
			reuseExistingServer: reuse,
			timeout: 60_000,
			stdout: "pipe",
			stderr: "pipe",
		},
		{
			command: "node node_modules/vite/bin/vite.js --port 1420 --strictPort",
			url: "http://localhost:1420",
			reuseExistingServer: reuse,
			timeout: 60_000,
		},
	],
});
