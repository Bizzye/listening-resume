import {
	type CaptureDevices,
	type CaptureSource,
	SYSTEM_DEFAULT_DEVICE,
} from "@listening-resume/core";
import type { AppContext } from "../context.js";
import { badRequest, conflict, readJson, toHttpError } from "../http.js";
import type { Router } from "../router.js";
import { assertTranscriberAvailable } from "../services/jobs.js";
import { normalizeMic, normalizeSystem } from "./audio.js";

const NOT_RECORDING = "Nenhuma gravação em andamento";

/** Start/stop/discard, live mute and live device switching. */
export function registerRecordingRoutes(router: Router, ctx: AppContext): void {
	const { deps, jobs } = ctx;
	const requireActive = () => {
		const active = deps.recording.getActive();
		if (!active) throw conflict(NOT_RECORDING);
		return active;
	};

	router.post("/recording/start", async ({ req }) => {
		const body = await readJson<{ device: unknown; micDevice: unknown; title: unknown }>(req);
		if (deps.recording.getActive()) throw conflict("Já existe uma gravação em andamento");
		const settings = deps.settings.get();
		const devices: CaptureDevices = {
			system:
				body.device === undefined || body.device === null
					? settings.systemDevice || SYSTEM_DEFAULT_DEVICE
					: normalizeSystem(body.device),
			mic: body.micDevice === undefined ? settings.micDevice : normalizeMic(body.micDevice),
		};
		const title =
			typeof body.title === "string" && body.title.trim() ? body.title.trim() : undefined;
		const session = await deps.recording.start({ devices, title });
		const active = deps.recording.getActive();
		return {
			session,
			startTime: active?.startedAt ?? Date.parse(session.startedAt ?? session.createdAt),
			devices: active?.devices ?? null,
		};
	});

	/** Stop + auto-transcribe once; concurrent stop requests share the same outcome. */
	let stopping: Promise<{ sessionId: string; chunks: number }> | null = null;
	const stopOnce = async () => {
		const { session, chunks } = await deps.recording.stop();
		const settings = deps.settings.get();
		if (settings.autoTranscribe && chunks > 0) {
			try {
				assertTranscriberAvailable(deps.transcription, settings);
				jobs.transcribe(session.id);
			} catch (err) {
				const { status, message } = toHttpError(err);
				deps.logger.warn(`[auto-transcribe] not started: ${message}`);
				// A conflict means a transcription is already running (e.g. a concurrent stop
				// started it) — not a failure. Real failures (e.g. Groq key missing) are
				// surfaced on the session; the recording itself succeeded.
				if (status !== 409) deps.repo.updateSession(session.id, { lastError: message });
			}
		}
		return { sessionId: session.id, chunks };
	};

	router.post("/recording/stop", async () => {
		if (!stopping) {
			requireActive();
			stopping = stopOnce().finally(() => {
				stopping = null;
			});
		}
		const { sessionId, chunks } = await stopping;
		const session = deps.repo.getSession(sessionId);
		if (!session) throw conflict(NOT_RECORDING);
		return { session, chunks };
	});

	router.post("/recording/discard", async () => {
		requireActive();
		await deps.recording.discard();
		return { ok: true };
	});

	router.get("/recording/status", () => {
		const active = deps.recording.getActive();
		if (!active) return { recording: false };
		return {
			recording: true,
			sessionId: active.sessionId,
			startTime: active.startedAt,
			chunks: active.chunks,
			devices: active.devices,
			muted: { system: active.muted.system, mic: active.muted.mic },
		};
	});

	router.post("/recording/mute", async ({ req }) => {
		const { target, muted } = await readJson<{ target: unknown; muted: unknown }>(req);
		if (target !== "system" && target !== "mic") {
			throw badRequest('target deve ser "system" ou "mic"');
		}
		if (typeof muted !== "boolean") throw badRequest("muted deve ser booleano");
		requireActive();
		await deps.recording.setMute(target as CaptureSource, muted);
		return { target, muted };
	});

	router.post("/recording/devices", async ({ req }) => {
		const body = await readJson<{ device: unknown; micDevice: unknown }>(req);
		const patch: Partial<CaptureDevices> = {};
		if (body.device !== undefined && body.device !== null)
			patch.system = normalizeSystem(body.device);
		if (body.micDevice !== undefined) patch.mic = normalizeMic(body.micDevice);
		if (patch.system === undefined && patch.mic === undefined) {
			throw badRequest("Informe device e/ou micDevice");
		}
		requireActive();
		return { devices: await deps.recording.switchDevices(patch) };
	});
}
