import { defineConfig } from "tsup";

export default defineConfig({
	// `shared` is the browser-safe subpath (`@listening-resume/core/shared`).
	entry: ["src/index.ts", "src/shared.ts"],
	format: ["esm"],
	target: "node20",
	outDir: "dist",
	clean: true,
	dts: true,
	sourcemap: true,
	shims: true,
	external: [
		"better-sqlite3",
		"chalk",
		"dotenv",
		"drizzle-orm",
		"groq-sdk",
		"ollama",
		"smol-toml",
		"zod",
	],
});
