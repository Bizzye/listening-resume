import type {
	AudioDevice,
	CaptureSource,
	DeviceSwitch,
	ExportFormat,
	GroqKeyStatus,
	Health,
	RecordingStatus,
	ResolvedDevices,
	Session,
	SessionDetail,
	SessionSummary,
	Settings,
	StartRecordingResult,
	Template,
	TemplateInput,
} from "./types";

/** In Vite dev (port 1420) the API is proxied under /api; everywhere else it is the local server. */
export function resolveApiBase(
	loc: { port: string } = window.location,
	override: string | undefined = import.meta.env.VITE_API_BASE,
): string {
	if (override) return override.replace(/\/$/, "");
	return loc.port === "1420" ? "/api" : "http://localhost:3456/api";
}

/** `VITE_API_BASE` (build/dev env) overrides the default — used by e2e against a fake server. */
export const API_BASE = resolveApiBase();

export class ApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "ApiError";
	}
}

interface RequestOptions {
	method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
	json?: unknown;
	body?: BodyInit;
	headers?: Record<string, string>;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
	const headers: Record<string, string> = { ...opts.headers };
	let body = opts.body;
	if (opts.json !== undefined) {
		headers["Content-Type"] = "application/json";
		body = JSON.stringify(opts.json);
	}
	let res: Response;
	try {
		res = await fetch(`${API_BASE}${path}`, { method: opts.method ?? "GET", headers, body });
	} catch {
		throw new ApiError("Serviço local indisponível", 0);
	}
	const text = await res.text();
	let data: unknown;
	try {
		data = text ? JSON.parse(text) : undefined;
	} catch {
		data = undefined;
	}
	if (!res.ok) {
		const msg =
			data && typeof data === "object" && "error" in data && typeof data.error === "string"
				? data.error
				: `Falha na requisição (${res.status})`;
		throw new ApiError(msg, res.status);
	}
	return data as T;
}

const enc = encodeURIComponent;

/** HTTP header values must be ByteStrings; percent-encode only names that need it. */
export function filenameHeader(name: string): string {
	return /^[\x20-\x7e]*$/.test(name) ? name : enc(name);
}

export function levelsUrl(params: { system?: string; mic?: string | null }): string {
	const q = new URLSearchParams();
	if (params.system) q.set("system", params.system);
	if (params.mic !== undefined) q.set("mic", params.mic ?? "none");
	const qs = q.toString();
	return `${API_BASE}/audio/levels${qs ? `?${qs}` : ""}`;
}

export const sessionAudioUrl = (id: string) => `${API_BASE}/sessions/${enc(id)}/audio`;

export const api = {
	// Health / settings / config
	health: () => request<Health>("/health"),
	getSettings: () => request<Settings>("/settings"),
	patchSettings: (patch: Partial<Settings>) =>
		request<Settings>("/settings", { method: "PATCH", json: patch }),
	getGroqKey: () => request<GroqKeyStatus>("/config/groq-key"),
	setGroqKey: (key: string) =>
		request<{ ok: true; masked: string }>("/config/groq-key", { method: "POST", json: { key } }),
	deleteGroqKey: () => request<{ ok: true }>("/config/groq-key", { method: "DELETE" }),
	/** Validates `key` without saving it, or the stored key when omitted. */
	validateGroqKey: (key?: string) =>
		request<{ valid: boolean; error?: string }>("/config/groq-key/validate", {
			method: "POST",
			json: key ? { key } : {},
		}),
	analysisModels: () => request<{ models: string[] }>("/analysis/models"),

	// Devices / audio
	devices: () => request<{ devices: AudioDevice[] }>("/devices"),
	testAudio: (device: string) =>
		request<{ ok: true }>("/audio/test", { method: "POST", json: { device } }),

	// Recording
	startRecording: (body: DeviceSwitch = {}) =>
		request<StartRecordingResult>("/recording/start", { method: "POST", json: body }),
	stopRecording: () =>
		request<{ session: Session; chunks: number }>("/recording/stop", { method: "POST" }),
	discardRecording: () => request<{ ok: true }>("/recording/discard", { method: "POST" }),
	recordingStatus: () => request<RecordingStatus>("/recording/status"),
	setMute: (target: CaptureSource, muted: boolean) =>
		request<{ target: CaptureSource; muted: boolean }>("/recording/mute", {
			method: "POST",
			json: { target, muted },
		}),
	switchDevices: (body: DeviceSwitch) =>
		request<{ devices: ResolvedDevices }>("/recording/devices", { method: "POST", json: body }),

	// Sessions
	listSessions: (opts: { limit?: number; q?: string } = {}) => {
		const q = new URLSearchParams({ limit: String(opts.limit ?? 50) });
		if (opts.q) q.set("q", opts.q);
		return request<{ sessions: SessionSummary[] }>(`/sessions?${q.toString()}`);
	},
	getSession: (id: string) => request<SessionDetail>(`/sessions/${enc(id)}`),
	patchSession: (id: string, patch: { title?: string; exportDir?: string | null }) =>
		request<{ session: Session }>(`/sessions/${enc(id)}`, { method: "PATCH", json: patch }),
	deleteSession: (id: string) =>
		request<{ ok: true }>(`/sessions/${enc(id)}`, { method: "DELETE" }),
	transcribe: (id: string) =>
		request<{ status: "transcribing" }>(`/sessions/${enc(id)}/transcribe`, { method: "POST" }),
	analyze: (id: string, templateId: string) =>
		request<{ status: "analyzing" }>(`/sessions/${enc(id)}/analyze`, {
			method: "POST",
			json: { templateId },
		}),
	deleteAnalysis: (id: string) =>
		request<{ ok: true }>(`/analyses/${enc(id)}`, { method: "DELETE" }),
	importSession: (file: File) =>
		request<{ session: Session }>("/sessions/import", {
			method: "POST",
			body: file,
			headers: {
				"X-Filename": filenameHeader(file.name),
				"Content-Type": file.type || "application/octet-stream",
			},
		}),
	saveExport: (id: string, format: ExportFormat) =>
		request<{ path: string }>(`/sessions/${enc(id)}/export/save`, {
			method: "POST",
			json: { format },
		}),

	// Templates
	templates: () => request<{ templates: Template[] }>("/templates"),
	createTemplate: (input: TemplateInput) =>
		request<{ template: Template }>("/templates", { method: "POST", json: input }),
	updateTemplate: (id: string, input: TemplateInput) =>
		request<{ template: Template }>(`/templates/${enc(id)}`, { method: "PUT", json: input }),
	deleteTemplate: (id: string) =>
		request<{ ok: true }>(`/templates/${enc(id)}`, { method: "DELETE" }),
};

export function errorMessage(err: unknown, fallback = "Algo deu errado"): string {
	return err instanceof Error && err.message ? err.message : fallback;
}
