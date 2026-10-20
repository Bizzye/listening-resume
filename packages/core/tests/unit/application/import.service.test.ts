import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalFileStorage } from "../../../src/adapters/persistence/local-files.js";
import { SQLiteRepository } from "../../../src/adapters/persistence/sqlite.js";
import { EmptyImportError, ImportService } from "../../../src/application/import.service.js";
import { ValidationError } from "../../../src/domain/errors.js";
import { makeTempDir, writeToneWav } from "../../helpers.js";

const request = { title: "Aula 03", audioSource: "Arquivo importado · .mp4" };
const NOW = new Date("2026-01-02T10:00:00.000Z");

describe("ImportService", () => {
	let dir: string;
	let cleanup: () => void;
	let repo: SQLiteRepository;
	let storage: LocalFileStorage;
	let service: ImportService;

	beforeEach(() => {
		({ dir, cleanup } = makeTempDir());
		repo = new SQLiteRepository(":memory:");
		storage = new LocalFileStorage(dir);
		service = new ImportService({ repo, storage, newId: () => "imp-1", now: () => NOW });
	});
	afterEach(() => {
		repo.close();
		cleanup();
	});

	it("creates a hidden `created` session while converting, then settles it as stopped", async () => {
		let seenDir = "";
		const session = await service.importAudio(request, async (audioDir) => {
			seenDir = audioDir;
			expect(fs.existsSync(audioDir)).toBe(true);
			expect(repo.getSession("imp-1")?.status).toBe("created");
			writeToneWav(path.join(audioDir, "chunk_0000.wav"), 5);
			writeToneWav(path.join(audioDir, "chunk_0001.wav"), 2);
		});

		expect(seenDir).toBe(storage.getAudioDir("imp-1"));
		expect(session).toMatchObject({
			id: "imp-1",
			title: "Aula 03",
			status: "stopped",
			audioSource: "Arquivo importado · .mp4",
			startedAt: NOW.toISOString(),
			endedAt: "2026-01-02T10:00:07.000Z",
		});
		expect(repo.getSession("imp-1")).toMatchObject({
			status: "stopped",
			endedAt: "2026-01-02T10:00:07.000Z",
		});
		const chunks = repo.getChunks("imp-1");
		expect(chunks.map((c) => [c.index, c.durationMs, c.sampleRate])).toEqual([
			[0, 5000, 16000],
			[1, 2000, 16000],
		]);
	});

	it("skips unreadable files and keeps chunk indexes contiguous", async () => {
		await service.importAudio(request, async (audioDir) => {
			writeToneWav(path.join(audioDir, "chunk_0000.wav"), 1);
			fs.writeFileSync(path.join(audioDir, "chunk_0001.wav"), "not a wav");
			writeToneWav(path.join(audioDir, "chunk_0002.wav"), 1);
		});
		const chunks = repo.getChunks("imp-1");
		expect(chunks.map((c) => [c.index, path.basename(c.path)])).toEqual([
			[0, "chunk_0000.wav"],
			[1, "chunk_0002.wav"],
		]);
	});

	it("uses an injected header reader (a throwing one counts as unreadable)", async () => {
		const custom = new ImportService({
			repo,
			storage,
			newId: () => "imp-2",
			now: () => NOW,
			readWavInfo: (file) => {
				if (file.endsWith("0001.wav")) throw new Error("bad header");
				return { durationSec: 3, sampleRate: 48000 };
			},
		});
		const session = await custom.importAudio(request, async (audioDir) => {
			fs.writeFileSync(path.join(audioDir, "chunk_0000.wav"), "");
			fs.writeFileSync(path.join(audioDir, "chunk_0001.wav"), "");
		});
		expect(session.endedAt).toBe("2026-01-02T10:00:03.000Z");
		expect(repo.getChunks("imp-2").map((c) => c.sampleRate)).toEqual([48000]);
	});

	it("rejects a conversion without audio with EmptyImportError and leaves nothing behind", async () => {
		const empty = service.importAudio(request, async () => {});
		await expect(empty).rejects.toBeInstanceOf(EmptyImportError);
		await expect(empty).rejects.toBeInstanceOf(ValidationError);
		await expect(empty).rejects.toThrow("O arquivo não contém áudio");
		expect(repo.getSession("imp-1")).toBeNull();
		expect(fs.existsSync(storage.getSessionDir("imp-1"))).toBe(false);
	});

	it("treats zero-length audio as empty", async () => {
		await expect(
			service.importAudio(request, async (audioDir) => {
				writeToneWav(path.join(audioDir, "chunk_0000.wav"), 0);
			}),
		).rejects.toBeInstanceOf(EmptyImportError);
		expect(repo.getSession("imp-1")).toBeNull();
	});

	it("propagates a conversion failure unchanged and removes the session and files", async () => {
		const boom = new Error("ffmpeg exploded");
		await expect(
			service.importAudio(request, async (audioDir) => {
				writeToneWav(path.join(audioDir, "chunk_0000.wav"), 1);
				throw boom;
			}),
		).rejects.toBe(boom);
		expect(repo.getSession("imp-1")).toBeNull();
		expect(repo.getChunks("imp-1")).toEqual([]);
		expect(fs.existsSync(storage.getSessionDir("imp-1"))).toBe(false);
	});

	it("defaults the id and clock", async () => {
		const plain = new ImportService({ repo, storage });
		const before = Date.now();
		const session = await plain.importAudio(request, async (audioDir) => {
			writeToneWav(path.join(audioDir, "chunk_0000.wav"), 1);
		});
		expect(session.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(Date.parse(session.startedAt ?? "")).toBeGreaterThanOrEqual(before - 1);
	});
});
