import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts"],
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
		"fluent-ffmpeg",
		"groq-sdk",
		"ollama",
		"smol-toml",
		"uuid",
		"zod",
	],
});
