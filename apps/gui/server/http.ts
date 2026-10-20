import type http from "node:http";

/** An error that maps directly to an HTTP response `{ error }` with the given status. */
export class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "HttpError";
	}
}

export const badRequest = (msg: string) => new HttpError(400, msg);
export const notFound = (msg: string) => new HttpError(404, msg);
export const conflict = (msg: string) => new HttpError(409, msg);

const KIND_STATUS: Record<string, number> = {
	validation: 400,
	not_found: 404,
	conflict: 409,
	internal: 500,
};

/** Map anything thrown by a handler to `{ status, message }`. */
export function toHttpError(err: unknown): { status: number; message: string } {
	if (err instanceof HttpError) return { status: err.status, message: err.message };
	const e = err as { kind?: string; name?: string; message?: string; issues?: unknown[] } | null;
	if (e?.kind && KIND_STATUS[e.kind]) {
		return { status: KIND_STATUS[e.kind] as number, message: e.message ?? "Erro" };
	}
	if (e?.name === "ZodError" || Array.isArray(e?.issues)) {
		return { status: 400, message: zodMessage(e) };
	}
	return { status: 500, message: e?.message || "Erro interno" };
}

function zodMessage(e: { message?: string; issues?: unknown[] } | null): string {
	const issues = (e?.issues ?? []) as Array<{ path?: Array<string | number>; message?: string }>;
	if (issues.length === 0) return "Dados inválidos";
	return `Dados inválidos: ${issues
		.slice(0, 5)
		.map((i) => `${(i.path ?? []).join(".") || "(raiz)"}: ${i.message ?? "inválido"}`)
		.join("; ")}`;
}

/** Default max size for JSON request bodies. */
export const DEFAULT_JSON_LIMIT = 1024 * 1024; // 1 MB

/** Browser origins of the app itself: Vite dev server and the packaged Tauri webview. */
export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = [
	"http://localhost:1420",
	"http://127.0.0.1:1420",
	"http://tauri.localhost", // Windows (WebView2)
	"https://tauri.localhost",
	"tauri://localhost", // macOS / Linux
];

const normalizeOrigin = (o: string) => o.trim().replace(/\/+$/, "").toLowerCase();

/** Default origins plus `LR_ALLOWED_ORIGINS` (comma-separated; tests / e2e on other ports). */
export function allowedOrigins(env: NodeJS.ProcessEnv = process.env): Set<string> {
	const extra = (env.LR_ALLOWED_ORIGINS ?? "").split(",").map(normalizeOrigin).filter(Boolean);
	return new Set([...DEFAULT_ALLOWED_ORIGINS, ...extra]);
}

/** Exact allow-list match. `null`/`"null"`/missing origins are never "allowed". */
export function isAllowedOrigin(
	origin: string | undefined | null,
	allowed: Set<string> = allowedOrigins(),
): boolean {
	if (!origin) return false;
	const o = normalizeOrigin(origin);
	return o !== "null" && allowed.has(o);
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "tauri.localhost"]);

/**
 * DNS-rebinding guard: the `Host` header must name loopback (`localhost`, `127.0.0.1`, `[::1]`)
 * or `tauri.localhost`, with the listening port or no port. A rebinding attack reaches us with
 * the attacker's hostname in `Host`, so it is refused here.
 */
export function isAllowedHost(host: string | undefined, port?: number): boolean {
	if (!host) return false;
	const m = /^(\[[0-9a-f:.]+\]|[^:[\]]+)(?::(\d{1,5}))?$/i.exec(host.trim());
	if (!m) return false;
	const name = (m[1] as string).toLowerCase();
	if (!LOOPBACK_HOSTS.has(name)) return false;
	return m[2] === undefined || port === undefined || Number(m[2]) === port;
}

/** Origin of the `Referer` header (custom schemes such as tauri:// included), or null. */
export function refererOrigin(req: http.IncomingMessage): string | null {
	const referer = req.headers.referer;
	if (!referer) return null;
	try {
		const u = new URL(referer);
		// URL.origin is "null" for custom schemes such as tauri://
		return u.origin !== "null" ? u.origin : `${u.protocol}//${u.host}`;
	} catch {
		return null;
	}
}

export const STATE_CHANGING_METHODS: ReadonlySet<string> = new Set([
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
]);

function headerValue(req: http.IncomingMessage, name: string): string | undefined {
	const v = req.headers[name];
	return Array.isArray(v) ? v[0] : v;
}

/**
 * Request guard (Host + Origin + Fetch Metadata). Returns the error to send, or null to proceed.
 *
 * 1. `Host` must be loopback / tauri.localhost (DNS rebinding) → else 403.
 * 2. An `Origin` header (including `Origin: null`) must be in the allow-list → else 403.
 * 3. No `Origin`, state-changing method: only non-browser local clients (CLI, tests, curl) are
 *    accepted, recognised by the absence of `Sec-Fetch-Site` — every current browser sends it
 *    (and always sends `Origin` on POST/PUT/PATCH/DELETE). Node's fetch sends
 *    `Sec-Fetch-Mode` but never `Sec-Fetch-Site`.
 * 4. No `Origin`, safe method (GET/HEAD/OPTIONS) with `Sec-Fetch-Site: cross-site|same-site`
 *    (e.g. `<audio src>` / download links from the Tauri webview): the `Referer` origin must be
 *    allowed → else 403.
 */
