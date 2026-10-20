import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Session } from "@listening-resume/core";
import type { AppContext } from "../context.js";
import {
	badRequest,
	conflict,
	contentDisposition,
	HttpError,
	notFound,
	readJson,
} from "../http.js";
import { type Router, reply } from "../router.js";
import { type ExportFormat, parseExportFormat, renderExport } from "../services/export/index.js";
import { decodeFilenameHeader } from "../services/filenames.js";
import { DEFAULT_IMPORT_LIMIT, importMedia, saveUpload } from "../services/import.js";
import { assertTranscriberAvailable } from "../services/jobs.js";
import { createVirtualWavStream, parseRange, planVirtualWav } from "../services/wav-stream.js";

const MAX_LIST_LIMIT = 500;

export function registerSessionRoutes(router: Router, ctx: AppContext): void {
	const { deps, views, jobs } = ctx;
	const { repo } = deps;

	const assertIdle = (sessionId: string, action: string) => {
		if (deps.recording.getActive()?.sessionId === sessionId) {
			throw conflict(`Sessão em gravação — pare a gravação antes de ${action}`);
		}
	};

	const detail = async (sessionId: string) => {
		const session = repo.getSession(sessionId);
		if (!session) throw notFound("Sessão não encontrada");
		const t = repo.getTranscript(session.id);
		return {
			session: await views.summary(session),
			transcript: t
				? {
						segments: t.segments,
						fullText: t.fullText,
						language: t.language,
						provider: t.provider,
						model: t.model,
					}
				: null,
			analyses: repo.getAnalyses(session.id),
		};
	};

	router.get("/sessions", async ({ query }) => {
		const raw = Number(query.get("limit") ?? 50);
		const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), MAX_LIST_LIMIT) : 50;
		const q = query.get("q")?.trim() || undefined;
		return { sessions: await views.list(limit, q) };
	});

	// Registered before `/sessions/:id` so "import" isn't treated as an id.
	router.post(
		"/sessions/import",
		async ({ req }) => {
			const filename = decodeFilenameHeader(req.headers["x-filename"]) || "importado";
			fs.mkdirSync(deps.tmpDir, { recursive: true });
			const tmp = path.join(deps.tmpDir, `upload-${randomUUID()}`);
			try {
				const size = await saveUpload(req, tmp, deps.importLimitBytes ?? DEFAULT_IMPORT_LIMIT);
				if (size === 0) throw badRequest("Arquivo vazio");
				const session = await importMedia(deps, { path: tmp, filename });
				const settings = deps.settings.get();
				let result = session;
				if (settings.autoTranscribe) {
					try {
						assertTranscriberAvailable(deps.transcription, settings);
						jobs.transcribe(session.id);
						result = repo.getSession(session.id) ?? session;
					} catch (err) {
						deps.logger.warn(`[import] auto-transcribe not started: ${(err as Error).message}`);
					}
				}
				return reply(201, { session: result });
			} finally {
				fs.rmSync(tmp, { force: true });
			}
		},
		{ rawBody: true },
	);

	router.get("/sessions/:id", async ({ params }) => detail(views.resolve(params.id as string).id));

	router.patch("/sessions/:id", async ({ req, params }) => {
		const session = views.resolve(params.id as string);
		const body = await readJson<{ title: unknown; exportDir: unknown }>(req);
		const update: { title?: string | null; exportDir?: string | null } = {};
		if (body.title !== undefined) {
			if (body.title !== null && typeof body.title !== "string") throw badRequest("title inválido");
			const t = (body.title ?? "").trim();
			if (t.length > 200) throw badRequest("Título muito longo (máx. 200)");
			update.title = t || null;
		}
		if (body.exportDir !== undefined) {
			if (body.exportDir !== null && typeof body.exportDir !== "string") {
				throw badRequest("exportDir inválido");
			}
			const d = (body.exportDir ?? "").trim();
			if (d && !path.isAbsolute(d)) throw badRequest("exportDir deve ser um caminho absoluto");
			update.exportDir = d || null;
		}
		repo.updateSession(session.id, update);
		return { session: await views.summary(repo.getSession(session.id) ?? session) };
	});

	router.delete("/sessions/:id", async ({ params }) => {
		const session = views.resolve(params.id as string);
		assertIdle(session.id, "apagar");
		if (jobs.isBusy(session.id)) throw conflict("Aguarde o processamento terminar para apagar");
		await views.delete(session);
		return { ok: true };
	});

	router.post("/sessions/:id/transcribe", async ({ params }) => {
		const session = views.resolve(params.id as string);
		assertIdle(session.id, "transcrever");
		if (repo.getChunks(session.id).length === 0)
			throw badRequest("Sessão sem áudio para transcrever");
		assertTranscriberAvailable(deps.transcription, deps.settings.get());
		jobs.transcribe(session.id);
		return reply(202, { status: "transcribing" });
	});

	router.post("/sessions/:id/analyze", async ({ req, params }) => {
		const session = views.resolve(params.id as string);
		const { templateId } = await readJson<{ templateId: unknown }>(req);
		if (templateId !== undefined && typeof templateId !== "string") {
			throw badRequest("templateId inválido");
		}
		const settings = deps.settings.get();
		const template = repo.getTemplate(templateId || settings.defaultTemplateId);
		if (!template) throw notFound("Template não encontrado");
		if (!repo.getTranscript(session.id)) throw badRequest("Transcreva a sessão antes de analisar");
		jobs.analyze(session.id, template, deps.analysis.create(settings), settings);
		return reply(202, { status: "analyzing" });
	});

	router.delete("/analyses/:id", ({ params }) => {
		if (!repo.deleteAnalysis(params.id as string)) throw notFound("Análise não encontrada");
		return { ok: true };
	});

	router.get("/sessions/:id/audio", async ({ req, res, params }) => {
		const session = views.resolve(params.id as string);
		const plan = planVirtualWav(await views.wavSources(session.id));
		if (!plan || plan.parts.length === 0) throw notFound("Sessão sem áudio");
		const range = parseRange(req.headers.range, plan.totalSize);
		if (range === "unsatisfiable") {
			res.writeHead(416, { "Content-Range": `bytes */${plan.totalSize}` });
			res.end();
			return;
		}
		const r = range ?? { start: 0, end: plan.totalSize - 1 };
		const headers: Record<string, string | number> = {
			"Content-Type": "audio/wav",
			"Accept-Ranges": "bytes",
			"Content-Length": r.end - r.start + 1,
			"Cache-Control": "no-cache",
		};
		if (range) headers["Content-Range"] = `bytes ${r.start}-${r.end}/${plan.totalSize}`;
		res.writeHead(range ? 206 : 200, headers);
		if (req.method === "HEAD") {
			res.end();
			return;
		}
		await pipeline(createVirtualWavStream(plan, r), res).catch((err: NodeJS.ErrnoException) => {
			// Seeking aborts the previous request — that's normal, not an error.
			if (err.code !== "ERR_STREAM_PREMATURE_CLOSE") {
				deps.logger.warn(`[audio] stream failed: ${err.message}`);
			}
		});
	});

	const render = async (session: Session, format: ExportFormat) =>
		renderExport(format, {
			session,
			transcript: repo.getTranscript(session.id),
			analyses: repo.getAnalyses(session.id),
			templates: repo.listTemplates(),
			durationSec: await views.duration(session.id),
		});

	router.get("/sessions/:id/export", async ({ res, params, query }) => {
		const format = parseExportFormat(query.get("format") ?? "md");
		const session = views.resolve(params.id as string);
		const out = await render(session, format);
		res.writeHead(200, {
			"Content-Type": out.contentType,
			"Content-Length": out.body.length,
			"Content-Disposition": contentDisposition(out.filename),
		});
		res.end(out.body);
	});

	router.post("/sessions/:id/export/save", async ({ req, params }) => {
		const session = views.resolve(params.id as string);
		const { format } = await readJson<{ format: unknown }>(req);
		const fmt = parseExportFormat(
			typeof format === "string" ? format : deps.settings.get().exportFormat,
		);
		const out = await render(session, fmt);
		const dir = session.exportDir || deps.settings.get().exportDir;
		if (!path.isAbsolute(dir)) {
			throw badRequest("Pasta de exportação inválida — configure um caminho absoluto");
		}
		try {
			fs.mkdirSync(dir, { recursive: true });
			const target = path.join(dir, out.filename);
			fs.writeFileSync(target, out.body);
			deps.logger.info(`[export] ${session.id} → ${target}`);
			return { path: target };
		} catch (err) {
			throw new HttpError(500, `Não foi possível salvar em ${dir}: ${(err as Error).message}`);
		}
	});
}
