import { levelsUrl } from "./client";
import type { AudioLevels, ResolvedDevices } from "./types";

export interface LevelsStreamHandlers {
	onLevels: (levels: AudioLevels) => void;
	onDevices?: (devices: ResolvedDevices) => void;
	onStatus?: (connected: boolean) => void;
	/**
	 * `event: unavailable` — no levels on this stream (the meter could not start, or the
	 * capture backend cannot measure levels during a recording). The stream stays open.
	 */
	onUnavailable?: (message: string) => void;
	/**
	 * `event: ended` with `{ sessionId }` — the recording this stream followed has stopped; the
	 * stream is closed for good. (`{ recording: true }` — a meter stream superseded by a new
	 * recording — just reconnects, to receive that recording's levels.)
	 */
	onEnded?: (info: { sessionId: string | null }) => void;
	/**
	 * `event: warning` — a non-fatal capture problem during a recording (pt-BR `message`);
	 * `fallback`: a named device is missing and the system default is recorded instead.
	 */
	onWarning?: (warning: CaptureWarning) => void;
}

export interface CaptureWarning {
	message: string;
	fallback: boolean;
}

export interface LevelsStreamOptions {
	/** Injectable for tests; defaults to the global EventSource. */
	EventSourceImpl?: typeof EventSource;
	minRetryMs?: number;
	maxRetryMs?: number;
}

const CLOSED = 2;

const clamp01 = (n: unknown) =>
	typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;

const UNAVAILABLE_REASONS: Record<string, string> = {
	"levels-unsupported": "Medidor de nível indisponível neste sistema",
	"meter-unsupported": "Medidor de nível indisponível neste sistema",
	"meter-failed": "Medidor de áudio indisponível",
	"meter-stopped": "O medidor de áudio parou",
};

/** `ended` payload: `{ sessionId }` (recording over) or `{ recording: true }` (meter superseded). */
export function parseEnded(data: string): { sessionId: string | null; restart: boolean } {
	try {
		const raw = JSON.parse(data) as { sessionId?: unknown; recording?: unknown } | null;
		return {
			sessionId: typeof raw?.sessionId === "string" ? raw.sessionId : null,
			restart: raw?.recording === true,
		};
	} catch {
		return { sessionId: null, restart: false };
	}
}

/** `unavailable` payload: JSON `{ error | message | reason }` or plain text. */
export function parseUnavailable(data: string): string {
	try {
		const raw = JSON.parse(data) as
			| { error?: unknown; message?: unknown; reason?: unknown }
			| string;
		if (typeof raw === "string") return raw;
		const msg = raw?.error ?? raw?.message;
		if (typeof msg === "string" && msg) return msg;
		if (typeof raw?.reason === "string")
			return UNAVAILABLE_REASONS[raw.reason] ?? "Medidor de nível indisponível";
	} catch {
		// plain text
	}
	return data || "Captura indisponível";
}

/** `warning` payload: `{ message, fallback }`; `null` when malformed or empty. */
export function parseWarning(data: string): CaptureWarning | null {
	try {
		const raw = JSON.parse(data) as { message?: unknown; fallback?: unknown } | null;
		if (typeof raw?.message !== "string" || !raw.message.trim()) return null;
		return { message: raw.message, fallback: raw.fallback === true };
	} catch {
		return null;
	}
}

export function parseLevels(data: string): AudioLevels | null {
	try {
		const raw = JSON.parse(data) as Partial<AudioLevels>;
		return { system: clamp01(raw.system), mic: clamp01(raw.mic) };
	} catch {
		return null;
	}
}

/**
 * Subscribes to GET /audio/levels (SSE). EventSource retries transient network errors on
 * its own; when the stream is CLOSED (HTTP error, server restart) we reconnect with
 * exponential backoff. Returns a disposer.
 */
export function openLevelsStream(
	params: { system?: string; mic?: string | null },
	handlers: LevelsStreamHandlers,
	opts: LevelsStreamOptions = {},
): () => void {
	const ES = opts.EventSourceImpl ?? (globalThis.EventSource as typeof EventSource | undefined);
	if (!ES) return () => {};
	const minRetry = opts.minRetryMs ?? 1000;
	const maxRetry = opts.maxRetryMs ?? 10000;
	const url = levelsUrl(params);
	let es: EventSource | null = null;
	let disposed = false;
	let delay = minRetry;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const connect = () => {
		if (disposed) return;
		const source = new ES(url);
		es = source;
		source.onopen = () => {
			delay = minRetry;
			handlers.onStatus?.(true);
		};
		source.onmessage = (e: MessageEvent<string>) => {
			const lv = parseLevels(e.data);
			if (lv) handlers.onLevels(lv);
		};
		source.addEventListener("devices", (e) => {
			try {
				handlers.onDevices?.(JSON.parse((e as MessageEvent<string>).data) as ResolvedDevices);
			} catch {
				// malformed event — ignore
			}
		});
		source.addEventListener("warning", (e) => {
			const warning = parseWarning((e as MessageEvent<string>).data);
			if (warning) handlers.onWarning?.(warning);
		});
		source.addEventListener("unavailable", (e) => {
			handlers.onUnavailable?.(parseUnavailable((e as MessageEvent<string>).data));
		});
		source.addEventListener("ended", (e) => {
			const info = parseEnded((e as MessageEvent<string>).data);
			source.close();
			handlers.onStatus?.(false);
			if (info.restart) {
				// A recording started: reconnect to get its levels.
				clearTimeout(timer);
				timer = setTimeout(connect, 0);
				return;
			}
			// The followed recording is over: stop for good (EventSource would reconnect).
			disposed = true;
			clearTimeout(timer);
			handlers.onEnded?.({ sessionId: info.sessionId });
		});
		source.onerror = () => {
			if (disposed) return;
			handlers.onStatus?.(false);
			if (source.readyState === CLOSED && !disposed) {
				source.close();
				timer = setTimeout(connect, delay);
				delay = Math.min(delay * 2, maxRetry);
			}
		};
	};

	connect();
	return () => {
		disposed = true;
		clearTimeout(timer);
		es?.close();
	};
}
