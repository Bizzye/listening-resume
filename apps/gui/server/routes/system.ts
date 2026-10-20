import path from "node:path";
import { assertDeviceId, type Settings } from "@listening-resume/core";
import type { AppContext } from "../context.js";
import { badRequest, readJson } from "../http.js";
import type { Router } from "../router.js";
import { isGroqKeyFormat, maskKey, validateGroqKey } from "../services/groq-key.js";

const CAPTURE_PROBE_TIMEOUT_MS = 3000;

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
	return new Promise((resolve) => {
		const t = setTimeout(() => resolve(fallback), ms);
		p.then(
			(v) => {
				clearTimeout(t);
				resolve(v);
			},
			() => {
				clearTimeout(t);
				resolve(fallback);
			},
		);
	});
}

/** Health, settings, Groq key and analysis models. */
export function registerSystemRoutes(router: Router, { deps }: AppContext): void {
	router.get("/health", async () => {
		const settings = deps.settings.get();
		const [ollama, ffmpeg, whisper, captureOk] = await Promise.all([
			deps.health.ollama(),
			deps.health.ffmpeg(),
			deps.health.whisper(settings.whisperModel),
			withTimeout(deps.capture.isAvailable(), CAPTURE_PROBE_TIMEOUT_MS, false),
		]);
		return {
			services: {
				ollama: { ok: ollama.ok, model: settings.analysisModel, url: ollama.url },
				groq: { configured: !!deps.groqKey.get() },
				ffmpeg,
				whisper: { ok: whisper.ok, model: settings.whisperModel },
				capture: {
					backend: deps.capture.backend,
					ok: captureOk,
					levels: deps.capture.capabilities.levels,
					liveSwitch: deps.capture.capabilities.liveSwitch,
					meter: deps.capture.capabilities.meter,
					sampleRate: deps.audio.sampleRate,
				},
			},
		};
	});

	router.get("/analysis/models", async () => {
		const { models } = await deps.health.ollama();
		return { models };
	});

	router.get("/settings", () => deps.settings.get());

	router.patch("/settings", async ({ req }) => {
		const body = await readJson<Partial<Settings>>(req);
		// Shape/enum validation is the settings schema's job; these are the security-relevant
		// extras: device ids reach the capture binary, exports must not land in a relative dir.
		for (const field of ["systemDevice", "micDevice"] as const) {
			const v = body[field];
			if (typeof v === "string") assertDeviceId(v, field);
		}
		if (typeof body.exportDir === "string") {
			const dir = body.exportDir.trim();
			if (!path.isAbsolute(dir)) throw badRequest("exportDir deve ser um caminho absoluto");
			body.exportDir = dir;
		}
		return deps.settings.update(body);
	});

	router.get("/config/groq-key", () => {
		const key = deps.groqKey.get();
		return { configured: !!key, masked: maskKey(key) };
	});

	router.post("/config/groq-key", async ({ req }) => {
		const { key } = await readJson<{ key: unknown }>(req);
		if (typeof key !== "string" || !key.trim()) throw badRequest("Informe a chave");
		const trimmed = key.trim();
		if (!isGroqKeyFormat(trimmed)) {
			throw badRequest("Formato de chave inválido (deve começar com gsk_)");
		}
		deps.groqKey.set(trimmed);
		return { ok: true, masked: maskKey(trimmed) };
	});

	router.delete("/config/groq-key", () => {
		deps.groqKey.clear();
		return { ok: true };
	});

	router.post("/config/groq-key/validate", async ({ req }) => {
		// Validates the key in the body when given (before saving), else the stored one.
		const { key } = await readJson<{ key: unknown }>(req);
		const candidate = typeof key === "string" && key.trim() ? key.trim() : deps.groqKey.get();
		return validateGroqKey(candidate, deps.fetch);
	});
}
