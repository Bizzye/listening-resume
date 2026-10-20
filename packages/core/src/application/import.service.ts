import { randomUUID } from "node:crypto";
import { ValidationError } from "../domain/errors.js";
import type { Session } from "../domain/models.js";
import { assertTransition } from "../domain/states.js";
import type { FileStoragePort } from "../ports/file-storage.js";
import type { SessionRepository } from "../ports/repository.js";
import { logger } from "../utils/logger.js";
import { tryReadWavInfo } from "../utils/wav.js";

/** WAV facts the import needs from each converted chunk. */
export interface ImportedWavInfo {
	durationSec: number;
	sampleRate: number;
}

export interface ImportServiceDeps {
	repo: SessionRepository;
	storage: FileStoragePort;
	/** Reads a chunk's header (default `tryReadWavInfo`); `null`/throwing = not usable audio. */
	readWavInfo?: (filePath: string) => ImportedWavInfo | null;
	newId?: () => string;
	now?: () => Date;
}

export interface ImportRequest {
	title: string;
	/** pt-BR description shown in the UI (e.g. "Arquivo importado · .mp4"). */
	audioSource: string;
}

/** The converted file has no audio (no chunk, or zero duration). HTTP 422 at the API. */
export class EmptyImportError extends ValidationError {
	constructor() {
		super("O arquivo não contém áudio");
		this.name = "EmptyImportError";
	}
}

/**
 * Turns an external media file into a `stopped` session: owns the session row (created as
 * `created` — hidden from lists, settled by boot-reconcile after a crash), the chunk rows
 * (durations from each WAV header) and the `created → stopped` transition. The caller only
 * converts the media into WAV chunks inside the given audio dir. On any failure nothing is
 * left behind (session row + files removed).
 */
export class ImportService {
	private readonly repo: SessionRepository;
	private readonly storage: FileStoragePort;
	private readonly readWavInfo: (filePath: string) => ImportedWavInfo | null;
	private readonly newId: () => string;
	private readonly now: () => Date;

	constructor(deps: ImportServiceDeps) {
		this.repo = deps.repo;
		this.storage = deps.storage;
		this.readWavInfo = deps.readWavInfo ?? tryReadWavInfo;
		this.newId = deps.newId ?? randomUUID;
		this.now = deps.now ?? (() => new Date());
	}

	async importAudio(
		request: ImportRequest,
		convert: (audioDir: string) => Promise<void>,
	): Promise<Session> {
		const now = this.now();
		const session: Session = {
			id: this.newId(),
			title: request.title,
			status: "created",
			startedAt: now.toISOString(),
			endedAt: now.toISOString(),
			audioSource: request.audioSource,
			language: "auto",
			createdAt: now.toISOString(),
			exportDir: null,
			lastError: null,
		};
		this.repo.createSession(session);
		try {
			const audioDir = this.storage.getAudioDir(session.id);
			await this.storage.ensureDir(audioDir);
			await convert(audioDir);
			const totalSec = await this.registerChunks(session.id);
			if (totalSec <= 0) throw new EmptyImportError();
			assertTransition(session.status, "stopped");
			const endedAt = new Date(now.getTime() + totalSec * 1000).toISOString();
			this.repo.updateSession(session.id, { status: "stopped", endedAt });
			logger.info(`Import finished: session ${session.id} (${totalSec.toFixed(1)} s)`);
			return { ...session, status: "stopped", endedAt };
		} catch (err) {
			await this.discard(session.id);
			throw err;
		}
	}

	/** Adds a chunk row per converted WAV (in name order). Returns the total duration. */
	private async registerChunks(sessionId: string): Promise<number> {
		const files = await this.storage.listAudioFiles(sessionId);
		let totalSec = 0;
		let index = 0;
		for (const file of files) {
			const info = this.safeInfo(file);
			if (!info) continue; // not a usable WAV
			totalSec += info.durationSec;
			this.repo.addChunk({
				id: randomUUID(),
				sessionId,
				index: index++,
				path: file,
				durationMs: Math.round(info.durationSec * 1000),
				sampleRate: info.sampleRate,
				status: "recorded",
			});
		}
		return totalSec;
	}

	private safeInfo(file: string): ImportedWavInfo | null {
		try {
			return this.readWavInfo(file);
		} catch {
			return null;
		}
	}

	private async discard(sessionId: string): Promise<void> {
		try {
			this.repo.deleteSession(sessionId);
			await this.storage.removeSessionDir(sessionId);
		} catch {
			// best effort
		}
	}
}
