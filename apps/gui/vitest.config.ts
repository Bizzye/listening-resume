import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [react()],
	test: {
		projects: [
			{
				extends: true,
				test: {
					name: "server",
					environment: "node",
					include: ["tests/server/**/*.test.ts"],
				},
			},
			{
				extends: true,
				test: {
					name: "ui",
					environment: "jsdom",
					include: ["tests/ui/**/*.test.{ts,tsx}"],
					setupFiles: ["tests/ui/setup.ts"],
				},
			},
		],
	},
});
