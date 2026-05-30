type CleanupFn = () => Promise<void> | void;

const cleanupFns: CleanupFn[] = [];

export function onShutdown(fn: CleanupFn): void {
  cleanupFns.push(fn);
}

export function setupSignalHandlers(): void {
  let shuttingDown = false;

  const handler = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nReceived ${signal}, shutting down gracefully...`);

    for (const fn of cleanupFns.reverse()) {
      try {
        await fn();
      } catch (err) {
        console.error("Cleanup error:", err);
      }
    }
    process.exit(0);
  };

  process.on("SIGINT", () => handler("SIGINT"));
  process.on("SIGTERM", () => handler("SIGTERM"));

  // Windows: SIGBREAK is sent on Ctrl+Break and when the console window is closed
  if (process.platform === "win32") {
    process.on("SIGBREAK", () => handler("SIGBREAK"));
  }
}
