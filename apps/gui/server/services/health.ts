import fs from "node:fs";
import type { ProcessRunner } from "@listening-resume/core";
import type { FetchLike } from "./groq-key.js";

export interface HealthCheckers {
	/** Ollama reachability + installed model names (`/api/tags`). Never throws. */
	ollama(): Promise<{ ok: boolean; url: string; models: string[] }>;
	/** `ffmpeg -version`. Never throws. */
	ffmpeg(): Promise<{ ok: boolean; version: string | null }>;
	/** whisper.cpp binary + model file present. Never throws. */
	whisper(model: string): Promise<{ ok: boolean }>;
}

/** Parse `ffmpeg version 7.1-full_build-www.gyan.dev Copyright…` → `"7.1-full_build-www.gyan.dev"`. */
export function parseFfmpegVersion(output: string): string | null {
	const m = /ffmpeg version (\S+)/i.exec(output);
	return m?.[1] ?? null;
}

export interface HealthOptions {
	fetch: FetchLike;
	run: ProcessRunner;
	ollamaUrl: string;
	whisperBin: string;
	whisperModelPath(model: string): string;
	timeoutMs?: number;
}

export function createHealthCheckers(opts: HealthOptions): HealthCheckers {
	const timeoutMs = opts.timeoutMs ?? 2000;
	let ffmpegCache: { ok: true; version: string | null } | null = null;

	return {
		async ollama() {
			const url = opts.ollamaUrl.replace(/\/+$/, "");
			try {
				const res = await opts.fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
				if (!res.ok) return { ok: false, url, models: [] };
				const body = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
				const models = (body.models ?? [])
					.map((m) => m.name ?? m.model ?? "")
					.filter((n): n is string => !!n);
				return { ok: true, url, models };
			} catch {
				return { ok: false, url, models: [] };
			}
		},

		async ffmpeg() {
			if (ffmpegCache) return ffmpegCache;
			try {
				const r = await opts.run("ffmpeg", ["-hide_banner", "-version"], {
					timeoutMs: timeoutMs * 2,
				});
				if (r.code !== 0) return { ok: false, version: null };
				ffmpegCache = { ok: true, version: parseFfmpegVersion(r.stdout + r.stderr) };
				return ffmpegCache;
			} catch {
				return { ok: false, version: null };
			}
		},

		async whisper(model) {
			if (!fs.existsSync(opts.whisperModelPath(model))) return { ok: false };
			try {
				await opts.run(opts.whisperBin, ["--help"], { timeoutMs });
				return { ok: true };
			} catch {
				return { ok: false };
			}
		},
	};
}
