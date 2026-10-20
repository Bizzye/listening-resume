// Listening Resume API server entry (dev: `pnpm dev:server`; packaged: esbuild → server-bundle.mjs).
// All logic lives in ./server — see server/bootstrap.ts for env vars (LR_PORT, LR_FAKE_CAPTURE,
// LR_DATA_DIR, LR_CONFIG_DIR, LR_HOST, LR_ALLOWED_ORIGINS, LR_SHUTDOWN_ON_STDIN_EOF,
// LR_IMPORT_TIMEOUT_MS).
import { DEFAULT_PORT, installShutdownHandlers, startServer } from "./server/bootstrap.js";

startServer().then(installShutdownHandlers, (err: NodeJS.ErrnoException) => {
	if (err.code === "EADDRINUSE") {
		const port = process.env.LR_PORT || process.env.PORT || DEFAULT_PORT;
		console.error(`Port ${port} already in use. Kill the other process and retry.`);
	} else {
		console.error(`Failed to start API server: ${err.stack ?? err.message}`);
	}
	process.exit(1);
});
