import os from "node:os";
import path from "node:path";

export const E2E_API_PORT = 3456;
export const E2E_UI_PORT = 1420;

/** Per-mode scratch root for the e2e backend (wiped on each server start). */
export function e2eRoot(mode) {
	return path.join(os.tmpdir(), "lr-e2e", mode);
}
