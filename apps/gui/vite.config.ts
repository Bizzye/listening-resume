import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react()],
	clearScreen: false,
	server: {
		port: 1420,
		strictPort: true,
		proxy: {
			"/api": {
				target: "http://localhost:3456",
				changeOrigin: true,
			},
		},
	},
});
