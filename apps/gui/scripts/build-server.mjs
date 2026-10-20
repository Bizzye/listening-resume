// Bundle the API server (server.ts + server/** + @listening-resume/core + docx/pdf-lib…) into
// src-tauri/resources/server-bundle.mjs and copy the modules esbuild can't bundle (native
// better-sqlite3 and its loaders, drizzle-orm) to src-tauri/resources/node_modules.
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureNativeAbi } from "./native-abi.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const guiDir = resolve(__dirname, "..");
const resourcesDir = resolve(guiDir, "src-tauri/resources");
const nodeModulesOut = resolve(resourcesDir, "node_modules");
const pnpmModules = resolve(guiDir, "../../node_modules/.pnpm");

// Clean previous build
if (existsSync(nodeModulesOut)) {
	rmSync(nodeModulesOut, { recursive: true });
}
mkdirSync(nodeModulesOut, { recursive: true });

// Bundle server with native modules marked as external
execSync(
	`esbuild server.ts --bundle --platform=node --target=node20 --format=esm --outfile=src-tauri/resources/server-bundle.mjs --external:better-sqlite3 --external:drizzle-orm --banner:js="import { createRequire } from 'module'; const require = createRequire(import.meta.url);"`,
	{ cwd: guiDir, stdio: "inherit" },
);

// Copy native modules that can't be bundled. Each package is resolved the way node would
// resolve it from its dependent (core → better-sqlite3 → bindings → file-uri-to-path; core →
// drizzle-orm), then realpath'd into the pnpm store — so the copied version is exactly the one
// the dev server runs, never "the first matching store dir" (several versions can coexist).

const corePackageJson = resolve(guiDir, "../../packages/core/package.json");

/** Directory of `pkg` as resolved from the package whose package.json is `fromPackageJson`. */
function resolvePackageDir(fromPackageJson, pkg) {
	const req = createRequire(fromPackageJson);
	try {
		return dirname(realpathSync(req.resolve(`${pkg}/package.json`)));
	} catch {
		// `exports` may hide package.json — walk node's lookup paths instead.
		for (const base of req.resolve.paths(pkg) ?? []) {
			const candidate = join(base, pkg, "package.json");
			if (existsSync(candidate)) return dirname(realpathSync(candidate));
		}
		return null;
	}
}

// [package, resolved-from] — dependents must come before their dependencies.
const required = [
	["better-sqlite3", "core"],
	["bindings", "better-sqlite3"],
	["file-uri-to-path", "bindings"],
	["drizzle-orm", "core"],
];
const resolved = { core: dirname(corePackageJson) };
const missing = [];
for (const [pkg, from] of required) {
	const parent = resolved[from];
	const dir = parent ? resolvePackageDir(join(parent, "package.json"), pkg) : null;
	if (!dir) {
		missing.push(pkg);
		continue;
	}
	resolved[pkg] = dir;
	cpSync(dir, resolve(nodeModulesOut, pkg), { recursive: true, dereference: true });
}
if (missing.length > 0) {
	console.error(`✗ Failed to bundle native modules: ${missing.join(", ")}`);
	console.error("  The packaged server will crash on startup. Aborting build.");
	process.exit(1);
}

// When the bundled node is already present (download-deps-win.ps1), make the copied
// better-sqlite3 match its ABI. (smoke:server re-checks this after download-deps runs.)
const bundledNode = resolve(
	resourcesDir,
	"bin",
	process.platform === "win32" ? "node.exe" : "node",
);
if (!ensureNativeAbi({ nodeBin: bundledNode, nodeModules: nodeModulesOut, pnpmModules })) {
	process.exit(1);
}

console.log(
	`✓ Server bundled with native modules (${required.map(([p]) => p).join(", ")}) to src-tauri/resources/`,
);
