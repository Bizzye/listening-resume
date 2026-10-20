import { useStore } from "../store";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let inflight: Promise<void> | null = null;

/**
 * Loads everything the app needs. The API server is spawned by the Tauri shell at the same
 * time as the webview, so the first requests may fail — retry settings until it answers.
 * Idempotent while running (StrictMode mounts effects twice in dev).
 */
export function bootApp(opts: { retries?: number; delayMs?: number } = {}): Promise<void> {
	inflight ??= runBoot(opts).finally(() => {
		inflight = null;
	});
	return inflight;
}

async function runBoot({ retries = 30, delayMs = 500 }: { retries?: number; delayMs?: number }) {
	const s = useStore.getState();
	s.setBoot("loading");
	for (let attempt = 0; ; attempt++) {
		try {
			await s.loadSettings();
			break;
		} catch {
			if (attempt >= retries) {
				s.setBoot("error");
				return;
			}
			await sleep(delayMs);
		}
	}
	await Promise.all([
		s.syncRecording(),
		s.loadSessions(),
		s.loadTemplates(),
		s.loadHealth(),
		s.loadGroqKey(),
	]);
	s.setBoot("ready");
	void s.loadDevices();
}
