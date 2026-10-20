import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Session } from "../src/domain/models.js";
import { createWav, floatToPcm16 } from "../src/utils/wav.js";

/** Fresh temp directory; call the returned cleanup in afterEach. */
export function makeTempDir(prefix = "lr-test-"): { dir: string; cleanup: () => void } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

let counter = 0;

export function makeSession(overrides: Partial<Session> = {}): Session {
	counter++;
	const now = new Date(Date.UTC(2026, 9, 11, 12, 0, counter)).toISOString();
	return {
		id: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
		title: `Sessão ${counter}`,
		status: "stopped",
		startedAt: now,
		endedAt: now,
		audioSource: "Áudio do sistema",
		language: "auto",
		createdAt: now,
		exportDir: null,
		lastError: null,
		...overrides,
	};
}

/** Writes a 440 Hz 16-bit PCM WAV of `seconds`. */
export function writeToneWav(
	file: string,
	seconds: number,
	sampleRate = 16000,
	channels = 1,
): string {
	const frames = Math.round(seconds * sampleRate);
	const samples = new Float32Array(frames * channels);
	for (let i = 0; i < frames; i++) {
		const v = 0.5 * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
		for (let c = 0; c < channels; c++) samples[i * channels + c] = v;
	}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, createWav(floatToPcm16(samples), { sampleRate, channels }));
	return file;
}

/**
 * Sets every file under `dir` (recursively) to have been modified `agoMs` ago — e.g. so boot
 * reconcile treats a just-written recording as interrupted rather than live in another process.
 */
export function backdateFiles(dir: string, agoMs = 60_000): void {
	if (!fs.existsSync(dir)) return;
	const when = new Date(Date.now() - agoMs);
	for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
		if (entry.isFile()) fs.utimesSync(path.join(entry.parentPath, entry.name), when, when);
	}
}
