import fs from "node:fs";
import { buildTranscriptPreview, type Session, type SessionSummary } from "@listening-resume/core";
import type { AppDeps } from "../deps.js";
import { notFound } from "../http.js";
import type { WavInfoLike, WavSource } from "./wav-stream.js";

type Deps = Pick<AppDeps, "repo" | "storage" | "readWavInfo" | "logger">;
type WavInfo = WavInfoLike & { durationSec: number };

/** Read-side helpers shared by the session / export / audio routes. */
export class SessionViews {
	private wavCache = new Map<string, { key: string; info: WavInfo }>();
	/** Card previews keyed by session status — invalidated when a job settles or on delete. */
	private previewCache = new Map<string, { status: string; preview: string | null }>();

	constructor(private deps: Deps) {}

	/** Resolve a full id or a unique id prefix. 404 when unknown or ambiguous. */
	resolve(idOrPrefix: string): Session {
		const id = idOrPrefix.trim();
		const session = id ? this.deps.repo.findSessionByIdPrefix(id) : null;
		if (!session) throw notFound("Sessão não encontrada");
		return session;
	}

	private wavInfo(file: string): WavInfo | null {
		try {
			const st = fs.statSync(file);
			const key = `${st.size}:${st.mtimeMs}`;
			const cached = this.wavCache.get(file);
			if (cached && cached.key === key) return cached.info;
			const info = this.deps.readWavInfo(file);
			this.wavCache.set(file, { key, info });
			return info;
		} catch (err) {
			this.deps.logger.warn(`[wav] unreadable ${file}: ${(err as Error).message}`);
			return null;
		}
	}

	/** Chunk WAVs on disk (in order) with their real header info. */
	async wavSources(sessionId: string): Promise<WavSource[]> {
		const out: WavSource[] = [];
		for (const file of await this.deps.storage.listAudioFiles(sessionId)) {
			const info = this.wavInfo(file);
			if (info) out.push({ path: file, info });
		}
		return out;
	}

	/** Total duration in seconds from each chunk's WAV header (never from config). */
	async duration(sessionId: string): Promise<number> {
		let total = 0;
		for (const file of await this.deps.storage.listAudioFiles(sessionId)) {
			total += this.wavInfo(file)?.durationSec ?? 0;
		}
		return Math.round(total * 10) / 10;
	}

	/** Transcript preview without re-reading the transcript on every list call. */
	private preview(session: Session): string | null {
		const cached = this.previewCache.get(session.id);
		if (cached && cached.status === session.status) return cached.preview;
		const preview = buildTranscriptPreview(this.deps.repo.getTranscript(session.id));
		this.previewCache.set(session.id, { status: session.status, preview });
		return preview;
	}

	/** Drop cached derived data of a session (its transcript/analyses changed). */
	invalidate(sessionId: string): void {
		this.previewCache.delete(sessionId);
	}

	async summary(session: Session): Promise<SessionSummary> {
		const { repo } = this.deps;
		return {
			...session,
			chunks: repo.getChunks(session.id).length,
			duration: await this.duration(session.id),
			preview: this.preview(session),
			analysesCount: repo.countAnalyses(session.id),
		};
	}

	/**
	 * Newest first; `query` matches title or transcript text. `created` sessions (an import
	 * still converting) are hidden until they are ready.
	 */
	async list(limit: number, query: string | undefined): Promise<SessionSummary[]> {
		const sessions = this.deps.repo
			.listSessions({ limit, query })
			.filter((s) => s.status !== "created");
		return Promise.all(sessions.map((s) => this.summary(s)));
	}

	/** Remove a session's DB rows and files. */
	async delete(session: Session): Promise<void> {
		for (const f of await this.deps.storage.listAudioFiles(session.id)) this.wavCache.delete(f);
		this.invalidate(session.id);
		this.deps.repo.deleteSession(session.id);
		try {
			await this.deps.storage.removeSessionDir(session.id);
		} catch (err) {
			this.deps.logger.warn(
				`[sessions] could not remove files of ${session.id}: ${(err as Error).message}`,
			);
		}
	}
}
