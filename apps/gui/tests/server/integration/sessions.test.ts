import fs from "node:fs";
import path from "node:path";
import { readWavInfo } from "@listening-resume/core";
import { PDFDocument } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeFfmpeg, type Json, startTestApp, type TestApp } from "./harness.js";

async function record(t: TestApp, seconds = 7, title?: string): Promise<string> {
	const { session } = (await t.json("/recording/start", { method: "POST", json: { title } })).body;
	t.capture.advance(seconds);
	await t.json("/recording/stop", { method: "POST" });
	return session.id;
}

describe("sessions", () => {
	let t: TestApp;
	beforeEach(async () => {
		t = await startTestApp();
	});
	afterEach(() => t.close());

	it("lists newest first with summaries, limit and search", async () => {
		const a = await record(t, 3, "Aula de cálculo");
		const b = await record(t, 6, "Reunião semanal");
		const { body } = await t.json("/sessions");
		expect(body.sessions.map((s: Json) => s.id)).toEqual([b, a]);
		expect(body.sessions[0]).toMatchObject({
			title: "Reunião semanal",
			chunks: 2,
			preview: null,
			analysesCount: 0,
			exportDir: null,
			lastError: null,
		});
		expect(body.sessions[0].duration).toBeCloseTo(6, 0);
		expect((await t.json("/sessions?limit=1")).body.sessions).toHaveLength(1);
		const found = (await t.json(`/sessions?q=${encodeURIComponent("cálculo")}`)).body.sessions;
		expect(found.map((s: Json) => s.id)).toEqual([a]);
	});

	it("resolves id prefixes and 404s unknown ids", async () => {
		const id = await record(t);
		expect((await t.json(`/sessions/${id.slice(0, 8)}`)).body.session.id).toBe(id);
		expect((await t.json("/sessions/does-not-exist")).status).toBe(404);
	});

	it("PATCH updates title and exportDir; DELETE removes rows and files", async () => {
		const id = await record(t);
		const exportDir = path.join(t.dir, "custom-exports");
		const patched = await t.json(`/sessions/${id}`, {
			method: "PATCH",
			json: { title: "  Novo título  ", exportDir },
		});
		expect(patched.body.session).toMatchObject({ id, title: "Novo título", exportDir });
		expect(
			(await t.json(`/sessions/${id}`, { method: "PATCH", json: { exportDir: "relative/dir" } }))
				.status,
		).toBe(400);
		expect(
			(await t.json(`/sessions/${id}`, { method: "PATCH", json: { exportDir: null } })).body.session
				.exportDir,
		).toBeNull();

		expect((await t.deps.storage.listAudioFiles(id)).length).toBe(2);
		expect((await t.json(`/sessions/${id}`, { method: "DELETE" })).body).toEqual({ ok: true });
		expect((await t.json(`/sessions/${id}`)).status).toBe(404);
		expect(await t.deps.storage.listAudioFiles(id)).toEqual([]);
	});

	it("transcribe → poll → transcribed, then analyze → completed", async () => {
		const id = await record(t);
		const tr = await t.json(`/sessions/${id}/transcribe`, { method: "POST" });
		expect(tr).toEqual({ status: 202, body: { status: "transcribing" } });
		expect((await t.json(`/sessions/${id}`)).body.session.status).toBe("transcribing");
		expect((await t.json(`/sessions/${id}/transcribe`, { method: "POST" })).status).toBe(409);

		const done = await t.waitForStatus(id, ["transcribed"]);
		expect(done.transcript).toMatchObject({ provider: "fake", model: "fake-whisper" });
		expect(done.transcript.segments.length).toBeGreaterThanOrEqual(2);
		expect(done.session.preview).toBeTruthy();
		// segment times are offset by real chunk durations
		const last = done.transcript.segments.at(-1);
		expect(last.start).toBeGreaterThanOrEqual(5);

		const an = await t.json(`/sessions/${id}/analyze`, {
			method: "POST",
			json: { templateId: "ata-reuniao" },
		});
		expect(an).toEqual({ status: 202, body: { status: "analyzing" } });
		const completed = await t.waitForStatus(id, ["completed"]);
		expect(completed.analyses).toHaveLength(1);
		expect(completed.analyses[0]).toMatchObject({ templateId: "ata-reuniao", provider: "fake" });
		expect(completed.session.analysesCount).toBe(1);
		expect(t.analyzer.requests[0]?.userPrompt).toContain(done.transcript.segments[0].text);

		const analysisId = completed.analyses[0].id;
		expect((await t.json(`/analyses/${analysisId}`, { method: "DELETE" })).body).toEqual({
			ok: true,
		});
		expect((await t.json(`/analyses/${analysisId}`, { method: "DELETE" })).status).toBe(404);
	});

	it("rejects analysis without transcript / unknown template", async () => {
		const id = await record(t);
		const noTranscript = await t.json(`/sessions/${id}/analyze`, { method: "POST", json: {} });
		expect(noTranscript.status).toBe(400);
		await t.json(`/sessions/${id}/transcribe`, { method: "POST" });
		await t.waitForStatus(id, ["transcribed"]);
		const badTpl = await t.json(`/sessions/${id}/analyze`, {
			method: "POST",
			json: { templateId: "nope" },
		});
		expect(badTpl.status).toBe(404);
	});

	it("background failures set lastError without crashing the server", async () => {
		const id = await record(t);
		t.transcriber.failWith = "HTTP 429 rate limit exceeded";
		await t.json(`/sessions/${id}/transcribe`, { method: "POST" });
		const failed = await t.waitForStatus(id, ["failed"]);
		expect(failed.session.lastError).toMatch(/Limite de uso/);

		t.transcriber.failWith = undefined;
		await t.json(`/sessions/${id}/transcribe`, { method: "POST" });
		const ok = await t.waitForStatus(id, ["transcribed"]);
		expect(ok.session.lastError).toBeNull();

		t.analyzer.failWith = "modelo explodiu";
		await t.json(`/sessions/${id}/analyze`, {
			method: "POST",
			json: { templateId: "resumo-executivo" },
		});
		const until = Date.now() + 3000;
		let s: Json;
		do {
			s = (await t.json(`/sessions/${id}`)).body.session;
		} while (s.status === "analyzing" && Date.now() < until);
		expect(s.lastError).toMatch(/modelo explodiu/);
		expect((await t.json("/health")).status).toBe(200);
	});

	it("transcribe fails fast with 400 when the transcriber can't be created", async () => {
		const id = await record(t);
		t.deps.transcription.create = () => {
			// core throws a TranscriptionError (kind "internal") — the route still answers 400
			throw new Error("Chave da API do Groq não configurada.");
		};
		const res = await t.json(`/sessions/${id}/transcribe`, { method: "POST" });
		expect(res.status).toBe(400);
		expect(res.body.error).toMatch(/Groq/);
		expect((await t.json(`/sessions/${id}`)).body.session.status).toBe("stopped");
	});
});

