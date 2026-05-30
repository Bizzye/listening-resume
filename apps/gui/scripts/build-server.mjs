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

// Copy native modules that can't be bundled
const pnpmModules = resolve(guiDir, "../../node_modules/.pnpm");

// better-sqlite3
const betterSqlite = resolve(
  pnpmModules,
  "better-sqlite3@11.10.0/node_modules/better-sqlite3",
);
if (existsSync(betterSqlite)) {
  cpSync(betterSqlite, resolve(nodeModulesOut, "better-sqlite3"), {
    recursive: true,
  });
  // Also copy bindings dependency
  const bindings = resolve(pnpmModules, "bindings@1.5.0/node_modules/bindings");
  if (existsSync(bindings)) {
    cpSync(bindings, resolve(nodeModulesOut, "bindings"), { recursive: true });
  }
  const fileUri = resolve(
    pnpmModules,
    "file-uri-to-path@1.0.0/node_modules/file-uri-to-path",
  );
  if (existsSync(fileUri)) {
    cpSync(fileUri, resolve(nodeModulesOut, "file-uri-to-path"), {
      recursive: true,
    });
  }
}

// drizzle-orm
const drizzleOrm = resolve(
  pnpmModules,
  "drizzle-orm@0.44.1_better-sqlite3@11.10.0/node_modules/drizzle-orm",
);
if (existsSync(drizzleOrm)) {
  cpSync(drizzleOrm, resolve(nodeModulesOut, "drizzle-orm"), {
    recursive: true,
  });
} else {
  // Try to find with glob
  const { readdirSync } = await import("node:fs");
  const dirs = readdirSync(pnpmModules).filter((d) =>
    d.startsWith("drizzle-orm@"),
  );
  for (const dir of dirs) {
    const candidate = resolve(pnpmModules, dir, "node_modules/drizzle-orm");
    if (existsSync(candidate)) {
      cpSync(candidate, resolve(nodeModulesOut, "drizzle-orm"), {
        recursive: true,
      });
      break;
    }
  }
}

console.log("✓ Server bundled with native modules to src-tauri/resources/");
