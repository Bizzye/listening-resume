import { describe, expect, it, vi } from "vitest";
import { useStore } from "../../src/store";
import { busySessionIds, needsPolling, toSummary } from "../../src/store/slices/sessions";
import { TOAST_MS } from "../../src/store/slices/toasts";
import {
	DEVICES,
	makeAnalysis,
	makeDetail,
	makeSession,
	makeSettings,
	mockFetch,
	TEMPLATES,
} from "./helpers";

const st = () => useStore.getState();

/** A promise plus its resolver — holds a mocked response until the test releases it. */
function deferred<T = void>() {
	let resolve: (v: T) => void = () => {};
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe("toasts slice", () => {
	it("shows one toast at a time and hides it after a while", () => {
		vi.useFakeTimers();
		st().pop("Primeiro");
		st().pop("Segundo", "err");
		expect(st().toast).toMatchObject({ msg: "Segundo", kind: "err" });
		vi.advanceTimersByTime(TOAST_MS - 1);
		expect(st().toast).not.toBeNull();
		vi.advanceTimersByTime(1);
		expect(st().toast).toBeNull();
	});
});

describe("ui slice", () => {
	it("navigates and opens session detail with a tab", () => {
		st().openSession("s1", "e", { editTitle: true });
		expect(st()).toMatchObject({ screen: "detail", detailId: "s1", detailTab: "e" });
		expect(st().consumeEditTitle()).toBe(true);
		expect(st().consumeEditTitle()).toBe(false);
		st().go("templates");
		expect(st().screen).toBe("templates");
	});
});

describe("settings slice", () => {
	it("updates optimistically and keeps the server response", async () => {
		const f = mockFetch([["PATCH", "/settings", (c) => makeSettings(c.body as object)]]);
		useStore.setState({ settings: makeSettings() });
		const p = st().updateSettings({ autoTranscribe: false });
		expect(st().settings?.autoTranscribe).toBe(false);
		expect(await p).toBe(true);
		expect(f.to("PATCH", "/settings")[0].body).toEqual({ autoTranscribe: false });
	});
	it("rolls back and toasts on failure", async () => {
		mockFetch([["PATCH", "/settings", { status: 400, body: { error: "inválido" } }]]);
		useStore.setState({ settings: makeSettings() });
		expect(await st().updateSettings({ silenceDetection: false })).toBe(false);
		expect(st().settings?.silenceDetection).toBe(true);
		expect(st().toast?.msg).toContain("inválido");
	});
	it("toggles the theme, persists it and mirrors it to localStorage", async () => {
		const f = mockFetch([["PATCH", "/settings", (c) => makeSettings(c.body as object)]]);
		useStore.setState({ settings: makeSettings(), theme: "dark" });
		st().toggleTheme();
		expect(st().theme).toBe("light");
		expect(localStorage.getItem("lr-theme")).toBe("light");
		expect(document.documentElement.dataset.theme).toBe("light");
		await vi.waitFor(() => expect(f.to("PATCH", "/settings")).toHaveLength(1));
		expect(f.to("PATCH", "/settings")[0].body).toEqual({ theme: "light" });
	});
});

describe("sessions slice", () => {
	it("announces finished transcriptions found by polling", async () => {
		const s = makeSession({ id: "a", title: "Aula", status: "transcribing" });
		mockFetch([["GET", /^\/sessions\?limit=/, { sessions: [{ ...s, status: "transcribed" }] }]]);
		useStore.setState({ sessions: [s] });
		await st().loadSessions();
		expect(st().sessions[0].status).toBe("transcribed");
		expect(st().toast).toMatchObject({ msg: "Transcrição concluída — Aula", kind: "ok" });
	});

	it("transcribe: optimistic status, toast, and expected-busy polling window", async () => {
		const f = mockFetch([
			["POST", "/sessions/a/transcribe", { status: 202, body: { status: "transcribing" } }],
		]);
		useStore.setState({ sessions: [makeSession({ id: "a", title: "Aula", status: "stopped" })] });
		await st().transcribe("a");
		expect(f.to("POST", "/sessions/a/transcribe")).toHaveLength(1);
		expect(st().sessions[0].status).toBe("transcribing");
		expect(st().toast?.msg).toBe("Transcrevendo “Aula”…");
		expect(needsPolling({ id: "a", status: "stopped" }, st().expectBusyUntil)).toBe(true);
	});

	it("transcribe guards: already running", async () => {
		const f = mockFetch();
		useStore.setState({ sessions: [makeSession({ id: "a", status: "transcribing" })] });
		await st().transcribe("a");
		expect(f.calls).toHaveLength(0);
		expect(st().toast?.msg).toBe("Já está transcrevendo…");
	});

	it("transcribe reverts on server error", async () => {
		mockFetch([["POST", "/sessions/a/transcribe", { status: 500, body: { error: "sem ffmpeg" } }]]);
		useStore.setState({ sessions: [makeSession({ id: "a", status: "stopped" })] });
		await st().transcribe("a");
		expect(st().sessions[0].status).toBe("stopped");
		expect(st().toast).toMatchObject({
			kind: "err",
			msg: "Não foi possível transcrever: sem ffmpeg",
		});
	});

	it("transcribe 409 (already busy on the server) shows the real state, not a failure", async () => {
		const s = makeSession({ id: "a", status: "stopped" });
		const f = mockFetch([
			["POST", "/sessions/a/transcribe", { status: 409, body: { error: "Sessão ocupada" } }],
			["GET", "/sessions/a", makeDetail({ ...s, status: "transcribing" }, { transcript: null })],
		]);
		useStore.setState({ sessions: [s] });
		await st().transcribe("a");
		expect(st().toast).toMatchObject({ msg: "Sessão ocupada", kind: "ac" });
		await vi.waitFor(() => expect(st().sessions[0].status).toBe("transcribing"));
		expect(f.to("GET", "/sessions/a")).toHaveLength(1);
	});

	it("quickAnalyze refuses untranscribed sessions and analyzes transcribed ones", async () => {
		const f = mockFetch([
			["POST", "/sessions/b/analyze", { status: 202, body: { status: "analyzing" } }],
		]);
		useStore.setState({
			settings: makeSettings({ defaultTemplateId: "ata-reuniao" }),
			templates: TEMPLATES,
			sessions: [
				makeSession({ id: "a", status: "stopped" }),
				makeSession({ id: "b", status: "transcribed" }),
			],
		});
		st().quickAnalyze("a");
		expect(st().toast?.msg).toBe("Transcreva a sessão antes de analisar");
		st().quickAnalyze("b");
		expect(st()).toMatchObject({ screen: "detail", detailId: "b", detailTab: "a" });
		await vi.waitFor(() => expect(f.to("POST", "/sessions/b/analyze")).toHaveLength(1));
		expect(f.to("POST", "/sessions/b/analyze")[0].body).toEqual({ templateId: "ata-reuniao" });
		expect(st().toast?.msg).toBe("Gerando “ata-reuniao” com llama3.1:8b…");
	});

	it("loadDetail sorts analyses and selects a newly finished one", async () => {
		const s = makeSession({ id: "a", status: "analyzing", analysesCount: 1 });
		const old = makeAnalysis({ id: "old", createdAt: "2026-10-10T10:00:00" });
		const fresh = makeAnalysis({ id: "new", createdAt: "2026-10-11T10:00:00" });
		useStore.setState({ sessions: [s], details: { a: makeDetail(s, { analyses: [old] }) } });
		mockFetch([
			[
				"GET",
				"/sessions/a",
				makeDetail({ ...s, status: "completed", analysesCount: 2 }, { analyses: [fresh, old] }),
			],
		]);
		const d = await st().loadDetail("a");
		expect(d?.analyses.map((x) => x.id)).toEqual(["old", "new"]);
		expect(st().activeAnalysis.a).toBe("new");
		expect(st().toast?.msg).toBe("Análise concluída");
	});

	it("optimistic status: a stale list answer neither reverts it nor announces a failure", async () => {
		const s = makeSession({ id: "a", title: "Aula", status: "transcribed", analysesCount: 0 });
		const listGate = deferred();
		let listStatus = "transcribed";
		mockFetch([
			[
				"GET",
				/^\/sessions\?limit=/,
				async () => {
					await listGate.promise;
					return { sessions: [{ ...s, status: listStatus }] };
				},
			],
			["POST", "/sessions/a/analyze", { status: 202, body: { status: "analyzing" } }],
		]);
		useStore.setState({ sessions: [s], templates: TEMPLATES, settings: makeSettings() });
		const staleLoad = st().loadSessions(); // started before the job was posted
		await st().analyze("a", "resumo-executivo");
		listGate.resolve();
		await staleLoad;
		expect(st().sessions[0].status).toBe("analyzing");
		expect(st().toast?.msg).not.toMatch(/falhou/);
		expect(st().optimistic.a).toBeDefined();
		// A request started after the POST is authoritative: the server confirms the job.
		listStatus = "analyzing";
		await st().loadSessions();
		expect(st().sessions[0].status).toBe("analyzing");
		expect(st().optimistic.a).toBeUndefined();
	});

	it("optimistic status: a fast real failure (authoritative answer) is announced", async () => {
		const s = makeSession({ id: "a", title: "Aula", status: "transcribed", analysesCount: 0 });
		mockFetch([
			[
				"GET",
				/^\/sessions\?limit=/,
				{ sessions: [{ ...s, status: "transcribed", lastError: "Ollama offline" }] },
			],
			["POST", "/sessions/a/analyze", { status: 202, body: { status: "analyzing" } }],
		]);
		useStore.setState({ sessions: [s], templates: TEMPLATES, settings: makeSettings() });
		await st().analyze("a", "resumo-executivo");
		await st().loadSessions();
		expect(st().sessions[0]).toMatchObject({ status: "transcribed", lastError: "Ollama offline" });
		expect(st().toast).toMatchObject({ msg: "A análise falhou: Ollama offline", kind: "err" });
	});

	it("an older detail answer never reverts a newer list status (no duplicate toast)", async () => {
		const s = makeSession({ id: "a", title: "Aula", status: "transcribing" });
		const detailGate = deferred();
		mockFetch([
			[
				"GET",
				"/sessions/a",
				async () => {
					await detailGate.promise;
					return makeDetail(s, { transcript: null });
				},
			],
			["GET", /^\/sessions\?limit=/, { sessions: [{ ...s, status: "transcribed" }] }],
		]);
		useStore.setState({ sessions: [s] });
		const oldDetail = st().loadDetail("a");
		await st().loadSessions();
		expect(st().toast?.msg).toBe("Transcrição concluída — Aula");
		st().dismissToast();
		detailGate.resolve();
		await oldDetail;
		expect(st().findSession("a")?.status).toBe("transcribed");
		expect(st().toast).toBeNull();
		// The (older) payload is cached, stamped with what it was fetched for → known stale.
		expect(st().detailStamp.a).toBe("transcribing:0");
	});

	it("pollBusy refreshes only the busy sessions, one GET /sessions/:id each", async () => {
		const busy = makeSession({ id: "busy", status: "transcribing" });
		const idle = makeSession({ id: "idle", status: "completed" });
		const f = mockFetch([["GET", "/sessions/busy", makeDetail(busy)]]);
		useStore.setState({ sessions: [busy, idle] });
		expect(busySessionIds(st())).toEqual(["busy"]);
		await st().pollBusy();
		expect(f.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /sessions/busy"]);
	});

	it("background list failures toast once; user-initiated loads always toast", async () => {
		mockFetch([["GET", /^\/sessions\?limit=/, { status: 500, body: { error: "down" } }]]);
		await st().loadSessions({ background: true });
		expect(st().toast?.msg).toBe("Não foi possível carregar as sessões: down");
		st().dismissToast();
		await st().loadSessions({ background: true });
		expect(st().toast).toBeNull();
		await st().loadSessions();
		expect(st().toast?.msg).toBe("Não foi possível carregar as sessões: down");
	});

	it("loadDetail on 404 drops the session and leaves the detail", async () => {
		mockFetch([["GET", "/sessions/gone", { status: 404, body: { error: "not found" } }]]);
		useStore.setState({
			sessions: [makeSession({ id: "gone" })],
			screen: "detail",
			detailId: "gone",
		});
		await st().loadDetail("gone");
		expect(st().sessions).toHaveLength(0);
		expect(st().screen).toBe("sessions");
	});

	it("rename / delete / export", async () => {
		const f = mockFetch([
			["PATCH", "/sessions/a", { session: {} }],
			["DELETE", "/sessions/a", { ok: true }],
			["POST", "/sessions/a/export/save", { path: "C:\\out\\aula.md" }],
		]);
		useStore.setState({
			sessions: [makeSession({ id: "a" })],
			screen: "detail",
			detailId: "a",
			deleteId: "a",
		});
		await st().renameSession("a", "Novo nome");
		expect(st().sessions[0].title).toBe("Novo nome");
		expect(f.to("PATCH", "/sessions/a")[0].body).toEqual({ title: "Novo nome" });
		await st().exportSession("a", "md");
		expect(st().toast?.msg).toBe("Markdown salvo em C:\\out\\aula.md");
		await st().deleteSession("a");
		expect(st()).toMatchObject({ sessions: [], deleteId: null, screen: "sessions" });
		expect(st().toast?.msg).toBe("Sessão apagada");
	});

	it("toSummary fills list-only fields", () => {
		const { chunks, duration, preview, analysesCount, ...session } = makeSession();
		expect(toSummary(session)).toMatchObject({
			chunks: 0,
			duration: 0,
			preview: null,
			analysesCount: 0,
		});
	});
});

describe("recording slice", () => {
	const devices = {
		system: "@default",
		mic: "@default",
		systemName: "Alto-falantes",
		micName: "Microfone USB",
	};
	const REC = {
		sessionId: "r1",
		startTime: 0,
		chunks: 0,
		devices,
		muted: { system: false, mic: false },
	};

	it("start → recording state from the server", async () => {
		const f = mockFetch([
			["POST", "/recording/start", { session: { id: "r1" }, startTime: 1000, devices }],
			["GET", "/devices", { devices: DEVICES }],
		]);
		await st().startRecording();
		expect(f.to("POST", "/recording/start")[0].body).toEqual({});
		expect(st().recording).toEqual({
			sessionId: "r1",
			startTime: 1000,
			chunks: 0,
			devices,
			muted: { system: false, mic: false },
		});
	});

	it("stop → opens the new session detail and expects transcription", async () => {
		const session = { ...makeSession({ id: "r1", status: "stopped" }) };
		mockFetch([
			["POST", "/recording/stop", { session, chunks: 1 }],
			["GET", /^\/sessions\?/, { sessions: [session] }],
		]);
		useStore.setState({
			settings: makeSettings({ autoTranscribe: true }),
			recording: {
				sessionId: "r1",
				startTime: 0,
				chunks: 0,
				devices,
				muted: { system: false, mic: false },
			},
		});
		await st().stopRecording();
		expect(st().recording).toBeNull();
		expect(st()).toMatchObject({ screen: "detail", detailId: "r1", detailTab: "t" });
		expect(st().toast?.msg).toBe("Gravação salva — transcrevendo…");
		// The server status is trusted (not forced to "transcribing"); polling follows the job.
		expect(st().findSession("r1")?.status).toBe("stopped");
		expect(needsPolling({ id: "r1", status: "stopped" }, st().expectBusyUntil)).toBe(true);
	});

	it("a status poll answered after stop never resurrects the recording screen", async () => {
		const gate = deferred();
		mockFetch([
			[
				"GET",
				"/recording/status",
				async () => {
					await gate.promise;
					return { recording: true, ...REC, chunks: 1 };
				},
			],
			[
				"POST",
				"/recording/stop",
				{ session: makeSession({ id: "r1", status: "stopped" }), chunks: 1 },
			],
			["GET", /^\/sessions\?/, { sessions: [] }],
		]);
		useStore.setState({ settings: makeSettings({ autoTranscribe: false }), recording: REC });
		const poll = st().syncRecording();
		await st().stopRecording();
		gate.resolve();
		await poll;
		expect(st().recording).toBeNull();
	});

	it("syncRecording keeps optimistic mute while the mute request is in flight", async () => {
		const gate = deferred();
		mockFetch([
			[
				"POST",
				"/recording/mute",
				async (c) => {
					await gate.promise;
					return c.body;
				},
			],
			["GET", "/recording/status", { recording: true, ...REC, chunks: 2 }],
		]);
		useStore.setState({ recording: REC });
		const mute = st().toggleMute("mic");
		await st().syncRecording();
		expect(st().recording?.muted.mic).toBe(true);
		expect(st().recording?.chunks).toBe(2);
		gate.resolve();
		await mute;
		expect(st().recording?.muted.mic).toBe(true);
	});

	it("device switches apply in request order: a slow older answer is ignored", async () => {
		const first = deferred();
		mockFetch([
			[
				"POST",
				"/recording/devices",
				async (c) => {
					const mic = (c.body as { micDevice: string }).micDevice;
					if (mic === "Microfone USB") await first.promise;
					return { devices: { ...devices, mic, micName: mic } };
				},
			],
		]);
		useStore.setState({ devices: DEVICES, recording: REC });
		const a = st().switchCaptureDevice("mic", "Microfone USB");
		await st().switchCaptureDevice("mic", "Microfone interno");
		first.resolve();
		await a;
		expect(st().recording?.devices?.mic).toBe("Microfone interno");
		expect(st().toast?.msg).toBe(
			"Microfone trocado: Microfone interno — sem interromper a gravação",
		);
	});

	it("discard → dashboard", async () => {
		const f = mockFetch([
			["POST", "/recording/discard", { ok: true }],
			["GET", /^\/sessions\?/, { sessions: [] }],
		]);
		useStore.setState({
			recording: {
				sessionId: "r1",
				startTime: 0,
				chunks: 0,
				devices,
				muted: { system: false, mic: false },
			},
			screen: "settings",
		});
		await st().discardRecording();
		expect(f.to("POST", "/recording/discard")).toHaveLength(1);
		expect(st()).toMatchObject({ recording: null, screen: "dash" });
		expect(st().toast).toMatchObject({ msg: "Gravação descartada", kind: "err" });
	});

	it("mute toggles through the API and reverts on failure", async () => {
		const f = mockFetch([["POST", "/recording/mute", (c) => c.body]]);
		useStore.setState({
			recording: {
				sessionId: "r1",
				startTime: 0,
				chunks: 0,
				devices,
				muted: { system: false, mic: false },
			},
		});
		await st().toggleMute("mic");
		expect(f.to("POST", "/recording/mute")[0].body).toEqual({ target: "mic", muted: true });
		expect(st().recording?.muted.mic).toBe(true);
		mockFetch([["POST", "/recording/mute", { status: 500, body: { error: "x" } }]]);
		await st().toggleMute("system");
		expect(st().recording?.muted.system).toBe(false);
	});

	it("switches devices live and toasts the design copy", async () => {
		const resolved = { ...devices, mic: "Microfone interno", micName: "Microfone interno" };
		const f = mockFetch([["POST", "/recording/devices", { devices: resolved }]]);
		useStore.setState({
			devices: DEVICES,
			recording: {
				sessionId: "r1",
				startTime: 0,
				chunks: 0,
				devices,
				muted: { system: false, mic: false },
			},
		});
		await st().switchCaptureDevice("mic", "Microfone interno");
		expect(f.to("POST", "/recording/devices")[0].body).toEqual({ micDevice: "Microfone interno" });
		expect(st().recording?.devices).toEqual(resolved);
		expect(st().toast?.msg).toBe(
			"Microfone trocado: Microfone interno — sem interromper a gravação",
		);
		await st().switchCaptureDevice("system", "@default");
		expect(st().toast?.msg).toBe("Captura trocada: Padrão do sistema — sem interromper a gravação");
	});

	it("409 on stop/mute means the recording is gone: resync and leave the recording screen", async () => {
		mockFetch([
			["POST", "/recording/stop", { status: 409, body: { error: "Nenhuma gravação ativa" } }],
			["POST", "/recording/mute", { status: 409, body: { error: "Nenhuma gravação ativa" } }],
			["GET", "/recording/status", { recording: false }],
			["GET", /^\/sessions\?/, { sessions: [] }],
		]);
		const rec = {
			sessionId: "r1",
			startTime: 0,
			chunks: 0,
			devices,
			muted: { system: false, mic: false },
		};
		useStore.setState({ recording: rec });
		await st().toggleMute("mic");
		expect(st().recording).toBeNull();
		expect(st().toast).toMatchObject({ msg: "A gravação já não está ativa", kind: "err" });
		useStore.setState({ recording: rec });
		await st().stopRecording();
		expect(st().recording).toBeNull();
	});

	it("syncRecording mirrors /recording/status", async () => {
		mockFetch([
			[
				"GET",
				"/recording/status",
				{
					recording: true,
					sessionId: "r9",
					startTime: 5,
					chunks: 3,
					devices,
					muted: { system: true, mic: false },
				},
			],
		]);
		await st().syncRecording();
		expect(st().recording).toMatchObject({
			sessionId: "r9",
			chunks: 3,
			muted: { system: true, mic: false },
		});
		mockFetch([["GET", "/recording/status", { recording: false }]]);
		await st().syncRecording();
		expect(st().recording).toBeNull();
	});
});
