import { ApiError, api, errorMessage } from "../../shared/api/client";
import type {
	ExportFormat,
	Session,
	SessionDetail,
	SessionStatus,
	SessionSummary,
} from "../../shared/api/types";
import { DEFAULT_TEMPLATE_ID } from "../../shared/lib/core-shared";
import { sessionTitle, templateName, transitionToast } from "../../shared/lib/session";
import { isBusy, isTranscribed } from "../../shared/lib/status";
import type { AppState, SliceCreator } from "../types";

/**
 * The list endpoint caps results; stats/counts over more sessions than this are partial (the
 * server has no aggregate endpoint yet).
 */
export const SESSIONS_LIMIT = 200;
/** Keep polling a session this long after asking the server to work on it. */
export const EXPECT_BUSY_MS = 8000;

/**
 * A status set locally before the server confirmed it (transcribe/analyze). Server answers to
 * requests started before the job POST resolved (`since`) are stale for this session: they
 * neither overwrite the optimistic status nor announce transitions away from it.
 */
export interface OptimisticStatus {
	status: SessionStatus;
	/** Request sequence number at POST resolution; `null` while the POST is in flight. */
	since: number | null;
}

export interface LoadOptions {
	/** Background refresh (polling): errors toast only on the first failure in a row. */
	background?: boolean;
}

export interface SessionsSlice {
	sessions: SessionSummary[];
	sessionsLoaded: boolean;
	details: Record<string, SessionDetail>;
	/**
	 * `status:analysesCount` of the session when its cached detail (transcript + analyses) was
	 * fetched — a mismatch with the current summary means the detail is stale.
	 */
	detailStamp: Record<string, string>;
	expectBusyUntil: Record<string, number>;
	optimistic: Record<string, OptimisticStatus>;
	importing: boolean;
	/** Session waiting for the "transcrever de novo?" confirmation. */
	confirmTranscribeId: string | null;
	loadSessions: (opts?: LoadOptions) => Promise<void>;
	loadDetail: (id: string) => Promise<SessionDetail | null>;
	/** Refreshes only the sessions with a job running (GET /sessions/:id each). */
	pollBusy: () => Promise<void>;
	findSession: (id: string) => SessionSummary | undefined;
	addSession: (session: Session) => void;
	renameSession: (id: string, title: string) => Promise<void>;
	setSessionExportDir: (id: string, dir: string | null) => Promise<void>;
	deleteSession: (id: string) => Promise<void>;
	/** Transcribes, asking for confirmation first when a transcript already exists. */
	requestTranscribe: (id: string) => void;
	confirmTranscribe: () => void;
	cancelTranscribe: () => void;
	transcribe: (id: string) => Promise<void>;
	analyze: (id: string, templateId: string) => Promise<void>;
	quickAnalyze: (id: string) => void;
	deleteAnalysis: (sessionId: string, analysisId: string) => Promise<void>;
	importFile: (file: File) => Promise<void>;
	exportSession: (id: string, format: ExportFormat) => Promise<void>;
}

export function toSummary(session: Session): SessionSummary {
	return { chunks: 0, duration: 0, preview: null, analysesCount: 0, ...session };
}

export function needsPolling(
	s: Pick<SessionSummary, "id" | "status">,
	expectBusyUntil: Record<string, number>,
	now = Date.now(),
): boolean {
	return isBusy(s.status) || (expectBusyUntil[s.id] ?? 0) > now;
}

/** Ids of sessions (listed or cached in detail) with a background job to follow. */
export function busySessionIds(
	state: Pick<AppState, "sessions" | "details" | "expectBusyUntil">,
	now = Date.now(),
): string[] {
	const ids = new Set<string>();
	for (const s of state.sessions) if (needsPolling(s, state.expectBusyUntil, now)) ids.add(s.id);
	for (const d of Object.values(state.details))
		if (needsPolling(d.session, state.expectBusyUntil, now)) ids.add(d.session.id);
	return [...ids];
}

export const detailStampOf = (s: Pick<SessionSummary, "status" | "analysesCount">) =>
	`${s.status}:${s.analysesCount}`;

/** Whether the session already has a transcript (re-transcribing would replace it). */
export function hasTranscript(s: SessionSummary, detail: SessionDetail | undefined): boolean {
	if (detail) return !!detail.transcript;
	return isTranscribed(s.status) || (s.status === "failed" && !!s.preview);
}

