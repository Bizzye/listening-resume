// Make the packaged better-sqlite3 match the BUNDLED node's ABI.
//
// pnpm installs better-sqlite3 for whatever node ran `pnpm install` (e.g. Node 24 → ABI 137),
// but the app ships its own node.exe (download-deps-win.ps1, e.g. 22.16.0 → ABI 127). A mismatch
// crashes the packaged server on boot ("Loading devices…" forever). This swaps the binary in the
// COPIED module (resources/node_modules — never the pnpm store) for the matching prebuild.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/** True when `nodeBin` can load the better-sqlite3 inside `nodeModules`. */
export function canLoadBetterSqlite(nodeBin, nodeModules) {
	const r = spawnSync(
		nodeBin,
		[
			"-e",
			`new (require(${JSON.stringify(resolve(nodeModules, "better-sqlite3"))}))(":memory:").close()`,
		],
		{ encoding: "utf-8", windowsHide: true },
	);
	return {
		ok: r.status === 0,
		error: (r.stderr || "").trim().split(/\r?\n/).slice(0, 4).join("\n"),
	};
}

function findPrebuildInstall(pnpmModules) {
	const dir = readdirSync(pnpmModules).find((d) => d.startsWith("prebuild-install@"));
	const bin = dir && resolve(pnpmModules, dir, "node_modules", "prebuild-install", "bin.js");
	return bin && existsSync(bin) ? bin : null;
}

/**
 * Ensure the copied better-sqlite3 loads under `nodeBin`; downloads the matching prebuild when it
 * doesn't. Returns true when the module is usable. Never touches the pnpm store.
 */
export function ensureNativeAbi({ nodeBin, nodeModules, pnpmModules }) {
	if (!existsSync(nodeBin) || !existsSync(resolve(nodeModules, "better-sqlite3"))) return true;
	const first = canLoadBetterSqlite(nodeBin, nodeModules);
	if (first.ok) return true;

	const version = execFileSync(nodeBin, ["--version"], { encoding: "utf-8" })
		.trim()
		.replace(/^v/, "");
	const prebuild = findPrebuildInstall(pnpmModules);
	if (!prebuild) {
		console.error(
			`✗ better-sqlite3 ABI mismatch for node ${version} and prebuild-install not found:\n${first.error}`,
		);
		return false;
	}
	console.log(
		`↻ better-sqlite3 was built for another node ABI — fetching the prebuild for node ${version}…`,
	);
	const r = spawnSync(
		process.execPath,
		[
			prebuild,
			"--runtime",
			"node",
			"--target",
			version,
			"--arch",
			process.arch,
			"--platform",
			process.platform,
		],
		{ cwd: resolve(nodeModules, "better-sqlite3"), stdio: "inherit", windowsHide: true },
	);
	const after = canLoadBetterSqlite(nodeBin, nodeModules);
	if (r.status !== 0 || !after.ok) {
		console.error(`✗ could not obtain a better-sqlite3 build for node ${version}:\n${after.error}`);
		return false;
	}
	console.log(`✓ better-sqlite3 now matches the bundled node ${version}`);
	return true;
}
