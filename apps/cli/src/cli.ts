import fs from "node:fs";
import path from "node:path";
import {
	type AnalysisLanguage,
	AnalysisService,
	type AnalysisTemplate,
	type AppConfig,
	BUILTIN_TEMPLATES,
	createCaptureAdapter,
	createTranscriber,
	describeCaptureWarning,
	errorMessage,
	GroqLLMAdapter,
	LocalFileStorage,
	loadConfig,
	MarkdownExporter,
	OllamaAdapter,
	onShutdown,
	RecordingService,
	resolveConfigDir,
	resolveDataDir,
	SETTINGS_FILE_NAME,
	type Session,
	type Settings,
	SettingsStore,
	SQLiteRepository,
	SYSTEM_DEFAULT_DEVICE,
	selectAnalyzers,
	setupSignalHandlers,
	TranscriptionService,
	totalWavDurationSec,
} from "@listening-resume/core";
import chalk from "chalk";
import { Command } from "commander";
import ora from "ora";

const DB_FILE = "listening-resume.db";

/** The user's preferences the CLI honors (a subset of the GUI settings). */
type Preferences = Pick<
	Settings,
	| "systemDevice"
	| "micDevice"
	| "transcriptionProvider"
	| "whisperModel"
	| "analysisModel"
	| "analysisLanguage"
	| "defaultTemplateId"
>;

interface Context {
	config: AppConfig;
	prefs: Preferences;
	dataDir: string;
	dbPath: string;
}

/**
 * Preferences: `settings.json` (shared with the GUI — the source of truth) wins for every value
 * it actually stores; `config.toml` is the low-level fallback (both default to the same values).
 */
export function resolvePreferences(config: AppConfig, stored: Partial<Settings>): Preferences {
	return {
		systemDevice: stored.systemDevice ?? config.audio.device,
		micDevice: stored.micDevice !== undefined ? stored.micDevice : config.audio.micDevice,
		transcriptionProvider: stored.transcriptionProvider ?? config.transcription.provider,
		whisperModel: stored.whisperModel ?? config.transcription.whisperModel,
		analysisModel: stored.analysisModel ?? config.analysis.model,
		analysisLanguage: stored.analysisLanguage ?? "pt-BR",
		defaultTemplateId: stored.defaultTemplateId ?? config.analysis.defaultTemplate,
	};
}

function context(): Context {
	const configDir = resolveConfigDir();
	const config = loadConfig(configDir);
	const stored = new SettingsStore(path.join(configDir, SETTINGS_FILE_NAME)).getExplicit();
	const dataDir = resolveDataDir(config);
	return {
		config,
		prefs: resolvePreferences(config, stored),
		dataDir,
		dbPath: path.join(dataDir, DB_FILE),
	};
}

/** Opens the database for read commands; null (with a message) when nothing was recorded yet. */
function openExistingRepo(ctx: Context): SQLiteRepository | null {
	if (!fs.existsSync(ctx.dbPath)) {
		console.log(chalk.yellow("No database found. Run 'listen record' first."));
		process.exitCode = 1;
		return null;
	}
	return new SQLiteRepository(ctx.dbPath);
}

function findSession(repo: SQLiteRepository, idOrPrefix: string): Session | null {
	const session = repo.findSessionByIdPrefix(idOrPrefix);
	if (!session) {
		console.log(chalk.red(`Session not found: ${idOrPrefix}`));
		process.exitCode = 1;
	}
	return session;
}

function resolveTemplate(repo: SQLiteRepository, id: string): AnalysisTemplate | null {
	const template = repo.getTemplate(id);
	if (!template) {
		console.log(chalk.red(`Template not found: ${id}`));
		console.log(
			`Available: ${repo
				.listTemplates()
				.map((t) => t.id)
				.join(", ")}`,
		);
		process.exitCode = 1;
	}
	return template;
}

function transcriptionService(ctx: Context, repo: SQLiteRepository): TranscriptionService {
	const { transcription, rateLimits } = ctx.config;
	return new TranscriptionService(
		() =>
			createTranscriber(ctx.prefs.transcriptionProvider, {
				groqApiKey: process.env.GROQ_API_KEY,
				groqModel: transcription.model,
				whisperBinary: transcription.whisperBinary,
				whisperModelsDir: transcription.whisperModelsDir ?? path.join(ctx.dataDir, "models"),
				whisperModel: ctx.prefs.whisperModel,
			}),
		repo,
		{
			requestsPerMinute: rateLimits.groqRpm,
			audioSecondsPerHour: rateLimits.groqAudioSecondsPerHour,
		},
		new LocalFileStorage(ctx.dataDir),
	);
}

