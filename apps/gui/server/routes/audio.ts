import {
	type AudioLevels,
	assertDeviceId,
	type CaptureDevices,
	describeCaptureWarning,
	SYSTEM_DEFAULT_DEVICE,
} from "@listening-resume/core";
import type { AppContext } from "../context.js";
import { badRequest, openSse, readJson, type SseChannel } from "../http.js";
import type { Router } from "../router.js";

/**
 * `"none"`/`""`/`null` → no mic; anything else is a device id or `@default`. Ids reach the
 * capture binary's stdin/argv, so core's `assertDeviceId` rejects control characters and
 * overlong ids (`ValidationError` naming the field → 400).
 */
export function normalizeMic(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== "string") throw badRequest("micDevice inválido");
	const v = value.trim();
	return !v || v.toLowerCase() === "none" ? null : assertDeviceId(v, "micDevice");
}

export function normalizeSystem(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) throw badRequest("device inválido");
	return assertDeviceId(value.trim(), "device");
}

const DEFAULT_SSE_POLL_MS = 250;

/** Devices, test tone and the live level meter (SSE). */
export function registerAudioRoutes(router: Router, ctx: AppContext): void {
	const { deps, meters } = ctx;
	const pollMs = deps.ssePollMs ?? DEFAULT_SSE_POLL_MS;

	router.get("/devices", async () => ({ devices: await deps.capture.listDevices() }));

	router.post("/audio/test", async ({ req }) => {
		const { device } = await readJson<{ device: unknown }>(req);
		const target =
			device === undefined || device === null || device === ""
				? deps.settings.get().systemDevice || SYSTEM_DEFAULT_DEVICE
				: normalizeSystem(device);
		await deps.capture.playTestTone(target);
		return { ok: true };
	});

	/**
	 * Ends the stream with `event: ended` when `stillCurrent()` turns false (a recording
	 * started/stopped); EventSource then reconnects and gets the right mode.
	 */
	const endWhen = (sse: SseChannel, stillCurrent: () => boolean, data: () => unknown) => {
		const timer = setInterval(() => {
			if (!stillCurrent()) {
				sse.send(data(), "ended");
				sse.close();
			}
		}, pollMs);
		timer.unref?.();
		sse.onClose(() => clearInterval(timer));
	};

	router.get("/audio/levels", async ({ req, res, query }) => {
		// Validate before switching the response to SSE so bad input is a plain 400.
		const settings = deps.settings.get();
		const systemQ = query.get("system")?.trim();
		const devices: CaptureDevices = {
			system: systemQ ? normalizeSystem(systemQ) : settings.systemDevice || SYSTEM_DEFAULT_DEVICE,
			mic: query.has("mic") ? normalizeMic(query.get("mic")) : settings.micDevice,
		};

		const sse = openSse(req, res, deps.sseHeartbeatMs);
		const sendLevels = (l: AudioLevels) => sse.send({ system: l.system, mic: l.mic });

		const active = deps.recording.getActive();
		if (active) {
			// Stream the recording's own levels; the query is ignored.
			const sessionId = active.sessionId;
			const ended = () => ({ sessionId });
			if (active.devices) sse.send(active.devices, "devices");
			if (!deps.capture.capabilities.levels) {
				sse.send({ reason: "levels-unsupported" }, "unavailable");
			} else {
				sse.onClose(deps.recording.onLevels(sendLevels));
			}
			sse.onClose(deps.recording.onDeviceChange((d) => sse.send(d, "devices")));
			// Non-fatal capture problems (e.g. a named device is missing → the default is used).
			sse.onClose(
				deps.recording.onWarning((raw) => {
					const { message, fallback } = describeCaptureWarning(raw);
					sse.send({ message, fallback }, "warning");
				}),
			);
			sse.onClose(
				deps.recording.onInterrupted((s) => {
					if (s.id !== sessionId) return;
					sse.send(ended(), "ended");
					sse.close();
				}),
			);
			endWhen(sse, () => deps.recording.getActive()?.sessionId === sessionId, ended);
			return;
		}

		// Meter mode ends as soon as a recording starts, so the client switches to its levels.
		endWhen(
			sse,
			() => !deps.recording.getActive(),
			() => ({ recording: true }),
		);
		if (!deps.capture.capabilities.meter) {
			sse.send({ reason: "meter-unsupported" }, "unavailable");
			return;
		}
		try {
			const unsubscribe = await meters.subscribe(devices, {
				onLevels: sendLevels,
				onDevices: (d) => sse.send(d, "devices"),
				onDead: (error) => {
					// Keep the stream open (EventSource would otherwise reconnect in a loop).
					sse.send({ reason: "meter-stopped", error }, "unavailable");
				},
			});
			sse.onClose(unsubscribe);
		} catch (err) {
			deps.logger.warn(`[levels] meter unavailable: ${(err as Error).message}`);
			sse.send({ reason: "meter-failed", error: "Medidor de áudio indisponível" }, "unavailable");
		}
	});
}