/** 409 on a job POST: the session is already busy server-side. */
const jobConflict = (err: unknown) => err instanceof ApiError && err.status === 409;

const EXPORT_LABEL: Record<ExportFormat, string> = { md: "Markdown", pdf: "PDF", docx: "DOCX" };

export const createSessionsSlice: SliceCreator<SessionsSlice> = (set, get) => {
	/** Monotonic request counter: orders server answers by when they were asked for. */
	let reqSeq = 0;
	/** Newest request whose summary / detail payload was applied, per session. */
	const summarySeq: Record<string, number> = {};
	const payloadSeq: Record<string, number> = {};
	let backgroundFailures = 0;

	/** Applies a partial update to a session in both the list and the detail cache. */
	const patchLocal = (id: string, patch: Partial<SessionSummary>) =>
		set((s) => {
			const detail = s.details[id];
			return {
				sessions: s.sessions.map((x) => (x.id === id ? { ...x, ...patch } : x)),
				details: detail
					? { ...s.details, [id]: { ...detail, session: { ...detail.session, ...patch } } }
					: s.details,
			};
		});

	const setOptimistic = (id: string, value: OptimisticStatus | null) =>
		set((s) => {
			const { [id]: _drop, ...rest } = s.optimistic;
			return { optimistic: value ? { ...rest, [id]: value } : rest };
		});

	const expectBusy = (id: string, on = true) =>
		set((s) => ({
			expectBusyUntil: { ...s.expectBusyUntil, [id]: on ? Date.now() + EXPECT_BUSY_MS : 0 },
		}));

	/**
	 * Merges one server summary (from request `seq`) with local state. Returns the session to
	 * store, or null when a newer answer for it was already applied. Announces finished jobs.
	 */
	const reconcile = (state: AppState, next: SessionSummary, seq: number) => {
		if ((summarySeq[next.id] ?? 0) > seq) return null;
		summarySeq[next.id] = seq;
		const prev = state.details[next.id]?.session ?? state.sessions.find((x) => x.id === next.id);
		const pending = state.optimistic[next.id];
		if (pending) {
			if (pending.since === null || seq <= pending.since) {
				// Stale for this session: the server had not seen the job yet.
				return { session: { ...next, status: pending.status, lastError: null }, settled: false };
			}
			// Authoritative: from here on the server status is the truth.
			if (prev) announceOne(state, prev, next);
			return { session: next, settled: true };
		}
		if (prev) announceOne(state, prev, next);
		return { session: next, settled: false };
	};

	const announceOne = (state: AppState, prev: SessionSummary, next: SessionSummary) => {
		const t = transitionToast(prev, next);
		if (t) state.pop(t.msg, t.kind);
	};

	return {
		sessions: [],
		sessionsLoaded: false,
		details: {},
		detailStamp: {},
		expectBusyUntil: {},
		optimistic: {},
		importing: false,
		confirmTranscribeId: null,

		findSession: (id) => get().details[id]?.session ?? get().sessions.find((x) => x.id === id),

		loadSessions: async (opts = {}) => {
			const seq = ++reqSeq;
			try {
				const { sessions } = await api.listSessions({ limit: SESSIONS_LIMIT });
				backgroundFailures = 0;
				const state = get();
				const settled: string[] = [];
				const listed = sessions.map((x) => {
					const r = reconcile(state, x, seq);
					if (!r) return state.findSession(x.id) ?? x;
					if (r.settled) settled.push(x.id);
					return r.session;
				});
				// Sessions added locally after this request started (stop/import) are not in it yet.
				const ids = new Set(sessions.map((x) => x.id));
				const newer = state.sessions.filter((x) => !ids.has(x.id) && (summarySeq[x.id] ?? 0) > seq);
				const merged = [...newer, ...listed];
				set((s) => {
					// Keep cached details in sync with the list. A changed status / analysesCount
					// leaves the detail's stamp behind: the detail page re-fetches it.
					const details = { ...s.details };
					for (const x of merged) {
						const d = details[x.id];
						if (d) details[x.id] = { ...d, session: x };
					}
					const optimistic = { ...s.optimistic };
					for (const id of settled) delete optimistic[id];
					return { sessions: merged, details, optimistic, sessionsLoaded: true };
				});
			} catch (err) {
				set({ sessionsLoaded: true });
				if (opts.background && ++backgroundFailures > 1) return;
				get().pop(`Não foi possível carregar as sessões: ${errorMessage(err)}`, "err");
			}
		},

		loadDetail: async (id) => {
			const seq = ++reqSeq;
			try {
				const raw = await api.getSession(id);
				const state = get();
				const prevCount = state.details[id]?.analyses.length ?? -1;
				const r = reconcile(state, raw.session, seq);
				const freshPayload = (payloadSeq[id] ?? 0) < seq;
				if (freshPayload) payloadSeq[id] = seq;
				const cur = state.details[id];
				const session = r?.session ?? state.findSession(id) ?? raw.session;
				const detail: SessionDetail =
					freshPayload || !cur
						? {
								session,
								transcript: raw.transcript,
								analyses: [...raw.analyses].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
							}
						: { ...cur, session };
				set((s) => {
					const optimistic = { ...s.optimistic };
					if (r?.settled) delete optimistic[id];
					return {
						details: { ...s.details, [id]: detail },
						detailStamp: freshPayload
							? { ...s.detailStamp, [id]: detailStampOf(raw.session) }
							: s.detailStamp,
						sessions: r ? s.sessions.map((x) => (x.id === id ? r.session : x)) : s.sessions,
						optimistic,
					};
				});
				const newest = detail.analyses.at(-1);
				if (newest && prevCount >= 0 && detail.analyses.length > prevCount) {
					get().setActiveAnalysis(id, newest.id);
				}
				return detail;
			} catch (err) {
				if (err instanceof ApiError && err.status === 404) {
					set((s) => ({ sessions: s.sessions.filter((x) => x.id !== id) }));
					get().pop("Sessão não encontrada", "err");
					if (get().detailId === id) get().go("sessions");
				}
				return null;
			}
		},

		pollBusy: async () => {
			const ids = busySessionIds(get());
			await Promise.all(ids.map((id) => get().loadDetail(id)));
		},

		addSession: (session) => {
			summarySeq[session.id] = ++reqSeq;
			set((s) => ({
				sessions: [toSummary(session), ...s.sessions.filter((x) => x.id !== session.id)],
			}));
		},

		renameSession: async (id, title) => {
			const prev = get().findSession(id);
			if (!prev) return;
			patchLocal(id, { title });
			try {
				await api.patchSession(id, { title });
				get().pop("Sessão renomeada");
			} catch (err) {
				patchLocal(id, { title: prev.title });
				get().pop(`Não foi possível renomear: ${errorMessage(err)}`, "err");
			}
		},

		setSessionExportDir: async (id, dir) => {
			const prev = get().findSession(id);
			if (!prev) return;
			patchLocal(id, { exportDir: dir });
			try {
				await api.patchSession(id, { exportDir: dir });
				if (dir === null) get().pop(`Usando a pasta padrão: ${get().settings?.exportDir ?? ""}`);
				else get().pop(`Destino desta sessão: ${dir}`, "ac");
			} catch (err) {
				patchLocal(id, { exportDir: prev.exportDir });
				get().pop(`Não foi possível alterar o destino: ${errorMessage(err)}`, "err");
			}
		},

		deleteSession: async (id) => {
			try {
				await api.deleteSession(id);
				set((s) => {
					const { [id]: _gone, ...details } = s.details;
					return {
						sessions: s.sessions.filter((x) => x.id !== id),
						details,
						deleteId: null,
						...(s.detailId === id && s.screen === "detail"
							? { screen: "sessions" as const, detailId: null }
							: {}),
					};
				});
				get().pop("Sessão apagada", "err");
			} catch (err) {
				set({ deleteId: null });
				get().pop(`Não foi possível apagar: ${errorMessage(err)}`, "err");
			}
		},

		requestTranscribe: (id) => {
			const s = get().findSession(id);
			if (!s) return;
			// Busy/recording sessions go straight through so the guards explain why not.
			if (!isBusy(s.status) && s.status !== "recording" && hasTranscript(s, get().details[id]))
				set({ confirmTranscribeId: id });
			else void get().transcribe(id);
		},

		confirmTranscribe: () => {
			const id = get().confirmTranscribeId;
			set({ confirmTranscribeId: null });
			if (id) void get().transcribe(id);
		},

		cancelTranscribe: () => set({ confirmTranscribeId: null }),

		transcribe: async (id) => {
			const s = get().findSession(id);
			if (!s) return;
			if (s.status === "transcribing") return get().pop("Já está transcrevendo…", "ac");
			if (s.status === "recording") return get().pop("A gravação ainda está em andamento", "err");
			if (s.status === "analyzing") return get().pop("Aguarde a análise terminar", "err");
			patchLocal(id, { status: "transcribing", lastError: null });
			setOptimistic(id, { status: "transcribing", since: null });
			expectBusy(id);
			get().pop(`Transcrevendo “${sessionTitle(s)}”…`, "ac");
			try {
				await api.transcribe(id);
				setOptimistic(id, { status: "transcribing", since: reqSeq });
			} catch (err) {
				setOptimistic(id, null);
				patchLocal(id, { status: s.status, lastError: s.lastError });
				expectBusy(id, false);
				if (jobConflict(err)) {
					// Already busy on the server (409): show its real state instead of failing.
					get().pop(errorMessage(err), "ac");
					void get().loadDetail(id);
					return;
				}
				get().pop(`Não foi possível transcrever: ${errorMessage(err)}`, "err");
			}
		},

		analyze: async (id, templateId) => {
			const s = get().findSession(id);
			if (!s) return;
			if (s.status === "transcribing")
				return get().pop("Aguarde a transcrição terminar para analisar", "err");
			if (s.status === "analyzing") return get().pop("Já está analisando…", "ac");
			const name = templateName(get().templates, templateId);
			const model = get().settings?.analysisModel ?? "o modelo local";
			patchLocal(id, { status: "analyzing", lastError: null });
			setOptimistic(id, { status: "analyzing", since: null });
			expectBusy(id);
			get().pop(`Gerando “${name}” com ${model}…`, "ac");
			try {
				await api.analyze(id, templateId);
				setOptimistic(id, { status: "analyzing", since: reqSeq });
			} catch (err) {
				setOptimistic(id, null);
				patchLocal(id, { status: s.status, lastError: s.lastError });
				expectBusy(id, false);
				if (jobConflict(err)) {
					// Already busy on the server (409): show its real state instead of failing.
					get().pop(errorMessage(err), "ac");
					void get().loadDetail(id);
					return;
				}
				get().pop(`Não foi possível analisar: ${errorMessage(err)}`, "err");
			}
		},

		quickAnalyze: (id) => {
			const s = get().findSession(id);
			if (!s) return;
			if (s.status === "transcribing")
				return get().pop("Aguarde a transcrição terminar para analisar", "err");
			const hasText = isTranscribed(s.status) || (s.status === "failed" && !!s.preview);
			if (!hasText) return get().pop("Transcreva a sessão antes de analisar", "err");
			get().openSession(id, "a");
			const tpl =
				get().selectedTemplateId ?? get().settings?.defaultTemplateId ?? DEFAULT_TEMPLATE_ID;
			void get().analyze(id, tpl);
		},

		deleteAnalysis: async (sessionId, analysisId) => {
			try {
				await api.deleteAnalysis(analysisId);
				set((s) => {
					const d = s.details[sessionId];
					if (!d) return {};
					return {
						details: {
							...s.details,
							[sessionId]: { ...d, analyses: d.analyses.filter((a) => a.id !== analysisId) },
						},
					};
				});
				get().pop("Análise apagada", "err");
				void get().loadDetail(sessionId);
			} catch (err) {
				get().pop(`Não foi possível apagar a análise: ${errorMessage(err)}`, "err");
			}
		},

		importFile: async (file) => {
			if (get().importing) return;
			set({ importing: true });
			get().pop(`Importando “${file.name}”…`, "ac");
			try {
				const { session } = await api.importSession(file);
				const auto = get().settings?.autoTranscribe ?? true;
				// Trust the server status; auto-transcription may start right after the answer.
				get().addSession(session);
				if (auto) expectBusy(session.id);
				get().openSession(session.id, "t");
				get().pop(auto ? "Arquivo importado — transcrevendo…" : "Arquivo importado", "ac");
				void get().loadSessions();
			} catch (err) {
				get().pop(`Não foi possível importar: ${errorMessage(err)}`, "err");
			} finally {
				set({ importing: false });
			}
		},

		exportSession: async (id, format) => {
			try {
				const { path } = await api.saveExport(id, format);
				get().pop(`${EXPORT_LABEL[format]} salvo em ${path}`);
			} catch (err) {
				get().pop(`Não foi possível exportar: ${errorMessage(err)}`, "err");
			}
		},
	};
};