function analysisService(ctx: Context, repo: SQLiteRepository): AnalysisService {
	const { analysis } = ctx.config;
	const groqKey = process.env.GROQ_API_KEY;
	const { primary, fallback } = selectAnalyzers(
		analysis.provider,
		new OllamaAdapter(ctx.prefs.analysisModel, analysis.ollamaHost),
		groqKey ? new GroqLLMAdapter(groqKey, analysis.fallback?.model) : null,
	);
	return new AnalysisService(primary, fallback, repo);
}

async function runTranscription(ctx: Context, repo: SQLiteRepository, session: Session) {
	const spinner = ora("Transcribing...").start();
	try {
		const transcript = await transcriptionService(ctx, repo).transcribeSession(session.id, {
			language: ctx.config.transcription.language,
			prompt: ctx.config.transcription.prompt,
		});
		spinner.succeed(
			`Transcribed (${transcript.segments.length} segments, ${transcript.fullText.length} chars)`,
		);
		return transcript;
	} catch (err) {
		spinner.fail(errorMessage(err));
		process.exitCode = 1;
		return null;
	}
}

async function runAnalysis(
	ctx: Context,
	repo: SQLiteRepository,
	session: Session,
	template: AnalysisTemplate,
	language: AnalysisLanguage,
): Promise<void> {
	const spinner = ora(`Analyzing (${template.name})...`).start();
	try {
		const analysis = await analysisService(ctx, repo).analyzeSession(session.id, template, {
			language,
			extraInstructions: ctx.config.analysis.prompt,
		});
		spinner.succeed(`Analysis complete (${analysis.provider}/${analysis.model})`);
		console.log(chalk.bold(`\n--- ${template.name} ---\n`));
		console.log(analysis.content);
		console.log("");
	} catch (err) {
		spinner.fail(errorMessage(err));
		process.exitCode = 1;
	}
}

function parseLanguage(value: string | undefined, fallback: AnalysisLanguage): AnalysisLanguage {
	if (value === undefined) return fallback;
	return value === "en" ? "en" : "pt-BR";
}

function parseDuration(value: string | undefined): number | null {
	if (value === undefined) return null;
	const seconds = Number(value);
	if (!Number.isFinite(seconds) || seconds <= 0) {
		throw new Error(`Invalid --duration: ${value} (expected seconds > 0)`);
	}
	return seconds;
}

