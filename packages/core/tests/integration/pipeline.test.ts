import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeCaptureAdapter } from "../../src/adapters/audio/fake-capture.js";
import { buildExportDocument } from "../../src/adapters/export/export-document.js";
import { MarkdownExporter } from "../../src/adapters/export/markdown.js";
import { FakeAnalyzer } from "../../src/adapters/fake/fake-analyzer.js";
import { FakeTranscriber } from "../../src/adapters/fake/fake-transcriber.js";
import { LocalFileStorage } from "../../src/adapters/persistence/local-files.js";
import { SQLiteRepository } from "../../src/adapters/persistence/sqlite.js";
import { AnalysisService } from "../../src/application/analysis.service.js";
import { RecordingService } from "../../src/application/recording.service.js";
import { TranscriptionService } from "../../src/application/transcription.service.js";
import type { AnalysisTemplate } from "../../src/domain/models.js";
import { buildTranscriptPreview } from "../../src/domain/transcript.js";
import { BUILTIN_TEMPLATES, parseFlashcards } from "../../src/templates/index.js";
import { totalWavDurationSec } from "../../src/utils/wav.js";
import { backdateFiles, makeTempDir } from "../helpers.js";

describe("pipeline: record → transcribe → analyze → export (fakes, file-backed sqlite)", () => {
	let dir: string;
	let cleanup: () => void;
	let dbPath: string;
	let repo: SQLiteRepository;

	beforeEach(() => {
		({ dir, cleanup } = makeTempDir("lr-pipeline-"));
		dbPath = path.join(dir, "listening-resume.db");
		repo = new SQLiteRepository(dbPath);
	});
	afterEach(() => {
		repo.close();
		cleanup();
	});

	it("produces a complete, persisted and exportable session", async () => {
		const storage = new LocalFileStorage(dir);
		const capture = new FakeCaptureAdapter({ realtime: false });
		const recording = new RecordingService({
			capture,
			repo,
			storage,
			audio: { sampleRate: 16000, channels: 1, chunkSeconds: 20, micVolume: 1.2 },
		});

		// 1. Record 50 s with a live mic swap and a muted stretch.
		const session = await recording.start({
			devices: { system: "@default", mic: "@default" },
			title: "Reunião semanal",
		});
		capture.advance(15);
		await recording.switchDevices({ mic: "Microfone (USB Audio Device)" });
		await recording.setMute("system", true);
		capture.advance(15);
		await recording.setMute("system", false);
		capture.advance(20);
		const { chunks } = await recording.stop();
		expect(chunks).toBe(3);
		const files = await storage.listAudioFiles(session.id);
		expect(files.map((f) => path.basename(f))).toEqual([
			"chunk_0000.wav",
			"chunk_0001.wav",
			"chunk_0002.wav",
		]);
		expect(totalWavDurationSec(files)).toBeCloseTo(50, 3);

		// 2. Transcribe (Groq-like, rate limited).
		const transcription = new TranscriptionService(
			new FakeTranscriber({ rateLimited: true, segmentsPerChunk: 4 }),
			repo,
			{ requestsPerMinute: 18, audioSecondsPerHour: 7000 },
		);
		const transcript = await transcription.transcribeSession(session.id);
		expect(transcript.segments).toHaveLength(12);
		expect(transcript.segments.at(-1)?.end).toBeCloseTo(50, 3);
		expect(buildTranscriptPreview(transcript)).toMatch(/^Bom dia, pessoal\./);

		// 3. Analyze with every built-in template (+ a custom one).
		const analysis = new AnalysisService(
			new FakeAnalyzer({ available: false }),
			new FakeAnalyzer(),
			repo,
		);
		const custom = repo.createTemplate({
			name: "Revisão de Entrevista",
			description: "Avaliação por competência",
			prompt: "Avalie o candidato por competência.",
		});
		const templates: AnalysisTemplate[] = [...BUILTIN_TEMPLATES, custom];
		for (const template of templates) {
			await analysis.analyzeSession(session.id, template);
		}
		const flashcards = repo.getAnalyses(session.id).find((a) => a.templateId === "flashcards-anki");
		expect(parseFlashcards(flashcards?.content ?? "").length).toBeGreaterThanOrEqual(8);

		// 4. Reopen the database: everything is persisted.
		repo.close();
		repo = new SQLiteRepository(dbPath);
		const stored = repo.findSessionByIdPrefix(session.id.slice(0, 8));
		expect(stored).toMatchObject({
			status: "completed",
			title: "Reunião semanal",
			lastError: null,
		});
		expect(repo.countAnalyses(session.id)).toBe(templates.length);
		expect(repo.listSessions({ query: "cronograma" }).map((s) => s.id)).toEqual([session.id]);

		// 5. Export.
		const data = {
			session: stored ?? session,
			transcript: repo.getTranscript(session.id),
			analyses: repo.getAnalyses(session.id),
			templates: repo.listTemplates(),
			durationSec: totalWavDurationSec(files),
		};
		const doc = buildExportDocument(data);
		expect(doc.analyses.map((a) => a.heading)).toEqual(templates.map((t) => t.name));
		const md = await new MarkdownExporter().export(data);
		expect(md).toContain("# Reunião semanal");
		expect(md).toContain("**Duração:** 50 s");
		expect(md).toContain("## Ata de Reunião");
		expect(md).toContain("| Pergunta | Resposta |");
		expect(md).toContain("**[0:00]** Bom dia, pessoal.");
		const out = path.join(dir, `${doc.fileBaseName}.md`);
		fs.writeFileSync(out, md);
		expect(fs.existsSync(out)).toBe(true);
	});

	it("recovers after a crash on the next boot and can resume the pipeline", async () => {
		const storage = new LocalFileStorage(dir);
		const capture = new FakeCaptureAdapter({ realtime: false });
		const audio = { sampleRate: 16000, channels: 1, chunkSeconds: 10 };
		const first = new RecordingService({ capture, repo, storage, audio });
		const session = await first.start({ devices: { system: "@default", mic: null } });
		capture.advance(25); // 2 chunks finalized; the process "dies" before stop()
		backdateFiles(storage.getAudioDir(session.id)); // the next boot is a while later

		// Next boot: a fresh service over the same database and disk.
		repo.close();
		repo = new SQLiteRepository(dbPath);
		const booted = new RecordingService({
			capture: new FakeCaptureAdapter({ realtime: false }),
			repo,
			storage,
			audio,
		});
		const reconciled = await booted.reconcileInterrupted();
		expect(reconciled).toEqual([{ sessionId: session.id, from: "recording", to: "stopped" }]);
		expect(repo.getChunks(session.id)).toHaveLength(2);

		const transcript = await new TranscriptionService(new FakeTranscriber(), repo, {
			requestsPerMinute: 18,
			audioSecondsPerHour: 7000,
		}).transcribeSession(session.id);
		expect(transcript.segments.at(-1)?.end).toBeCloseTo(20, 3);
	});
});
