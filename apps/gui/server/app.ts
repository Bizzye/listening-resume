import http from "node:http";
import type { AppContext } from "./context.js";
import type { AppDeps } from "./deps.js";
import {
	allowedOrigins,
	checkRequestGuard,
	corsHeaders,
	hasJsonOrEmptyBody,
	json,
	STATE_CHANGING_METHODS,
	sendError,
	toHttpError,
} from "./http.js";
import { Reply, Router } from "./router.js";
import { registerAudioRoutes } from "./routes/audio.js";
import { registerRecordingRoutes } from "./routes/recording.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerTemplateRoutes } from "./routes/templates.js";
import { JobRunner } from "./services/jobs.js";
import { MeterPool } from "./services/meters.js";
import { SessionViews } from "./services/sessions.js";

const API_PREFIX = "/api";

export interface App {
	server: http.Server;
	/** Shared services, exposed for tests and graceful shutdown. */
	context: AppContext;
}

export function buildRouter(ctx: AppContext): Router {
	const router = new Router();
	registerSystemRoutes(router, ctx);
	registerAudioRoutes(router, ctx);
	registerRecordingRoutes(router, ctx);
	registerSessionRoutes(router, ctx);
	registerTemplateRoutes(router, ctx);
	return router;
}

/** Build the HTTP API server. All I/O comes from `deps`, so tests can inject fakes. */
export function createApp(deps: AppDeps): App {
	const views = new SessionViews(deps);
	const context: AppContext = {
		deps,
		views,
		jobs: new JobRunner(deps, (sessionId) => views.invalidate(sessionId)),
		meters: new MeterPool(deps.capture, deps.logger, deps.meterStallMs),
	};
	const router = buildRouter(context);
	const allowed = deps.allowedOrigins
		? allowedOrigins({ LR_ALLOWED_ORIGINS: deps.allowedOrigins.join(",") })
		: allowedOrigins();

	const server = http.createServer(async (req, res) => {
		const origin = req.headers.origin;
		for (const [k, v] of Object.entries(corsHeaders(origin, allowed))) res.setHeader(k, v);

		const denied = checkRequestGuard(req, { port: req.socket.localPort, allowed });
		if (denied) {
			sendError(res, denied.status, denied.message);
			return;
		}
		if (req.method === "OPTIONS") {
			res.writeHead(204);
			res.end();
			return;
		}

		const url = new URL(req.url ?? "/", "http://localhost");
		if (!url.pathname.startsWith(`${API_PREFIX}/`)) {
			sendError(res, 404, "Não encontrado");
			return;
		}
		const method = req.method ?? "GET";
		const match = router.match(method, url.pathname.slice(API_PREFIX.length));
		if (match === null) {
			sendError(res, 404, "Não encontrado");
			return;
		}
		if (match === "method-not-allowed") {
			sendError(res, 405, "Método não permitido");
			return;
		}
		if (STATE_CHANGING_METHODS.has(method) && !match.options.rawBody && !hasJsonOrEmptyBody(req)) {
			sendError(res, 415, "Content-Type deve ser application/json");
			return;
		}

		try {
			const result = await match.handler({
				req,
				res,
				params: match.params,
				query: url.searchParams,
			});
			if (res.headersSent || res.writableEnded) return;
			if (result instanceof Reply) json(res, result.body, result.status);
			else json(res, result ?? { ok: true });
		} catch (err) {
			const { status, message } = toHttpError(err);
			if (status >= 500) {
				deps.logger.error(`${req.method} ${url.pathname} → ${status}: ${message}`);
			}
			sendError(res, status, message);
		}
	});

	return { server, context };
}
