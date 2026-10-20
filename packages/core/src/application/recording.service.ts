import { randomUUID } from "node:crypto";
import {
	AudioCaptureError,
	ConflictError,
	DomainError,
	errorMessage,
	NotRecordingError,
	RecordingInProgressError,
} from "../domain/errors.js";
import type { Session, SessionStatus } from "../domain/models.js";
import { TRANSIENT_STATUSES } from "../domain/states.js";
import type {
	AudioCapturePort,
	AudioLevels,
	CaptureDevices,
	CaptureSource,
	ChunkInfo,
	ResolvedDevices,
} from "../ports/audio-capture.js";
import type { FileStoragePort } from "../ports/file-storage.js";
import type { SessionRepository } from "../ports/repository.js";
import { Listeners } from "../utils/listeners.js";
import { logger } from "../utils/logger.js";
import { repairWavHeader, tryReadWavInfo } from "../utils/wav.js";
import { statusFromArtifacts } from "./session-status.js";

export interface RecordingAudioConfig {
	/** Output WAV sample rate. */
	sampleRate: number;
	channels: number;
	chunkSeconds: number;
	/** Mic gain in the mix, 0..2 (default `DEFAULT_MIC_VOLUME`). */
	micVolume?: number;
}

export interface RecordingServiceDeps {
	capture: AudioCapturePort;
	repo: SessionRepository;
	storage: FileStoragePort;
	audio: RecordingAudioConfig;
}

export interface StartRecordingOptions {
	devices: CaptureDevices;
	/** Default: "Gravação dd/mm/aaaa, hh:mm". */
	title?: string;
}

/**
 * `starting`: the capture is being launched; `recording`: running; `stopping`: being stopped,
 * discarded or settled after a capture failure.
 */
export type RecordingPhase = "starting" | "recording" | "stopping";

export interface ActiveRecording {
	sessionId: string;
	/** Epoch ms. */
	startedAt: number;
	chunks: number;
	devices: ResolvedDevices | null;
	muted: Record<CaptureSource, boolean>;
	phase: RecordingPhase;
}

export interface StopRecordingResult {
	session: Session;
	chunks: number;
}

export interface ReconciledSession {
	sessionId: string;
	from: SessionStatus;
	to: SessionStatus;
}

interface ActiveState {
	sessionId: string;
	startedAt: number;
	phase: RecordingPhase;
	/** Chunk paths already handled (registered, or dropped as too short). */
	seen: Set<string>;
	/** Registered chunk rows. */
	chunks: number;
	/** Sources captured at any point of the recording (drives `Session.audioSource`). */
	used: UsedSources;
	/** Settles when `start()` finished: resolves when running, rejects when it failed. */
	started: Promise<void>;
	/** The one in-flight way out of this recording (memoized: concurrent calls share it). */
	ending: { kind: "stop" | "discard"; promise: Promise<StopRecordingResult | undefined> } | null;
}

/** Which sources a recording captured (at any point). */
export interface UsedSources {
	system: boolean;
	mic: boolean;
}

/** A system "device" of `none` = no system audio (mic-only recording). */
const isNoDevice = (id: string | null): boolean => !id || id.trim().toLowerCase() === "none";

export function usedSources(devices: CaptureDevices): UsedSources {
	return { system: !isNoDevice(devices.system), mic: !isNoDevice(devices.mic) };
}

/** pt-BR description of where a recording's audio came from (`Session.audioSource`). Pure. */
export function audioSourceLabel(used: UsedSources): string {
	if (used.system && used.mic) return "Áudio do sistema + Microfone";
	if (used.mic) return "Microfone";
	if (used.system) return "Áudio do sistema";
	return "Sem fonte de áudio";
}

/**
 * A `recording` session whose newest chunk changed this recently (or that started this
 * recently, before its first chunk exists) is being recorded by ANOTHER process (e.g. the CLI):
 * the capture binary rewrites the WAV header every second, so a live recording keeps it fresh.
 */
export const LIVE_RECORDING_WINDOW_MS = 10_000;

/** Chunks shorter than this are capture artifacts (e.g. stopped right at a boundary). */
const MIN_CHUNK_SECONDS = 0.1;

const NO_AUDIO = "Nenhum áudio foi gravado.";
const INTERRUPTED_NO_AUDIO = "A gravação foi interrompida antes de salvar qualquer áudio.";

export function defaultRecordingTitle(date: Date): string {
	const stamp = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(
		date,
	);
	return `Gravação ${stamp}`;
}

/**
 * Owns the single active recording: session lifecycle, chunk bookkeeping (durations from the
 * WAV headers), live mute/device switching passthroughs, and crash recovery.
 *
 * Concurrency: `start()` claims the slot synchronously (a second start gets a 409). `stop()` /
 * `discard()` during `starting` wait for the start to finish; concurrent `stop()` calls share
 * one promise; `stop()` and `discard()` exclude each other (409).
 */
