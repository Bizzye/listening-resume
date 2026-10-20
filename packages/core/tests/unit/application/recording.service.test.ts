import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeCaptureAdapter } from "../../../src/adapters/audio/fake-capture.js";
import { LocalFileStorage } from "../../../src/adapters/persistence/local-files.js";
import { SQLiteRepository } from "../../../src/adapters/persistence/sqlite.js";
import {
	audioSourceLabel,
	LIVE_RECORDING_WINDOW_MS,
	RecordingService,
	usedSources,
} from "../../../src/application/recording.service.js";
import {
	AudioCaptureError,
	ConflictError,
	NotRecordingError,
	RecordingInProgressError,
} from "../../../src/domain/errors.js";
import { writeWavHeader } from "../../../src/utils/wav.js";

/** A promise plus its resolve/reject, to hold an async step open in a test. */
function deferred<T = void>() {
	let resolve!: (value: T) => void;
	let reject!: (err: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

import { backdateFiles, makeSession, makeTempDir, writeToneWav } from "../../helpers.js";

const devices = { system: "@default", mic: "@default" };

describe("RecordingService", () => {
	let dir: string;
	let cleanup: () => void;
	let repo: SQLiteRepository;
	let storage: LocalFileStorage;
	let capture: FakeCaptureAdapter;
	let service: RecordingService;

	beforeEach(() => {
		({ dir, cleanup } = makeTempDir());
		repo = new SQLiteRepository(":memory:");
		storage = new LocalFileStorage(dir);
		capture = new FakeCaptureAdapter({ realtime: false });
		service = new RecordingService({
			capture,
			repo,
			storage,
			audio: { sampleRate: 16000, channels: 1, chunkSeconds: 10, micVolume: 1.2 },
		});
	});
	afterEach(() => {
		repo.close();
		cleanup();
	});

	it("start creates a recording session and exposes the active state", async () => {
		const before = Date.now();
		const session = await service.start({ devices });
		expect(session).toMatchObject({
			status: "recording",
			audioSource: "Áudio do sistema + Microfone",
			exportDir: null,
			lastError: null,
		});
		expect(session.title).toMatch(/^Gravação /);
		expect(repo.getSession(session.id)?.status).toBe("recording");

		const active = service.getActive();
		expect(active).toMatchObject({
			sessionId: session.id,
			chunks: 0,
			muted: { system: false, mic: false },
		});
		expect(active?.startedAt).toBeGreaterThanOrEqual(before);
		expect(active?.devices?.systemName).toBe("Alto-falantes (Realtek(R) Audio)");
		await service.stop();
	});

	it("uses the given title and a system-only source label", async () => {
		const session = await service.start({
			devices: { system: "@default", mic: null },
			title: " Aula 12 ",
		});
		expect(session.title).toBe("Aula 12");
		expect(session.audioSource).toBe("Áudio do sistema");
		await service.stop();
	});

	it("rejects a second start with RecordingInProgressError (409)", async () => {
		const session = await service.start({ devices });
		const err = await service.start({ devices }).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(RecordingInProgressError);
		expect((err as RecordingInProgressError).sessionId).toBe(session.id);
		await service.stop();
	});

	it("registers chunks with real durations and stops the session", async () => {
		const session = await service.start({ devices });
		capture.advance(25);
		expect(service.getActive()?.chunks).toBe(2);

		const { session: stopped, chunks } = await service.stop();
		expect(chunks).toBe(3);
		expect(stopped).toMatchObject({ id: session.id, status: "stopped", lastError: null });
		expect(stopped.endedAt).not.toBeNull();
		const rows = repo.getChunks(session.id);
		expect(rows.map((c) => c.durationMs)).toEqual([10000, 10000, 5000]);
		expect(rows.every((c) => c.sampleRate === 16000 && c.status === "recorded")).toBe(true);
		expect(service.getActive()).toBeNull();
	});

	it("marks a recording without audio as failed", async () => {
		const session = await service.start({ devices });
		const { chunks } = await service.stop();
		expect(chunks).toBe(0);
		expect(repo.getSession(session.id)).toMatchObject({
			status: "failed",
			lastError: "Nenhum áudio foi gravado.",
		});
	});

	it("discard removes the session and its files", async () => {
		const session = await service.start({ devices });
		capture.advance(12);
		const sessionDir = storage.getSessionDir(session.id);
		expect(fs.existsSync(sessionDir)).toBe(true);
		await service.discard();
		expect(repo.getSession(session.id)).toBeNull();
		expect(repo.getChunks(session.id)).toEqual([]);
		expect(fs.existsSync(sessionDir)).toBe(false);
		expect(service.getActive()).toBeNull();
	});

	it("mute / switch / levels pass through while recording", async () => {
		await service.start({ devices });
		await service.setMute("mic", true);
		expect(service.getActive()?.muted).toEqual({ system: false, mic: true });

		const changed = vi.fn();
		const off = service.onDeviceChange(changed);
		const resolved = await service.switchDevices({ system: "Fones de ouvido (WH-1000XM4)" });
		expect(resolved.systemName).toBe("Fones de ouvido (WH-1000XM4)");
		expect(changed).toHaveBeenCalledTimes(1);
		expect(service.getActive()?.devices?.system).toBe("Fones de ouvido (WH-1000XM4)");
		off();

		const levels = vi.fn();
		service.onLevels(levels);
		capture.advance(0.1);
		expect(levels).toHaveBeenCalledWith(expect.objectContaining({ mic: 0 }));
		await service.stop();
	});

	describe("audioSource", () => {
		it("labels a mic-only recording (system 'none')", async () => {
			const session = await service.start({ devices: { system: "none", mic: "@default" } });
			expect(session.audioSource).toBe("Microfone");
			await service.discard();
		});

		it("widens the label when a mic is added live, and keeps it after removal", async () => {
			const session = await service.start({ devices: { system: "@default", mic: null } });
			expect(repo.getSession(session.id)?.audioSource).toBe("Áudio do sistema");

			await service.switchDevices({ mic: "@default" });
			expect(repo.getSession(session.id)?.audioSource).toBe("Áudio do sistema + Microfone");

			await service.switchDevices({ mic: null }); // the mic was still part of the recording
			capture.advance(1);
			const { session: stopped } = await service.stop();
			expect(stopped.audioSource).toBe("Áudio do sistema + Microfone");
		});

		it("adds the system audio to a mic-only recording", async () => {
			const session = await service.start({ devices: { system: "none", mic: "@default" } });
			await service.switchDevices({ system: "@default" });
			expect(repo.getSession(session.id)?.audioSource).toBe("Áudio do sistema + Microfone");
			await service.discard();
		});

		it("does not rewrite the session when the sources stay the same", async () => {
			const session = await service.start({ devices: { system: "@default", mic: null } });
			const update = vi.spyOn(repo, "updateSession");
			await service.switchDevices({ system: "Fones de ouvido (WH-1000XM4)" });
			expect(update).not.toHaveBeenCalled();
			update.mockRestore();
			expect(repo.getSession(session.id)?.audioSource).toBe("Áudio do sistema");
			await service.discard();
		});

		it("audioSourceLabel covers every combination", () => {
			expect(audioSourceLabel({ system: true, mic: true })).toBe("Áudio do sistema + Microfone");
			expect(audioSourceLabel({ system: true, mic: false })).toBe("Áudio do sistema");
			expect(audioSourceLabel({ system: false, mic: true })).toBe("Microfone");
			expect(audioSourceLabel({ system: false, mic: false })).toBe("Sem fonte de áudio");
			expect(usedSources({ system: " None ", mic: "Mic" })).toEqual({ system: false, mic: true });
			expect(usedSources({ system: "@default", mic: null })).toEqual({
				system: true,
				mic: false,
			});
		});
	});

	it("forwards capture warnings while recording", async () => {
		await service.start({ devices });
		const warned = vi.fn();
		const off = service.onWarning(warned);
		capture.simulateWarning("device lost");
		expect(warned).toHaveBeenCalledWith("device lost");
		off();
		capture.simulateWarning("again");
		expect(warned).toHaveBeenCalledTimes(1);
		await service.discard();
	});

	it("operations without an active recording throw NotRecordingError", async () => {
		await expect(service.stop()).rejects.toBeInstanceOf(NotRecordingError);
		await expect(service.discard()).rejects.toBeInstanceOf(NotRecordingError);
		await expect(service.setMute("mic", true)).rejects.toBeInstanceOf(NotRecordingError);
		await expect(service.switchDevices({ mic: null })).rejects.toBeInstanceOf(NotRecordingError);
		expect(service.getActive()).toBeNull();
	});

	it("a failed capture start leaves no session behind and frees the slot", async () => {
		vi.spyOn(capture, "startCapture").mockRejectedValueOnce(new Error("device busy"));
		await expect(service.start({ devices })).rejects.toBeInstanceOf(AudioCaptureError);
		expect(repo.listSessions()).toEqual([]);
		const sessionsDir = path.join(dir, "sessions");
		expect(fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir) : []).toEqual([]);
		const session = await service.start({ devices });
		expect(session.status).toBe("recording");
		await service.stop();
	});

	it("settles the session when the capture dies mid-recording", async () => {
		const interrupted = vi.fn();
		service.onInterrupted(interrupted);
		const session = await service.start({ devices });
		capture.advance(10);
		capture.simulateCrash("dispositivo removido");
		await vi.waitFor(() => expect(interrupted).toHaveBeenCalled());
		expect(repo.getSession(session.id)).toMatchObject({
			status: "stopped",
			lastError: "A gravação foi interrompida: dispositivo removido",
		});
		expect(service.getActive()).toBeNull();
	});

	describe("concurrency", () => {
		/** Makes `capture.startCapture` wait until the returned gate is released. */
		function gateStart() {
			const gate = deferred();
			gate.promise.catch(() => {}); // may be rejected before the capture awaits it
			const real = capture.startCapture.bind(capture);
			vi.spyOn(capture, "startCapture").mockImplementationOnce(async (opts) => {
				await gate.promise;
				await real(opts);
			});
			return gate;
		}

		it("concurrent stop() calls share one result and never duplicate chunk rows", async () => {
			const session = await service.start({ devices });
			capture.advance(15);
			const [a, b] = await Promise.all([service.stop(), service.stop()]);
			expect(a).toEqual(b);
			expect(a.chunks).toBe(2);
			const rows = repo.getChunks(session.id);
			expect(rows).toHaveLength(2);
			expect(new Set(rows.map((r) => r.path)).size).toBe(2);
			expect(service.getActive()).toBeNull();
			await expect(service.stop()).rejects.toBeInstanceOf(NotRecordingError);
		});

		it("stop() during a pending start waits for it, then stops", async () => {
			const gate = gateStart();
			const starting = service.start({ devices });
			await vi.waitFor(() => expect(service.getActive()?.phase).toBe("starting"));
			// A second start is still refused while the first is starting.
			await expect(service.start({ devices })).rejects.toBeInstanceOf(RecordingInProgressError);

			const stopping = service.stop();
			gate.resolve();
			const session = await starting;
			const { session: stopped } = await stopping;
			expect(stopped.id).toBe(session.id);
			expect(stopped.status).toBe("failed"); // no audio captured
			expect(capture.isCapturing).toBe(false); // no orphan capture left running
			expect(service.getActive()).toBeNull();
			// The slot is usable again.
			await service.start({ devices });
			await service.stop();
		});

		it("discard() during a pending start waits for it, then deletes everything", async () => {
			const gate = gateStart();
			const starting = service.start({ devices });
			await vi.waitFor(() => expect(service.getActive()).not.toBeNull());
			const discarding = service.discard();
			gate.resolve();
			const session = await starting;
			await discarding;
			expect(repo.getSession(session.id)).toBeNull();
			expect(fs.existsSync(storage.getSessionDir(session.id))).toBe(false);
			expect(capture.isCapturing).toBe(false);
			expect(service.getActive()).toBeNull();
		});

		it("stop() during a start that fails rejects with NotRecordingError", async () => {
			const gate = gateStart();
			const starting = service.start({ devices });
			await vi.waitFor(() => expect(service.getActive()).not.toBeNull());
			const stopping = service.stop().catch((e: unknown) => e);
			gate.reject(new Error("device busy"));
			await expect(starting).rejects.toBeInstanceOf(AudioCaptureError);
			expect(await stopping).toBeInstanceOf(NotRecordingError);
			expect(repo.listSessions()).toEqual([]);
			expect(service.getActive()).toBeNull();
		});

		it("mute during a pending start applies once the capture runs", async () => {
			const gate = gateStart();
			const starting = service.start({ devices });
			await vi.waitFor(() => expect(service.getActive()).not.toBeNull());
			const muting = service.setMute("mic", true);
			gate.resolve();
			await starting;
			await muting;
			expect(service.getActive()?.muted.mic).toBe(true);
			await service.stop();
		});

		it("stop and discard exclude each other", async () => {
			await service.start({ devices });
			const stopping = service.stop();
			await expect(service.discard()).rejects.toBeInstanceOf(ConflictError);
			await stopping;

			await service.start({ devices });
			const discarding = service.discard();
			await expect(service.stop()).rejects.toBeInstanceOf(ConflictError);
			await discarding;
			expect(service.getActive()).toBeNull();
		});

		it("does not count chunks dropped as too short", async () => {
			const session = await service.start({ devices });
			capture.advance(10.05); // one full chunk + a 50 ms tail
			const { chunks } = await service.stop();
			expect(chunks).toBe(1);
			expect(repo.getChunks(session.id)).toHaveLength(1);
		});

		it("a stop racing a capture failure returns the settled session", async () => {
			const session = await service.start({ devices });
			capture.advance(10);
			capture.simulateCrash("cabo removido");
			const result = await service.stop();
			expect(result.session).toMatchObject({
				id: session.id,
				status: "stopped",
				lastError: "A gravação foi interrompida: cabo removido",
			});
			expect(result.chunks).toBe(1);
		});
	});

	describe("reconcileInterrupted", () => {
		it("settles every transient state", async () => {
			const recWithAudio = makeSession({ status: "recording", endedAt: null });
			const recEmpty = makeSession({ status: "recording", endedAt: null });
			const transcribing = makeSession({ status: "transcribing" });
			const retranscribing = makeSession({ status: "transcribing" });
			const analyzingNoAnalyses = makeSession({ status: "analyzing" });
			const analyzingWithAnalyses = makeSession({ status: "analyzing" });
			const analyzingNoTranscript = makeSession({ status: "analyzing" });
			const done = makeSession({ status: "completed" });
			for (const s of [
				recWithAudio,
				recEmpty,
				transcribing,
				retranscribing,
				analyzingNoAnalyses,
				analyzingWithAnalyses,
				analyzingNoTranscript,
				done,
			]) {
				repo.createSession(s);
			}

			// Recording crashed before its last chunk was registered, header never finalized.
			const orphan = writeToneWav(
				path.join(storage.getAudioDir(recWithAudio.id), "chunk_0000.wav"),
				2,
			);
			const fd = fs.openSync(orphan, "r+");
			writeWavHeader(fd, { sampleRate: 16000, channels: 1, bitsPerSample: 16 }, 0);
			fs.closeSync(fd);
			backdateFiles(storage.getAudioDir(recWithAudio.id)); // crashed a while ago

			repo.addChunk({
				id: "c-tr",
				sessionId: transcribing.id,
				index: 0,
				path: "x.wav",
				durationMs: 1000,
				sampleRate: 16000,
				status: "recorded",
			});
			const transcript = {
				segments: [],
				fullText: "texto",
				language: "pt",
				provider: "fake",
				model: "fake",
				createdAt: new Date().toISOString(),
			};
			repo.saveTranscript({ ...transcript, id: "t1", sessionId: analyzingNoAnalyses.id });
			repo.saveTranscript({ ...transcript, id: "t2", sessionId: analyzingWithAnalyses.id });
			repo.saveTranscript({ ...transcript, id: "t3", sessionId: retranscribing.id });
			repo.saveAnalysis({
				id: "a1",
				sessionId: analyzingWithAnalyses.id,
				templateId: "resumo-executivo",
				provider: "fake",
				model: "fake",
				content: "x",
				createdAt: new Date().toISOString(),
			});

			const results = await service.reconcileInterrupted();
			const to = Object.fromEntries(results.map((r) => [r.sessionId, r.to]));
			expect(to).toEqual({
				[recWithAudio.id]: "stopped",
				[recEmpty.id]: "failed",
				[transcribing.id]: "stopped",
				[retranscribing.id]: "transcribed", // the earlier transcript is kept
				[analyzingNoAnalyses.id]: "transcribed",
				[analyzingWithAnalyses.id]: "completed",
				[analyzingNoTranscript.id]: "stopped",
			});

			const recovered = repo.getChunks(recWithAudio.id);
			expect(recovered).toHaveLength(1);
			expect(recovered[0].durationMs).toBe(2000);
			expect(fs.readFileSync(orphan).readUInt32LE(40)).toBe(64000); // header repaired
			expect(repo.getSession(recWithAudio.id)?.endedAt).not.toBeNull();
			expect(repo.getSession(recEmpty.id)?.lastError).toMatch(/interrompida/);
			expect(repo.getSession(transcribing.id)?.lastError).toMatch(/Tente novamente/);
			expect(repo.getSession(done.id)?.status).toBe("completed");

			expect(await service.reconcileInterrupted()).toEqual([]); // idempotent
		});

		it("never touches the session being recorded right now", async () => {
			const session = await service.start({ devices });
			expect(await service.reconcileInterrupted()).toEqual([]);
			expect(repo.getSession(session.id)?.status).toBe("recording");
			await service.stop();
		});

		describe("a recording live in another process (e.g. the CLI)", () => {
			const longAgo = new Date(Date.now() - 3_600_000).toISOString();

			it("skips it while its newest chunk was written in the last 10 s", async () => {
				const live = makeSession({ status: "recording", startedAt: longAgo, endedAt: null });
				repo.createSession(live);
				const audioDir = storage.getAudioDir(live.id);
				writeToneWav(path.join(audioDir, "chunk_0000.wav"), 1);
				backdateFiles(audioDir);
				writeToneWav(path.join(audioDir, "chunk_0001.wav"), 1); // fresh: header just flushed

				expect(await service.reconcileInterrupted()).toEqual([]);
				expect(repo.getSession(live.id)?.status).toBe("recording");
				expect(repo.getChunks(live.id)).toHaveLength(0);
			});

			it("settles it once the newest chunk is older than the window", async () => {
				const stale = makeSession({ status: "recording", startedAt: longAgo, endedAt: null });
				repo.createSession(stale);
				const audioDir = storage.getAudioDir(stale.id);
				writeToneWav(path.join(audioDir, "chunk_0000.wav"), 1);
				const at = Date.now() - LIVE_RECORDING_WINDOW_MS - 1000;
				fs.utimesSync(path.join(audioDir, "chunk_0000.wav"), at / 1000, at / 1000);

				expect(await service.reconcileInterrupted()).toEqual([
					{ sessionId: stale.id, from: "recording", to: "stopped" },
				]);
			});

			it("skips one that just started and has no chunk file yet", async () => {
				const fresh = makeSession({
					status: "recording",
					startedAt: new Date().toISOString(),
					endedAt: null,
				});
				repo.createSession(fresh);
				expect(await service.reconcileInterrupted()).toEqual([]);
				expect(repo.getSession(fresh.id)?.status).toBe("recording");
			});

			it("settles one without chunks that started long ago as failed", async () => {
				const empty = makeSession({ status: "recording", startedAt: longAgo, endedAt: null });
				repo.createSession(empty);
				expect(await service.reconcileInterrupted()).toEqual([
					{ sessionId: empty.id, from: "recording", to: "failed" },
				]);
			});

			it("only applies to recording sessions (a fresh created import is settled)", async () => {
				const created = makeSession({
					status: "created",
					startedAt: new Date().toISOString(),
					endedAt: null,
				});
				repo.createSession(created);
				writeToneWav(path.join(storage.getAudioDir(created.id), "chunk_0000.wav"), 1);
				expect(await service.reconcileInterrupted()).toEqual([
					{ sessionId: created.id, from: "created", to: "stopped" },
				]);
			});
		});
	});
});