export function checkRequestGuard(
	req: http.IncomingMessage,
	opts: { port?: number; allowed?: Set<string> } = {},
): HttpError | null {
	if (!isAllowedHost(headerValue(req, "host"), opts.port)) {
		return new HttpError(403, "Host não permitido");
	}
	const allowed = opts.allowed ?? allowedOrigins();
	const origin = headerValue(req, "origin");
	if (origin !== undefined) {
		return isAllowedOrigin(origin, allowed) ? null : new HttpError(403, "Origem não permitida");
	}
	const site = headerValue(req, "sec-fetch-site")?.trim().toLowerCase();
	const method = (req.method ?? "GET").toUpperCase();
	if (STATE_CHANGING_METHODS.has(method)) {
		return site === undefined ? null : new HttpError(403, "Origem não permitida");
	}
	if (site === "cross-site" || site === "same-site") {
		return isAllowedOrigin(refererOrigin(req), allowed)
			? null
			: new HttpError(403, "Origem não permitida");
	}
	return null;
}

/**
 * True when a state-changing request's body is JSON or absent. Requiring
 * `application/json` means a cross-origin browser request always needs a CORS preflight.
 */
export function hasJsonOrEmptyBody(req: http.IncomingMessage): boolean {
	const ct = headerValue(req, "content-type");
	if (ct !== undefined && ct.trim() !== "") return /^application\/json\s*(;|$)/i.test(ct.trim());
	if (req.headers["transfer-encoding"] !== undefined) return false;
	const len = req.headers["content-length"];
	return len === undefined || Number(len) === 0;
}

/** CORS headers echoing an allowed origin (never `*`). */
export function corsHeaders(
	origin: string | null | undefined,
	allowed: Set<string> = allowedOrigins(),
): Record<string, string> {
	const headers: Record<string, string> = {
		"Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type, X-Filename, Range",
		"Access-Control-Expose-Headers": "Content-Disposition, Content-Range, Accept-Ranges",
		Vary: "Origin",
	};
	if (origin && isAllowedOrigin(origin, allowed)) headers["Access-Control-Allow-Origin"] = origin;
	return headers;
}

export function json(res: http.ServerResponse, data: unknown, status = 200): void {
	const body = JSON.stringify(data);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(body),
	});
	res.end(body);
}

export function sendError(res: http.ServerResponse, status: number, message: string): void {
	if (res.headersSent) {
		res.destroy();
		return;
	}
	json(res, { error: message }, status);
}

/** Read the raw request body into memory, rejecting with 413 past `limit` bytes. */
export function readBody(req: http.IncomingMessage, limit = DEFAULT_JSON_LIMIT): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const declared = Number(req.headers["content-length"]);
		if (Number.isFinite(declared) && declared > limit) {
			req.resume();
			reject(new HttpError(413, "Corpo da requisição muito grande"));
			return;
		}
		const parts: Buffer[] = [];
		let size = 0;
		let done = false;
		req.on("data", (chunk: Buffer) => {
			if (done) return;
			size += chunk.length;
			if (size > limit) {
				done = true;
				req.resume();
				reject(new HttpError(413, "Corpo da requisição muito grande"));
				return;
			}
			parts.push(chunk);
		});
		req.on("end", () => {
			if (!done) {
				done = true;
				resolve(Buffer.concat(parts));
			}
		});
		req.on("error", (err) => {
			if (!done) {
				done = true;
				reject(err);
			}
		});
	});
}

/** Read and parse a JSON object body. Empty body → `{}`. Invalid JSON / non-object → 400. */
export async function readJson<T extends object = Record<string, unknown>>(
	req: http.IncomingMessage,
	limit = DEFAULT_JSON_LIMIT,
): Promise<Partial<T>> {
	const raw = (await readBody(req, limit)).toString("utf-8").trim();
	if (!raw) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw badRequest("JSON inválido");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw badRequest("O corpo deve ser um objeto JSON");
	}
	return parsed as Partial<T>;
}

/** Build a `Content-Disposition: attachment` header value safe for non-ASCII names. */
export function contentDisposition(filename: string): string {
	const ascii = filename
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^\x20-\x7e]/g, "_")
		.replace(/["\\]/g, "_");
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export interface SseChannel {
	send(data: unknown, event?: string): void;
	comment(text: string): void;
	close(): void;
	/** Fires once when the client disconnects or the channel is closed. */
	onClose(cb: () => void): void;
	readonly closed: boolean;
}

/** Turn a response into a Server-Sent Events stream with a periodic heartbeat comment. */
export function openSse(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	heartbeatMs = 15_000,
	retryMs = 1000,
): SseChannel {
	res.writeHead(200, {
		"Content-Type": "text/event-stream; charset=utf-8",
		"Cache-Control": "no-cache, no-transform",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
	});
	res.flushHeaders?.();
	// `retry` = EventSource reconnect delay after the server ends the stream (`event: ended`).
	res.write(`: connected\nretry: ${retryMs}\n\n`);

	const closeCbs: Array<() => void> = [];
	let closed = false;
	const heartbeat = setInterval(() => {
		if (!closed) res.write(": heartbeat\n\n");
	}, heartbeatMs);
	heartbeat.unref?.();

	const finish = () => {
		if (closed) return;
		closed = true;
		clearInterval(heartbeat);
		for (const cb of closeCbs.splice(0)) {
			try {
				cb();
			} catch {
				// listener errors must not break teardown
			}
		}
	};
	req.on("close", finish);
	res.on("close", finish);

	return {
		get closed() {
			return closed;
		},
		send(data, event) {
			if (closed) return;
			let frame = "";
			if (event) frame += `event: ${event}\n`;
			frame += `data: ${JSON.stringify(data)}\n\n`;
			res.write(frame);
		},
		comment(text) {
			if (!closed) res.write(`: ${text.replace(/\n/g, " ")}\n\n`);
		},
		close() {
			if (closed) return;
			finish();
			res.end();
		},
		onClose(cb) {
			if (closed) cb();
			else closeCbs.push(cb);
		},
	};
}