export class RecordingService {
	private readonly capture: AudioCapturePort;
	private readonly repo: SessionRepository;
	private readonly storage: FileStoragePort;
	private readonly audio: RecordingAudioConfig;
	private active: ActiveState | null = null;
	private readonly interrupted = new Listeners<Session>();

	constructor(deps: RecordingServiceDeps) {
		this.capture = deps.capture;
		this.repo = deps.repo;
		this.storage = deps.storage;
		this.audio = deps.audio;
		this.capture.onChunkReady((info) => {
			if (this.active) this.registerChunk(this.active, info.path, info.index);
		});
		this.capture.onError((err) => this.handleCaptureFailure(err));
	}

	async start(options: StartRecordingOptions): Promise<Session> {
		if (this.active) throw new RecordingInProgressError(this.active.sessionId);

		const now = new Date();
		const session: Session = {
			id: randomUUID(),
			title: options.title?.trim() || defaultRecordingTitle(now),
			status: "recording",
			startedAt: now.toISOString(),
			endedAt: null,
			audioSource: audioSourceLabel(usedSources(options.devices)),
			language: "auto",
			createdAt: now.toISOString(),
			exportDir: null,
			lastError: null,
		};
		let markStarted: () => void = () => {};
		let markFailed: (err: Error) => void = () => {};
		const started = new Promise<void>((resolve, reject) => {
			markStarted = resolve;
			markFailed = reject;
		});
		started.catch(() => {}); // observed by stop()/discard() only when they wait for it
		// Claim the slot before awaiting, so a concurrent start gets a 409.
		const state: ActiveState = {
			sessionId: session.id,
			startedAt: now.getTime(),
			phase: "starting",
			seen: new Set(),
			chunks: 0,
			used: usedSources(options.devices),
			started,
			ending: null,
		};
		this.active = state;

		try {
			const audioDir = this.storage.getAudioDir(session.id);
			await this.storage.ensureDir(audioDir);
			this.repo.createSession(session);
			await this.capture.startCapture({
				devices: options.devices,
				micVolume: this.audio.micVolume,
				sampleRate: this.audio.sampleRate,
				channels: this.audio.channels,
				chunkSeconds: this.audio.chunkSeconds,
				outputDir: audioDir,
				filenamePrefix: "chunk",
			});
		} catch (err) {
			if (this.active === state) this.active = null;
			// A recording that never started leaves nothing behind.
			this.repo.deleteSession(session.id);
			await this.storage.removeSessionDir(session.id).catch(() => {});
			const error =
				err instanceof DomainError
					? err
					: new AudioCaptureError(`Não foi possível iniciar a gravação: ${errorMessage(err)}`);
			markFailed(error);
			throw error;
		}
		state.phase = "recording";
		state.startedAt = Date.now();
		markStarted();
		logger.info(`Recording started: session ${session.id}`);
		return session;
	}

	/** Stops the capture and settles the session (`stopped`, or `failed` without audio). */
	stop(): Promise<StopRecordingResult> {
		const state = this.active;
		if (!state) return Promise.reject(new NotRecordingError());
		if (state.ending) {
			if (state.ending.kind === "discard") {
				return Promise.reject(new ConflictError("A gravação está sendo descartada."));
			}
			return state.ending.promise as Promise<StopRecordingResult>;
		}
		const promise = this.finish(state, async () => {
			let reported: ChunkInfo[] = [];
			try {
				reported = await this.capture.stopCapture();
			} catch (err) {
				// Still settle the session with whatever reached the disk.
				logger.error(`stopCapture failed: ${errorMessage(err)}`);
			}
			return this.settle(state, reported, null);
		});
		state.ending = { kind: "stop", promise };
		return promise;
	}

	/** Stops the capture and deletes the session with all its files. */
	discard(): Promise<void> {
		const state = this.active;
		if (!state) return Promise.reject(new NotRecordingError());
		if (state.ending) {
			if (state.ending.kind === "stop") {
				return Promise.reject(new ConflictError("A gravação já está sendo finalizada."));
			}
			return state.ending.promise.then(() => undefined);
		}
		const promise = this.finish(state, async () => {
			try {
				await this.capture.stopCapture();
			} catch (err) {
				logger.error(`stopCapture failed while discarding: ${errorMessage(err)}`);
			}
			this.repo.deleteSession(state.sessionId);
			await this.storage.removeSessionDir(state.sessionId);
			logger.info(`Recording discarded: session ${state.sessionId}`);
			return undefined;
		});
		state.ending = { kind: "discard", promise };
		return promise.then(() => undefined);
	}