describe("session audio streaming", () => {
	let t: TestApp;
	beforeEach(async () => {
		t = await startTestApp();
	});
	afterEach(() => t.close());

	it("serves all chunks as one WAV with Range support", async () => {
		const id = await record(t, 7);
		// The fake capture is wall-clock paced too, so read the real sizes from the WAV headers.
		const infos = (await t.deps.storage.listAudioFiles(id)).map((f) => readWavInfo(f));
		expect(infos).toHaveLength(2);
		const total = 44 + infos.reduce((n, i) => n + i.dataBytes, 0);
		expect(total).toBeGreaterThanOrEqual(44 + 7 * 16000 * 2);

		const full = await t.api(`/sessions/${id}/audio`);
		expect(full.status).toBe(200);
		expect(full.headers.get("content-type")).toBe("audio/wav");
		expect(full.headers.get("accept-ranges")).toBe("bytes");
		const buf = Buffer.from(await full.arrayBuffer());
		expect(buf.length).toBe(total);
		expect(buf.toString("ascii", 0, 4)).toBe("RIFF");
		expect(buf.readUInt32LE(40)).toBe(total - 44);

		const part = await t.api(`/sessions/${id}/audio`, { headers: { Range: "bytes=100-199" } });
		expect(part.status).toBe(206);
		expect(part.headers.get("content-range")).toBe(`bytes 100-199/${total}`);
		expect(part.headers.get("content-length")).toBe("100");
		expect(Buffer.from(await part.arrayBuffer())).toEqual(buf.subarray(100, 200));

		// across the chunk boundary
		const boundary = 44 + (infos[0]?.dataBytes ?? 0);
		const cross = await t.api(`/sessions/${id}/audio`, {
			headers: { Range: `bytes=${boundary - 10}-${boundary + 9}` },
		});
		expect(Buffer.from(await cross.arrayBuffer())).toEqual(
			buf.subarray(boundary - 10, boundary + 10),
		);

		const tail = await t.api(`/sessions/${id}/audio`, { headers: { Range: "bytes=-4" } });
		expect(Buffer.from(await tail.arrayBuffer())).toEqual(buf.subarray(total - 4));

		const bad = await t.api(`/sessions/${id}/audio`, { headers: { Range: `bytes=${total}-` } });
		expect(bad.status).toBe(416);
		expect(bad.headers.get("content-range")).toBe(`bytes */${total}`);
	});

	it("404s a session without audio", async () => {
		const { session } = (await t.json("/recording/start", { method: "POST", json: {} })).body;
		await t.json("/recording/discard", { method: "POST" });
		expect((await t.api(`/sessions/${session.id}/audio`)).status).toBe(404);
	});
});

