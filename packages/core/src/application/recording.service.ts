import { closeSync, openSync, readSync, statSync } from "node:fs";
import { v4 as uuid } from "uuid";
import type { AudioChunk, Session } from "../domain/models.js";
import { assertTransition } from "../domain/states.js";
import type { AudioCapturePort, ChunkInfo } from "../ports/audio-capture.js";
import type { FileStoragePort } from "../ports/file-storage.js";
import type { SessionRepository } from "../ports/repository.js";
import { logger } from "../utils/logger.js";

export class RecordingService {
	constructor(
		private capture: AudioCapturePort,
		private repo: SessionRepository,
		private storage: FileStoragePort,
	) {}

	async startRecording(
		device: string,
		config: {
			sampleRate: number;
			channels: number;
			chunkSeconds: number;
			micDevice?: string;
			micVolume?: number;
		},
	): Promise<Session> {
		const sessionId = uuid();
		const now = new Date().toISOString();

		const session: Session = {
			id: sessionId,
			title: null,
			status: "created",
			startedAt: now,
			endedAt: null,
			audioSource: device,
			language: "auto",
			createdAt: now,
		};

		this.repo.createSession(session);
		assertTransition("created", "recording");
		this.repo.updateSession(sessionId, { status: "recording" });

		const sessionDir = this.storage.getSessionDir(sessionId);
		const audioDir = `${sessionDir}/audio`;
		await this.storage.ensureDir(audioDir);

		this.capture.onChunkReady((info) => {
			// Read actual WAV header to get real sample rate and channels.
			// wasapi adapter records at native device format (e.g. 48000 Hz stereo),
			// not at the requested config values, so config.sampleRate would be wrong.
			let durationMs: number;
			let actualSampleRate = config.sampleRate;
			try {
				const header = Buffer.alloc(44);
				const fd = openSync(info.path, "r");
				readSync(fd, header, 0, 44, 0);
				closeSync(fd);
				// WAV header offsets: channels@22, sampleRate@24, bitsPerSample@34, dataSize@40
				const sr = header.readUInt32LE(24);
				const ch = header.readUInt16LE(22);
				const bps = header.readUInt16LE(34);
				const dataBytes = header.readUInt32LE(40);
				if (sr > 0 && ch > 0 && bps > 0) {
					actualSampleRate = sr;
					durationMs = Math.round((dataBytes / (sr * ch * (bps / 8))) * 1000);
				} else {
					throw new Error("invalid WAV header");
				}
			} catch {
				const fileSize = statSync(info.path).size;
				durationMs = Math.round(
					((fileSize - 44) / (config.sampleRate * config.channels * 2)) * 1000,
				);
			}

			const chunk: AudioChunk = {
				id: uuid(),
				sessionId,
				index: info.index,
				path: info.path,
				durationMs,
				sampleRate: actualSampleRate,
				status: "recorded",
			};
			this.repo.addChunk(chunk);
			logger.info(`Chunk ${info.index} saved: ${info.path}`);
		});

		await this.capture.startCapture({
			device,
			micDevice: config.micDevice,
			micVolume: config.micVolume,
			sampleRate: config.sampleRate,
			channels: config.channels,
			chunkSeconds: config.chunkSeconds,
			outputDir: audioDir,
			filenamePrefix: "chunk",
		});

		session.status = "recording";
		return session;
	}

	async stopRecording(sessionId: string): Promise<ChunkInfo[]> {
		const chunks = await this.capture.stopCapture();
		const now = new Date().toISOString();

		this.repo.updateSession(sessionId, {
			status: "stopped",
			endedAt: now,
		});

		logger.info(`Recording stopped. ${chunks.length} chunks saved.`);
		return chunks;
	}
}