	/**
	 * Runs one ending of the recording once it is running (waits for a pending start; a start
	 * that fails means there is nothing to stop) and frees the slot afterwards.
	 */
	private async finish<T>(state: ActiveState, end: () => Promise<T>): Promise<T> {
		try {
			await state.started;
		} catch {
			throw new NotRecordingError();
		}
		state.phase = "stopping";
		try {
			return await end();
		} finally {
			if (this.active === state) this.active = null;
		}
	}

	/** Registers every chunk (reported + orphans on disk) and writes the final session status. */
	private async settle(
		state: ActiveState,
		reported: readonly ChunkInfo[],
		failure: string | null,
	): Promise<StopRecordingResult> {
		for (const info of reported) this.registerChunk(state, info.path, info.index);
		await this.registerOrphanFiles(state.sessionId, state);
		const chunks = this.repo.getChunks(state.sessionId).length;
		this.repo.updateSession(state.sessionId, {
			status: chunks > 0 ? "stopped" : "failed",
			audioSource: audioSourceLabel(state.used),
			endedAt: new Date().toISOString(),
			lastError: failure ?? (chunks > 0 ? null : NO_AUDIO),
		});
		logger.info(`Recording stopped: session ${state.sessionId} (${chunks} chunks)`);
		return { session: this.repo.getSession(state.sessionId) as Session, chunks };
	}

	getActive(): ActiveRecording | null {
		const state = this.active;
		if (!state) return null;
		return {
			sessionId: state.sessionId,
			startedAt: state.startedAt,
			chunks: state.chunks,
			devices: this.capture.getActiveDevices(),
			muted: this.capture.getInputMuteState(),
			phase: state.phase,
		};
	}

	async setMute(source: CaptureSource, muted: boolean): Promise<void> {
		await this.requireRunning();
		await this.capture.setInputMute(source, muted);
	}

	async switchDevices(devices: Partial<CaptureDevices>): Promise<ResolvedDevices> {
		await this.requireRunning();
		const state = this.active;
		const resolved = await this.capture.switchDevices(devices);
		if (state && this.active === state) this.noteSources(state, resolved);
		return resolved;
	}

	/** Widens the session's `audioSource` when a switch adds a source (e.g. a mic mid-recording). */
	private noteSources(state: ActiveState, devices: CaptureDevices): void {
		const now = usedSources(devices);
		const used = { system: state.used.system || now.system, mic: state.used.mic || now.mic };
		if (used.system === state.used.system && used.mic === state.used.mic) return;
		state.used = used;
		this.repo.updateSession(state.sessionId, { audioSource: audioSourceLabel(used) });
	}

	onLevels(cb: (levels: AudioLevels) => void): () => void {
		return this.capture.onLevels(cb);
	}

	onDeviceChange(cb: (devices: ResolvedDevices) => void): () => void {
		return this.capture.onDeviceChange(cb);
	}

	/** Non-fatal capture warnings (raw backend text; see `describeCaptureWarning`). */
	onWarning(cb: (message: string) => void): () => void {
		return this.capture.onWarning(cb);
	}

	/** Fired when the capture dies mid-recording (the session is already settled). */
	onInterrupted(cb: (session: Session) => void): () => void {
		return this.interrupted.on(cb);
	}

	/**
	 * Boot-time recovery: sessions left in a working state by a crash/restart are settled so
	 * the UI never shows an endless spinner. Audio written to disk but never registered (e.g.
	 * the last chunk, with a stale header) is recovered.
	 */
	async reconcileInterrupted(): Promise<ReconciledSession[]> {
		const results: ReconciledSession[] = [];
		const stale = this.repo.findSessionsByStatus(["created", ...TRANSIENT_STATUSES]);
		for (const session of stale) {
			if (session.id === this.active?.sessionId) continue;
			try {
				if (session.status === "recording" && (await this.isLiveElsewhere(session))) {
					logger.info(`reconcile: ${session.id} is being recorded by another process; skipped`);
					continue;
				}
				const to = await this.reconcileOne(session);
				results.push({ sessionId: session.id, from: session.status, to });
			} catch (err) {
				logger.error(`reconcile ${session.id}: ${errorMessage(err)}`);
			}
		}
		if (results.length > 0) logger.info(`Reconciled ${results.length} interrupted session(s)`);
		return results;
	}

	/** See `LIVE_RECORDING_WINDOW_MS`. */
	private async isLiveElsewhere(session: Session): Promise<boolean> {
		const now = Date.now();
		const files = await this.storage.listAudioFiles(session.id);
		if (files.length === 0) {
			const started = Date.parse(session.startedAt ?? session.createdAt);
			return Number.isFinite(started) && now - started < LIVE_RECORDING_WINDOW_MS;
		}
		const newest = Math.max(...files.map((f) => this.storage.modifiedAt(f) ?? 0));
		return now - newest < LIVE_RECORDING_WINDOW_MS;
	}

