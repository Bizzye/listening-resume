import { execSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const guiDir = resolve(__dirname, "..");
const resourcesDir = resolve(guiDir, "src-tauri/resources");
const nodeModulesOut = resolve(resourcesDir, "node_modules");

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

// Copy native modules that can't be bundled. Versions are resolved dynamically from
// the pnpm store — hardcoding `pkg@x.y.z` silently breaks the bundle on every upgrade
// (a missing better-sqlite3 crashes the whole server on startup).
const { readdirSync } = await import("node:fs");
const pnpmModules = resolve(guiDir, "../../node_modules/.pnpm");

/** Copy a package from the pnpm store by name, matching any version. Returns true if copied. */
function copyPnpmPackage(pkg) {
  const dirs = readdirSync(pnpmModules).filter((d) =>
    d.startsWith(`${pkg.replace("/", "+")}@`),
  );
  for (const dir of dirs) {
    const candidate = resolve(pnpmModules, dir, "node_modules", pkg);
    if (existsSync(candidate)) {
      cpSync(candidate, resolve(nodeModulesOut, pkg), { recursive: true });
      return true;
    }
  }
  return false;
}

// Required native/runtime deps marked --external in the esbuild step above.
const required = ["better-sqlite3", "bindings", "file-uri-to-path", "drizzle-orm"];
const missing = [];
for (const pkg of required) {
  if (!copyPnpmPackage(pkg)) missing.push(pkg);
}
if (missing.length > 0) {
  console.error(`✗ Failed to bundle native modules: ${missing.join(", ")}`);
  console.error("  The packaged server will crash on startup. Aborting build.");
  process.exit(1);
}

console.log(`✓ Server bundled with native modules (${required.join(", ")}) to src-tauri/resources/`);
