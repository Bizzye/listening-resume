import {
	AnalysisService,
	type AnalysisTemplate,
	type AnalyzerPort,
	describeFailure,
	type Settings,
	TranscriptionService,
} from "@listening-resume/core";
import type { AppDeps } from "../deps.js";
import { badRequest, conflict } from "../http.js";

type Kind = "transcription" | "analysis";

/**
 * Fail fast (400) when no transcriber can be built for the current settings — e.g. the Groq key
 * is missing — instead of starting a job that is bound to fail.
 */
export function assertTranscriberAvailable(
	factory: AppDeps["transcription"],
	settings: Settings,
): void {
	try {
		factory.create(settings);
	} catch (err) {
		throw badRequest((err as Error).message || "Transcrição indisponível");
	}
}

/** Groq quotas (free tier): 18 RPM, 7000 audio seconds per hour. */
export const DEFAULT_RATE_LIMITS = { requestsPerMinute: 18, audioSecondsPerHour: 7000 };

type Deps = Pick<
	AppDeps,
	| "repo"
	| "storage"
	| "logger"
	| "settings"
	| "transcription"
	| "rateLimits"
	| "transcriptionLanguage"
	| "transcriptionPrompt"
>;

/**
 * Runs transcription/analysis in the background, one job per session at a time. Status
 * changes happen synchronously inside the core services before their first await, so the
 * session is already `transcribing`/`analyzing` when `transcribe()`/`analyze()` return. The
 * services also record failures (pt-BR `lastError`); this class only guarantees a failure never
 * escapes as an unhandled rejection (so it can't crash the server).
 */
export class JobRunner {
	private running = new Map<string, { kind: Kind; promise: Promise<void> }>();
	/** One long-lived service so every Groq call shares the same rate limiter. */
	private readonly transcription: TranscriptionService;

	/** `onSettled` runs after each job (success or failure), e.g. to drop cached views. */
	constructor(
		private deps: Deps,
		private onSettled: (sessionId: string) => void = () => {},
	) {
		this.transcription = new TranscriptionService(
			(provider) =>
				deps.transcription.create({
					...deps.settings.get(),
					...(provider ? { transcriptionProvider: provider } : {}),
				}),
			deps.repo,
			deps.rateLimits ?? DEFAULT_RATE_LIMITS,
			deps.storage,
		);
	}

	isBusy(sessionId: string): boolean {
		return this.running.has(sessionId);
	}

	/**
	 * Resolves when every in-flight job has settled (tests / graceful shutdown), or after
	 * `timeoutMs` when given. Returns true when idle.
	 */
	async idle(timeoutMs?: number): Promise<boolean> {
		const deadline = timeoutMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + timeoutMs;
		while (this.running.size > 0) {
			const left = deadline - Date.now();
			if (left <= 0) return false;
			const all = Promise.allSettled([...this.running.values()].map((j) => j.promise));
			if (Number.isFinite(left)) {
				let timer: ReturnType<typeof setTimeout> | undefined;
				await Promise.race([all, new Promise((r) => (timer = setTimeout(r, left)))]);
				clearTimeout(timer);
			} else {
				await all;
			}
		}
		return true;
	}

	private launch(sessionId: string, kind: Kind, work: () => Promise<unknown>): void {
		const current = this.running.get(sessionId);
		if (current) {
			throw conflict(
				current.kind === "analysis" ? "Análise já em andamento" : "Transcrição já em andamento",
			);
		}
		const promise = (async () => {
			try {
				await work();
			} catch (err) {
				this.deps.logger.warn(`[${kind}] session ${sessionId}: ${(err as Error)?.message ?? err}`);
				this.ensureFailureRecorded(sessionId, kind, err);
			} finally {
				this.running.delete(sessionId);
				this.onSettled(sessionId);
			}
		})();
		this.running.set(sessionId, { kind, promise });
	}

	/** Core services record failures themselves; this covers errors thrown before they could. */
	private ensureFailureRecorded(sessionId: string, kind: Kind, err: unknown): void {
		try {
			const s = this.deps.repo.getSession(sessionId);
			if (!s) return;
			const stuck = s.status === "transcribing" || s.status === "analyzing";
			if (stuck || !s.lastError) {
				this.deps.repo.updateSession(sessionId, {
					...(stuck ? { status: kind === "analysis" ? "transcribed" : "failed" } : {}),
					lastError: s.lastError || describeFailure(err, kind),
				});
			}
		} catch (dbErr) {
			this.deps.logger.error(`[${kind}] could not record failure: ${(dbErr as Error).message}`);
		}
	}

	/** Starts transcription with the provider from the current settings. */
	transcribe(sessionId: string): void {
		const provider = this.deps.settings.get().transcriptionProvider;
		this.launch(sessionId, "transcription", () =>
			this.transcription.transcribeSession(sessionId, {
				provider,
				language: this.deps.transcriptionLanguage,
				prompt: this.deps.transcriptionPrompt,
			}),
		);
	}

	/** Starts analysis. The session is `analyzing` when this returns. */
	analyze(
		sessionId: string,
		template: AnalysisTemplate,
		analyzers: { primary: AnalyzerPort; fallback: AnalyzerPort | null },
		settings: Pick<Settings, "analysisLanguage" | "analysisModel">,
	): void {
		const service = new AnalysisService(analyzers.primary, analyzers.fallback, this.deps.repo);
		this.launch(sessionId, "analysis", () =>
			service.analyzeSession(sessionId, template, {
				language: settings.analysisLanguage,
				model: settings.analysisModel,
			}),
		);
	}
}