	private async reconcileOne(session: Session): Promise<SessionStatus> {
		const id = session.id;
		if (session.status === "created" || session.status === "recording") {
			await this.registerOrphanFiles(id);
			const hasAudio = this.repo.getChunks(id).length > 0;
			const to: SessionStatus = hasAudio ? "stopped" : "failed";
			this.repo.updateSession(id, {
				status: to,
				endedAt: session.endedAt ?? new Date().toISOString(),
				lastError: hasAudio ? null : INTERRUPTED_NO_AUDIO,
			});
			return to;
		}
		const previous = statusFromArtifacts(this.repo, id);
		if (session.status === "transcribing") {
			// A re-transcription keeps the earlier transcript (and analyses).
			const hasAudio = this.repo.getChunks(id).length > 0;
			const to: SessionStatus = previous ?? (hasAudio ? "stopped" : "failed");
			this.repo.updateSession(id, {
				status: to,
				lastError:
					previous || hasAudio
						? "A transcrição foi interrompida porque o aplicativo foi fechado. Tente novamente."
						: "Nenhum áudio foi gravado nesta sessão.",
			});
			return to;
		}
		// analyzing
		const to: SessionStatus = previous ?? "stopped";
		this.repo.updateSession(id, {
			status: to,
			lastError: "A análise foi interrompida porque o aplicativo foi fechado. Tente novamente.",
		});
		return to;
	}

	/** Waits out a pending start; throws `NotRecordingError` unless the capture is running. */
	private async requireRunning(): Promise<void> {
		const state = this.active;
		if (!state) throw new NotRecordingError();
		if (state.phase === "starting") {
			await state.started.catch(() => {
				throw new NotRecordingError();
			});
		}
		if (this.active !== state || state.phase !== "recording") throw new NotRecordingError();
	}

	/** Adds a chunk row once per path, counting it only when a row was actually written. */
	private registerChunk(state: ActiveState, filePath: string, index: number): void {
		if (state.seen.has(filePath)) return;
		state.seen.add(filePath);
		if (this.addChunkRow(state.sessionId, filePath, index)) state.chunks++;
	}

	/** Writes a chunk row with duration/sample rate from its WAV header. False when skipped. */
	private addChunkRow(sessionId: string, filePath: string, index: number): boolean {
		const info = tryReadWavInfo(filePath);
		if (!info && !this.storage.exists(filePath)) return false; // vanished
		if (info && info.durationSec < MIN_CHUNK_SECONDS) {
			void this.storage.removeFile(filePath).catch(() => {});
			return false;
		}
		const added = this.repo.addChunk({
			id: randomUUID(),
			sessionId,
			index,
			path: filePath,
			durationMs: info ? Math.round(info.durationSec * 1000) : null,
			sampleRate: info?.sampleRate ?? this.audio.sampleRate,
			status: "recorded",
		});
		if (added) logger.debug(`Chunk ${index} saved: ${filePath}`);
		return added;
	}

	/** Registers WAVs on disk that never got a chunk row, fixing stale headers first. */
	private async registerOrphanFiles(sessionId: string, state?: ActiveState): Promise<void> {
		const rows = this.repo.getChunks(sessionId);
		const known = new Set(rows.map((c) => c.path));
		let nextIndex = rows.reduce((max, c) => Math.max(max, c.index + 1), 0);
		for (const file of await this.storage.listAudioFiles(sessionId)) {
			if (known.has(file) || state?.seen.has(file)) continue;
			try {
				repairWavHeader(file);
			} catch {
				continue; // not a usable WAV
			}
			if (state) {
				const before = state.chunks;
				this.registerChunk(state, file, nextIndex);
				if (state.chunks > before) nextIndex++;
			} else if (this.addChunkRow(sessionId, file, nextIndex)) {
				nextIndex++;
			}
		}
	}

	/** The capture died mid-recording: settle the session and notify (once). */
	private handleCaptureFailure(err: Error): void {
		const state = this.active;
		if (!state || state.phase !== "recording" || state.ending) return;
		logger.error(`Capture failed during session ${state.sessionId}: ${err.message}`);
		state.phase = "stopping";
		const promise = (async () => {
			try {
				let reported: ChunkInfo[] = [];
				try {
					reported = await this.capture.stopCapture(); // collects chunks + resets the adapter
				} catch (inner) {
					logger.warn(`stopCapture after failure: ${errorMessage(inner)}`);
				}
				return await this.settle(state, reported, `A gravação foi interrompida: ${err.message}`);
			} finally {
				if (this.active === state) this.active = null;
			}
		})();
		state.ending = { kind: "stop", promise };
		promise.then(
			(result) => this.interrupted.emit(result.session),
			(inner) => logger.error(`Failed to settle interrupted session: ${errorMessage(inner)}`),
		);
	}
}