export function createCli(): Command {
	const program = new Command();

	program
		.name("listen")
		.description("Record system audio, transcribe and summarize")
		.version("0.1.0");

	program
		.command("devices")
		.description("List available audio devices")
		.action(async () => {
			const capture = createCaptureAdapter(context().config.audio.backend);
			try {
				const devices = await capture.listDevices();
				console.log(chalk.bold("\nAvailable audio devices:\n"));
				for (const device of devices) {
					const marker = device.isDefault ? chalk.green("●") : " ";
					const kind = device.isMonitor ? "output" : "mic";
					console.log(`  ${marker} [${kind}] ${device.id}`);
				}
				console.log(chalk.gray(`\n  Use "${SYSTEM_DEFAULT_DEVICE}" to follow the OS default.\n`));
			} catch (err) {
				console.log(chalk.bold("\nAvailable audio devices:\n"));
				console.log(chalk.yellow(`  ${errorMessage(err)}\n`));
			}
		});

	program
		.command("record")
		.description("Record system audio (Ctrl+C to stop), then transcribe and analyze")
		.option("-d, --device <device>", "System audio (output) device, or @default")
		.option("-m, --mic <device>", "Microphone to mix in (or @default)")
		.option("--no-mic", "Record without a microphone")
		.option("--duration <seconds>", "Stop automatically after this many seconds")
		.option("-t, --template <template>", "Analysis template")
		.option("-l, --lang <language>", "Analysis language (pt-BR | en)")
		.option("--no-transcribe", "Only record (skip transcription and analysis)")
		.option("--no-analyze", "Skip analysis after recording")
		.action(async (opts) => {
			const ctx = context();
			const durationSec = parseDuration(opts.duration);
			fs.mkdirSync(ctx.dataDir, { recursive: true });
			const repo = new SQLiteRepository(ctx.dbPath);
			const recording = new RecordingService({
				capture: createCaptureAdapter(ctx.config.audio.backend),
				repo,
				storage: new LocalFileStorage(ctx.dataDir),
				audio: ctx.config.audio,
			});

			const devices = {
				system: (opts.device as string | undefined) ?? ctx.prefs.systemDevice,
				// commander: --mic <d> → string, --no-mic → false, neither → undefined
				mic:
					opts.mic === false ? null : typeof opts.mic === "string" ? opts.mic : ctx.prefs.micDevice,
			};
			const transcribe = opts.transcribe !== false;
			const analyze = transcribe && opts.analyze !== false;
			const template = analyze
				? resolveTemplate(repo, opts.template ?? ctx.prefs.defaultTemplateId)
				: null;
			if (analyze && !template) return;
			const language = parseLanguage(opts.lang, ctx.prefs.analysisLanguage);

			setupSignalHandlers();
			const session = await recording.start({ devices });
			console.log(chalk.bold(`\n🎙  Recording: ${session.title}`));
			console.log(chalk.gray(`   ${devices.system}${devices.mic ? ` + ${devices.mic}` : ""}`));
			console.log(
				chalk.gray(
					durationSec
						? `   Stopping after ${durationSec} s (or press Ctrl+C)\n`
						: "   Press Ctrl+C to stop\n",
				),
			);

			// One way out, whichever comes first: Ctrl+C, --duration, or the capture dying.
			let finished: Promise<void> | null = null;
			const finish = (): Promise<void> => {
				finished ??= (async () => {
					let settled: Session | null;
					let chunks: number;
					if (recording.getActive()) {
						const spinner = ora("Stopping recording...").start();
						const result = await recording.stop();
						settled = result.session;
						chunks = result.chunks;
						spinner.succeed(`Recording stopped (${chunks} chunk${chunks === 1 ? "" : "s"})`);
					} else {
						// Already settled by the service (capture interrupted).
						settled = repo.getSession(session.id);
						chunks = repo.getChunks(session.id).length;
					}
					if (chunks === 0) {
						console.log(chalk.red(settled?.lastError ?? "No audio was recorded."));
						process.exitCode = 1;
						return;
					}
					if (!transcribe || !settled) return;
					const transcript = await runTranscription(ctx, repo, settled);
					if (transcript && template) {
						await runAnalysis(ctx, repo, settled, template, language);
					}
				})();
				return finished;
			};

			// Non-fatal capture problems (e.g. a named device missing → the default is recorded).
			recording.onWarning((raw) => {
				console.log(chalk.yellow(`   ⚠ ${describeCaptureWarning(raw).message}`));
			});

			const done = new Promise<void>((resolve) => {
				recording.onInterrupted((interrupted) => {
					console.log(chalk.red(`\n${interrupted.lastError ?? "A gravação foi interrompida."}`));
					process.exitCode = 1;
					finish().finally(resolve);
				});
				if (durationSec) {
					setTimeout(() => finish().finally(resolve), durationSec * 1000);
				}
				// Ctrl+C: the signal handler awaits this, then exits.
				onShutdown(() => finish());
			});
			await done;
			repo.close();
		});

	program
		.command("list")
		.description("List recording sessions")
		.option("-n, --limit <number>", "Number of sessions to show", "10")
		.option("-q, --query <text>", "Search title and transcript")
		.action((opts) => {
			const ctx = context();
			if (!fs.existsSync(ctx.dbPath)) {
				console.log(chalk.yellow("No sessions found. Run 'listen record' first."));
				return;
			}
			const repo = new SQLiteRepository(ctx.dbPath);
			const sessions = repo.listSessions({ limit: Number(opts.limit), query: opts.query });
			if (sessions.length === 0) {
				console.log(chalk.yellow("No sessions found."));
				return;
			}
			console.log(chalk.bold("\nSessions:\n"));
			for (const s of sessions) {
				const color =
					s.status === "completed" ? chalk.green : s.status === "failed" ? chalk.red : chalk.yellow;
				console.log(
					`  ${chalk.gray(s.id.slice(0, 8))}  ${color(s.status.padEnd(12))}  ${s.startedAt ?? s.createdAt}  ${s.title ?? ""}`,
				);
			}
			console.log("");
		});

	program
		.command("show <sessionId>")
		.description("Show session details, transcript and analyses")
		.action((sessionId: string) => {
			const ctx = context();
			const repo = openExistingRepo(ctx);
			const session = repo && findSession(repo, sessionId);
			if (!repo || !session) return;

			const chunks = repo.getChunks(session.id);
			const duration = totalWavDurationSec(chunks.map((c) => c.path));
			console.log(chalk.bold(`\nSession: ${session.id}`));
			console.log(`  Title:    ${session.title ?? "-"}`);
			console.log(`  Status:   ${session.status}`);
			console.log(`  Started:  ${session.startedAt ?? "-"}`);
			console.log(`  Source:   ${session.audioSource ?? "-"}`);
			console.log(`  Audio:    ${chunks.length} chunk(s), ${Math.round(duration)} s`);
			if (session.lastError) console.log(chalk.red(`  Error:    ${session.lastError}`));
			console.log("");

			const transcript = repo.getTranscript(session.id);
			if (transcript) {
				console.log(chalk.bold("Transcript:"));
				console.log(chalk.gray(transcript.fullText.slice(0, 500)));
				if (transcript.fullText.length > 500) console.log(chalk.gray("..."));
				console.log("");
			}
			for (const a of repo.getAnalyses(session.id)) {
				console.log(
					chalk.bold(`Analysis (${repo.getTemplate(a.templateId)?.name ?? a.templateId}):`),
				);
				console.log(a.content);
				console.log("");
			}
		});

	program
		.command("transcribe <sessionId>")
		.description("Transcribe a recorded session (Groq needs GROQ_API_KEY)")
		.option("-t, --template <template>", "Template for the analysis after transcription")
		.option("-l, --lang <language>", "Analysis language (pt-BR | en)")
		.option("--no-analyze", "Skip analysis after transcription")
		.action(async (sessionId: string, opts) => {
			const ctx = context();
			const repo = openExistingRepo(ctx);
			const session = repo && findSession(repo, sessionId);
			if (!repo || !session) return;

			const transcript = await runTranscription(ctx, repo, session);
			if (!transcript) return;
			console.log(chalk.bold("\n--- Transcript ---\n"));
			console.log(transcript.fullText.slice(0, 1000));
			if (transcript.fullText.length > 1000) {
				console.log(chalk.gray("\n... (use 'listen show' to see full text)"));
			}
			console.log("");

			if (opts.analyze === false) return;
			const template = resolveTemplate(repo, opts.template ?? ctx.prefs.defaultTemplateId);
			if (template) {
				const language = parseLanguage(opts.lang, ctx.prefs.analysisLanguage);
				await runAnalysis(ctx, repo, session, template, language);
			}
		});

	program
		.command("analyze <sessionId>")
		.description("Run an analysis template on a transcribed session")
		.option("-t, --template <template>", "Analysis template")
		.option("-l, --lang <language>", "Analysis language (pt-BR | en)")
		.action(async (sessionId: string, opts) => {
			const ctx = context();
			const repo = openExistingRepo(ctx);
			const session = repo && findSession(repo, sessionId);
			if (!repo || !session) return;
			const template = resolveTemplate(repo, opts.template ?? ctx.prefs.defaultTemplateId);
			if (template) {
				const language = parseLanguage(opts.lang, ctx.prefs.analysisLanguage);
				await runAnalysis(ctx, repo, session, template, language);
			}
		});

	program
		.command("export <sessionId>")
		.description("Export a session to Markdown")
		.option("-o, --output <path>", "Output file path (default: print to stdout)")
		.action(async (sessionId: string, opts) => {
			const ctx = context();
			const repo = openExistingRepo(ctx);
			const session = repo && findSession(repo, sessionId);
			if (!repo || !session) return;

			const content = await new MarkdownExporter().export({
				session,
				transcript: repo.getTranscript(session.id),
				analyses: repo.getAnalyses(session.id),
				templates: repo.listTemplates(),
				durationSec: totalWavDurationSec(repo.getChunks(session.id).map((c) => c.path)),
			});
			if (opts.output) {
				fs.writeFileSync(opts.output, content, "utf-8");
				console.log(chalk.green(`Exported to ${opts.output}`));
			} else {
				console.log(content);
			}
		});

	program
		.command("templates")
		.description("List analysis templates")
		.action(() => {
			const ctx = context();
			const templates = fs.existsSync(ctx.dbPath)
				? new SQLiteRepository(ctx.dbPath).listTemplates()
				: [...BUILTIN_TEMPLATES];
			console.log(chalk.bold("\nAvailable templates:\n"));
			for (const t of templates) {
				const tag = t.builtin ? "" : chalk.magenta(" (custom)");
				console.log(`  ${chalk.cyan(t.id.padEnd(22))} ${t.name}${tag}`);
				if (t.description) console.log(chalk.gray(`  ${"".padEnd(22)} ${t.description}`));
			}
			console.log("");
		});

	return program;
}
