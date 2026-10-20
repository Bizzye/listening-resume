import type http from "node:http";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RouteContext {
	req: http.IncomingMessage;
	res: http.ServerResponse;
	params: Record<string, string>;
	query: URLSearchParams;
}

/** Explicit status + body. A handler returning a plain value is sent as JSON with 200. */
export class Reply {
	constructor(
		readonly status: number,
		readonly body: unknown,
	) {}
}

export const reply = (status: number, body: unknown) => new Reply(status, body);

/**
 * A handler either returns a value (serialized as JSON) or writes to `ctx.res` itself
 * (streams, downloads, SSE) and returns `undefined`.
 */
export type Handler = (ctx: RouteContext) => unknown | Promise<unknown>;

export interface RouteOptions {
	/**
	 * The handler reads a raw (non-JSON) body, e.g. an uploaded file. Other state-changing
	 * routes only accept `application/json` (or no body).
	 */
	rawBody?: boolean;
}

interface Route {
	method: Method;
	segments: string[];
	handler: Handler;
	options: RouteOptions;
}

export interface RouteMatch {
	handler: Handler;
	params: Record<string, string>;
	options: RouteOptions;
}

function split(path: string): string[] {
	return path.split("/").filter(Boolean);
}

/** Tiny router: static segments and `:param` captures, first registered match wins. */
export class Router {
	private routes: Route[] = [];

	add(method: Method, pattern: string, handler: Handler, options: RouteOptions = {}): this {
		this.routes.push({ method, segments: split(pattern), handler, options });
		return this;
	}

	get(p: string, h: Handler) {
		return this.add("GET", p, h);
	}
	post(p: string, h: Handler, options?: RouteOptions) {
		return this.add("POST", p, h, options);
	}
	put(p: string, h: Handler) {
		return this.add("PUT", p, h);
	}
	patch(p: string, h: Handler) {
		return this.add("PATCH", p, h);
	}
	delete(p: string, h: Handler) {
		return this.add("DELETE", p, h);
	}

	/**
	 * Resolve a request. Returns the match, `"method-not-allowed"` when the path exists under
	 * another method, or `null` when nothing matches.
	 */
	match(method: string, pathname: string): RouteMatch | "method-not-allowed" | null {
		const parts = split(pathname);
		let pathMatched = false;
		for (const route of this.routes) {
			const params = matchSegments(route.segments, parts);
			if (!params) continue;
			pathMatched = true;
			if (route.method === method || (method === "HEAD" && route.method === "GET")) {
				return { handler: route.handler, params, options: route.options };
			}
		}
		return pathMatched ? "method-not-allowed" : null;
	}
}

function matchSegments(pattern: string[], parts: string[]): Record<string, string> | null {
	if (pattern.length !== parts.length) return null;
	const params: Record<string, string> = {};
	for (let i = 0; i < pattern.length; i++) {
		const p = pattern[i] as string;
		const v = parts[i] as string;
		if (p.startsWith(":")) {
			let decoded: string;
			try {
				decoded = decodeURIComponent(v);
			} catch {
				return null;
			}
			params[p.slice(1)] = decoded;
		} else if (p !== v) {
			return null;
		}
	}
	return params;
}