describe("export", () => {
	let t: TestApp;
	let id: string;
	beforeEach(async () => {
		t = await startTestApp();
		id = await record(t, 4, "Reunião: planejamento/Q3");
		await t.json(`/sessions/${id}/transcribe`, { method: "POST" });
		await t.waitForStatus(id, ["transcribed"]);
		await t.json(`/sessions/${id}/analyze`, {
			method: "POST",
			json: { templateId: "flashcards-anki" },
		});
		await t.waitForStatus(id, ["completed"]);
	});
	afterEach(() => t.close());

	it("downloads markdown", async () => {
		const res = await t.api(`/sessions/${id}/export?format=md`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
		const cd = res.headers.get("content-disposition") ?? "";
		expect(cd).toMatch(/^attachment; filename=".*\.md"; filename\*=UTF-8''/);
		expect(decodeURIComponent(cd.split("''")[1] ?? "")).toMatch(/_Reunião planejamento Q3\.md$/);
		const text = await res.text();
		expect(text).toContain("# Reunião: planejamento/Q3");
		expect(text).toContain("| Pergunta | Resposta |");
		expect(text).toContain("## Transcrição");
	});

	it("downloads a valid PDF", async () => {
		const res = await t.api(`/sessions/${id}/export?format=pdf`);
		expect(res.headers.get("content-type")).toBe("application/pdf");
		const buf = Buffer.from(await res.arrayBuffer());
		expect(buf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
		expect((await PDFDocument.load(buf)).getPageCount()).toBeGreaterThanOrEqual(1);
	});

	it("downloads a DOCX (zip)", async () => {
		const res = await t.api(`/sessions/${id}/export?format=docx`);
		expect(res.headers.get("content-type")).toBe(
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		);
		const buf = Buffer.from(await res.arrayBuffer());
		expect(buf.subarray(0, 2).toString("ascii")).toBe("PK");
	});

	it("rejects unknown formats", async () => {
		expect((await t.api(`/sessions/${id}/export?format=txt`)).status).toBe(400);
	});

	it("saves into the session dir override, else the global default", async () => {
		const saved = await t.json(`/sessions/${id}/export/save`, {
			method: "POST",
			json: { format: "pdf" },
		});
		expect(saved.status).toBe(200);
		expect(path.dirname(saved.body.path)).toBe(path.join(t.dir, "exports"));
		expect(fs.readFileSync(saved.body.path).subarray(0, 5).toString()).toBe("%PDF-");

		const custom = path.join(t.dir, "por-sessao");
		await t.json(`/sessions/${id}`, { method: "PATCH", json: { exportDir: custom } });
		const saved2 = await t.json(`/sessions/${id}/export/save`, { method: "POST", json: {} });
		expect(path.dirname(saved2.body.path)).toBe(custom);
		expect(saved2.body.path.endsWith(".md")).toBe(true); // settings.exportFormat default
		const docx = await t.json(`/sessions/${id}/export/save`, {
			method: "POST",
			json: { format: "docx" },
		});
		expect(fs.existsSync(docx.body.path)).toBe(true);
	});
});

describe("import", () => {
	let t: TestApp;
	afterEach(() => t.close());

	it("converts an upload into a stopped session with WAV chunks", async () => {
		const ffmpeg = fakeFfmpeg(7);
		t = await startTestApp({ run: ffmpeg });
		const res = await t.json("/sessions/import", {
			method: "POST",
			headers: { "X-Filename": encodeURIComponent("Aula 03 — Derivadas.mp4") },
			body: Buffer.alloc(2048, 1),
		});
		expect(res.status).toBe(201);
		expect(res.body.session).toMatchObject({
			status: "stopped",
			title: "Aula 03 — Derivadas",
			audioSource: "Arquivo importado · .mp4",
		});
		const args = ffmpeg.calls[0] ?? [];
		expect(args[args.indexOf("-ar") + 1]).toBe("16000");
		expect(args[args.indexOf("-segment_time") + 1]).toBe("5");
		const detail = (await t.json(`/sessions/${res.body.session.id}`)).body;
		expect(detail.session.chunks).toBe(2);
		expect(detail.session.duration).toBeCloseTo(7, 1);
		expect(fs.readdirSync(path.join(t.dir, "tmp"))).toEqual([]); // upload cleaned up
	});

	it("auto-transcribes when enabled", async () => {
		t = await startTestApp();
		t.settings.update({ autoTranscribe: true });
		const res = await t.json("/sessions/import", {
			method: "POST",
			headers: { "X-Filename": "podcast.mp3" },
			body: Buffer.alloc(16, 1),
		});
		expect(res.body.session.status).toBe("transcribing");
		await t.waitForStatus(res.body.session.id, ["transcribed"]);
	});

	it("rejects empty and unconvertible uploads, leaving nothing behind", async () => {
		t = await startTestApp({ run: fakeFfmpeg(7, true) });
		const empty = await t.json("/sessions/import", { method: "POST", body: "" });
		expect(empty.status).toBe(400);
		const bad = await t.json("/sessions/import", {
			method: "POST",
			headers: { "X-Filename": "x.bin" },
			body: Buffer.alloc(64, 7),
		});
		expect(bad.status).toBe(422);
		expect((await t.json("/sessions")).body.sessions).toEqual([]);
	});

	it("hides the session while converting (status created) and shows it once stopped", async () => {
		const ffmpeg = fakeFfmpeg(3);
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		let seenOpts: unknown;
		t = await startTestApp({
			importTimeoutMs: 1234,
			run: async (cmd, args, opts) => {
				seenOpts = opts;
				await gate;
				return ffmpeg(cmd, args, opts);
			},
		});
		const pending = t.json("/sessions/import", {
			method: "POST",
			headers: { "X-Filename": "aula.mp3" },
			body: Buffer.alloc(64, 1),
		});
		const until = Date.now() + 2000;
		while (!seenOpts && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
		expect(seenOpts).toEqual({ timeoutMs: 1234 });
		expect(t.repo.findSessionsByStatus(["created"])).toHaveLength(1);
		expect((await t.json("/sessions")).body.sessions).toEqual([]);
		release();
		const res = await pending;
		expect(res.status).toBe(201);
		expect(res.body.session.status).toBe("stopped");
		const list = (await t.json("/sessions")).body.sessions;
		expect(list.map((x: Json) => [x.id, x.status])).toEqual([[res.body.session.id, "stopped"]]);
	});

	it("fails a conversion that exceeds the timeout and removes the session + files", async () => {
		t = await startTestApp({
			run: async () => ({ code: null, stdout: "", stderr: "", timedOut: true }),
		});
		const res = await t.json("/sessions/import", {
			method: "POST",
			headers: { "X-Filename": "longo.mkv" },
			body: Buffer.alloc(64, 1),
		});
		expect(res.status).toBe(500);
		expect(res.body.error).toMatch(/tempo limite/);
		expect(t.repo.listSessions({})).toEqual([]);
		expect(fs.readdirSync(path.join(t.dir, "data", "sessions"), { withFileTypes: true })).toEqual(
			[],
		);
	});

	it("passes -protocol_whitelist file,pipe and -nostdin to ffmpeg", async () => {
		const ffmpeg = fakeFfmpeg(2);
		t = await startTestApp({ run: ffmpeg });
		await t.json("/sessions/import", {
			method: "POST",
			headers: { "X-Filename": "lista.m3u8" },
			body: Buffer.alloc(64, 1),
		});
		const args = ffmpeg.calls[0] ?? [];
		expect(args[args.indexOf("-protocol_whitelist") + 1]).toBe("file,pipe");
		expect(args).toContain("-nostdin");
	});

	it("enforces the upload size limit", async () => {
		t = await startTestApp({ importLimitBytes: 1024 });
		const res = await t.json("/sessions/import", {
			method: "POST",
			headers: { "X-Filename": "big.wav" },
			body: Buffer.alloc(4096, 1),
		});
		expect(res.status).toBe(413);
	});
});
