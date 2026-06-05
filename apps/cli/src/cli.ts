import fs from "node:fs";
import path from "node:path";
import {
	AnalysisService,
	FFmpegPulseAdapter,
	FFmpegWasapiAdapter,
	GroqLLMAdapter,
	GroqWhisperAdapter,
	getTemplate,
	LocalFileStorage,
	listTemplates,
	loadConfig,
	MarkdownExporter,
	OllamaAdapter,
	onShutdown,
	RecordingService,
	resolveDataDir,
	SQLiteRepository,
	setupSignalHandlers,
	TranscriptionService,
} from "@listening-resume/core";
import chalk from "chalk";
import { Command } from "commander";
import ora from "ora";

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
			const capture =
				process.platform === "win32" ? new FFmpegWasapiAdapter() : new FFmpegPulseAdapter();
			const devices = await capture.listDevices();
			console.log(chalk.bold("\nAvailable audio devices:\n"));
			for (const device of devices) {
				const marker = device.isDefault ? chalk.green("●") : " ";
				console.log(`  ${marker} ${device.id} (${device.name})`);
			}
			console.log("");
		});

	program
		.command("record")
		.description("Start recording system audio (Ctrl+C to stop)")
		.option("-d, --device <device>", "Audio device to record from")
		.option("-t, --template <template>", "Analysis template", "meeting-summary")
		.option("--no-analyze", "Skip analysis after recording")
		.action(async (opts) => {
			const config = loadConfig();
			const dataDir = resolveDataDir(config);
			const dbPath = path.join(dataDir, "listening-resume.db");

			fs.mkdirSync(dataDir, { recursive: true });

			const repo = new SQLiteRepository(dbPath);
			const storage = new LocalFileStorage(dataDir);
			const capture =
				process.platform === "win32" ? new FFmpegWasapiAdapter() : new FFmpegPulseAdapter();

			const recordingService = new RecordingService(capture, repo, storage);

			const device = opts.device ?? config.audio.device;

			console.log(chalk.bold(`\n🎙  Recording from: ${device}`));
			console.log(chalk.gray("   Press Ctrl+C to stop\n"));

			setupSignalHandlers();

			const session = await recordingService.startRecording(device, {
				sampleRate: config.audio.sampleRate,
				channels: config.audio.channels,
				chunkSeconds: config.audio.chunkSeconds,
			});

			onShutdown(async () => {
				const spinner = ora("Stopping recording...").start();
				await recordingService.stopRecording(session.id);
				spinner.succeed("Recording stopped");

				// Transcription
				const groqKey = process.env.GROQ_API_KEY;
				if (!groqKey) {
					console.log(chalk.yellow("\n⚠  GROQ_API_KEY not set. Skipping transcription."));
					return;
				}

				const transcriber = new GroqWhisperAdapter(groqKey, config.transcription.model);
				const transcriptionService = new TranscriptionService(transcriber, repo, {
					requestsPerMinute: config.rateLimits.groqRpm,
					audioSecondsPerHour: config.rateLimits.groqAudioSecondsPerHour,
				});

				const tSpinner = ora("Transcribing...").start();
				const transcript = await transcriptionService.transcribeSession(
					session.id,
					config.transcription.language,
					config.transcription.prompt || undefined,
				);
				tSpinner.succeed(`Transcribed (${transcript.segments.length} segments)`);

				// Analysis
				if (opts.analyze !== false) {
					const template = getTemplate(opts.template);
					if (!template) {
						console.log(
							chalk.yellow(`\n⚠  Template "${opts.template}" not found. Skipping analysis.`),
						);
						return;
					}

					const analyzer = new OllamaAdapter(config.analysis.model);
					const fallback = groqKey
						? new GroqLLMAdapter(groqKey, config.analysis.fallback?.model)
						: null;
					const analysisService = new AnalysisService(analyzer, fallback, repo);

					const aSpinner = ora("Analyzing...").start();
					const analysis = await analysisService.analyzeSession(
						session.id,
						template,
						config.analysis.prompt || undefined,
					);
					aSpinner.succeed("Analysis complete");

					console.log(chalk.bold("\n--- Summary ---\n"));
					console.log(analysis.content);
					console.log("");
				}
			});

			// Keep alive until signal
			await new Promise(() => {});
		});

	program
		.command("list")
		.description("List recording sessions")
		.option("-n, --limit <number>", "Number of sessions to show", "10")
		.action((opts) => {
			const config = loadConfig();
			const dataDir = resolveDataDir(config);
			const dbPath = path.join(dataDir, "listening-resume.db");

			if (!fs.existsSync(dbPath)) {
				console.log(chalk.yellow("No sessions found. Run 'listen record' first."));
				return;
			}

			const repo = new SQLiteRepository(dbPath);
			const sessions = repo.listSessions(Number(opts.limit));

			if (sessions.length === 0) {
				console.log(chalk.yellow("No sessions found."));
				return;
			}

			console.log(chalk.bold("\nSessions:\n"));
			for (const s of sessions) {
				const statusColor =
					s.status === "completed" ? chalk.green : s.status === "failed" ? chalk.red : chalk.yellow;
				console.log(
					`  ${chalk.gray(s.id.slice(0, 8))}  ${statusColor(s.status.padEnd(12))}  ${s.startedAt ?? s.createdAt}`,
				);
			}
			console.log("");
		});

	program
		.command("show <sessionId>")
		.description("Show session details, transcript and analysis")
		.action((sessionId) => {
			const config = loadConfig();
			const dataDir = resolveDataDir(config);
			const dbPath = path.join(dataDir, "listening-resume.db");

			if (!fs.existsSync(dbPath)) {
				console.log(chalk.yellow("No database found."));
				return;
			}

			const repo = new SQLiteRepository(dbPath);

			// Support partial ID match
			const sessions = repo.listSessions(100);
			const session = sessions.find((s) => s.id.startsWith(sessionId));

			if (!session) {
				console.log(chalk.red(`Session not found: ${sessionId}`));
				return;
			}

			console.log(chalk.bold(`\nSession: ${session.id}`));
			console.log(`  Status: ${session.status}`);
			console.log(`  Started: ${session.startedAt}`);
			console.log(`  Source: ${session.audioSource}`);
			console.log("");

			const transcript = repo.getTranscript(session.id);
			if (transcript) {
				console.log(chalk.bold("Transcript:"));
				console.log(chalk.gray(transcript.fullText.slice(0, 500)));
				if (transcript.fullText.length > 500) console.log(chalk.gray("..."));
				console.log("");
			}

			const analyses = repo.getAnalyses(session.id);
			for (const a of analyses) {
				console.log(chalk.bold(`Analysis (${a.templateId}):`));
				console.log(a.content);
				console.log("");
			}
		});

	program
		.command("transcribe <sessionId>")
		.description("Transcribe a recorded session (requires GROQ_API_KEY in .env)")
		.option("-t, --template <template>", "Run analysis after transcription", "meeting-summary")
		.option("--no-analyze", "Skip analysis after transcription")
		.action(async (sessionId, opts) => {
			const config = loadConfig();
			const dataDir = resolveDataDir(config);
			const dbPath = path.join(dataDir, "listening-resume.db");

			const repo = new SQLiteRepository(dbPath);

			const sessions = repo.listSessions(100);
			const session = sessions.find((s) => s.id.startsWith(sessionId));
			if (!session) {
				console.log(chalk.red(`Session not found: ${sessionId}`));
				return;
			}

			const groqKey = process.env.GROQ_API_KEY;
			if (!groqKey) {
				console.log(chalk.red("GROQ_API_KEY not set. Create a .env file with your key."));
				console.log(chalk.gray("Get a free key at: https://console.groq.com"));
				return;
			}

			const transcriber = new GroqWhisperAdapter(groqKey, config.transcription.model);
			const transcriptionService = new TranscriptionService(transcriber, repo, {
				requestsPerMinute: config.rateLimits.groqRpm,
				audioSecondsPerHour: config.rateLimits.groqAudioSecondsPerHour,
			});

			const spinner = ora("Transcribing...").start();
			const transcript = await transcriptionService.transcribeSession(
				session.id,
				config.transcription.language,
				config.transcription.prompt || undefined,
			);
			spinner.succeed(
				`Transcribed (${transcript.segments.length} segments, ${transcript.fullText.length} chars)`,
			);

			console.log(chalk.bold("\n--- Transcript ---\n"));
			console.log(transcript.fullText.slice(0, 1000));
			if (transcript.fullText.length > 1000)
				console.log(chalk.gray("\n... (use 'listen show' to see full text)"));
			console.log("");

			if (opts.analyze !== false) {
				const template = getTemplate(opts.template);
				if (!template) {
					console.log(chalk.yellow(`Template "${opts.template}" not found. Skipping analysis.`));
					return;
				}

				const analyzer = new OllamaAdapter(config.analysis.model);
				const fallback = new GroqLLMAdapter(groqKey, config.analysis.fallback?.model);
				const analysisService = new AnalysisService(analyzer, fallback, repo);

				const aSpinner = ora("Analyzing...").start();
				const analysis = await analysisService.analyzeSession(
					session.id,
					template,
					config.analysis.prompt || undefined,
				);
				aSpinner.succeed("Analysis complete");

				console.log(chalk.bold(`\n--- ${template.name} ---\n`));
				console.log(analysis.content);
				console.log("");
			}
		});

	program
		.command("analyze <sessionId>")
		.description("Run analysis on an existing session")
		.option("-t, --template <template>", "Analysis template", "meeting-summary")
		.action(async (sessionId, opts) => {
			const config = loadConfig();
			const dataDir = resolveDataDir(config);
			const dbPath = path.join(dataDir, "listening-resume.db");

			const repo = new SQLiteRepository(dbPath);

			const sessions = repo.listSessions(100);
			const session = sessions.find((s) => s.id.startsWith(sessionId));
			if (!session) {
				console.log(chalk.red(`Session not found: ${sessionId}`));
				return;
			}

			const template = getTemplate(opts.template);
			if (!template) {
				console.log(chalk.red(`Template not found: ${opts.template}`));
				console.log(
					"Available:",
					listTemplates()
						.map((t) => t.id)
						.join(", "),
				);
				return;
			}

			const groqKey = process.env.GROQ_API_KEY;
			const analyzer = new OllamaAdapter(config.analysis.model);
			const fallback = groqKey
				? new GroqLLMAdapter(groqKey, config.analysis.fallback?.model)
				: null;
			const analysisService = new AnalysisService(analyzer, fallback, repo);

			const spinner = ora("Analyzing...").start();
			const analysis = await analysisService.analyzeSession(
				session.id,
				template,
				config.analysis.prompt || undefined,
			);
			spinner.succeed("Analysis complete");

			console.log(chalk.bold(`\n--- ${template.name} ---\n`));
			console.log(analysis.content);
			console.log("");
		});

	program
		.command("export <sessionId>")
		.description("Export session to markdown")
		.option("-o, --output <path>", "Output file path")
		.action(async (sessionId, opts) => {
			const config = loadConfig();
			const dataDir = resolveDataDir(config);
			const dbPath = path.join(dataDir, "listening-resume.db");

			const repo = new SQLiteRepository(dbPath);

			const sessions = repo.listSessions(100);
			const session = sessions.find((s) => s.id.startsWith(sessionId));
			if (!session) {
				console.log(chalk.red(`Session not found: ${sessionId}`));
				return;
			}

			const transcript = repo.getTranscript(session.id);
			const analyses = repo.getAnalyses(session.id);

			const exporter = new MarkdownExporter();
			const content = await exporter.export({ session, transcript, analyses });

			if (opts.output) {
				fs.writeFileSync(opts.output, content, "utf-8");
				console.log(chalk.green(`Exported to ${opts.output}`));
			} else {
				console.log(content);
			}
		});

	program
		.command("templates")
		.description("List available analysis templates")
		.action(() => {
			const templates = listTemplates();
			console.log(chalk.bold("\nAvailable templates:\n"));
			for (const t of templates) {
				console.log(`  ${chalk.cyan(t.id.padEnd(20))} ${t.name}`);
			}
			console.log("");
		});

	return program;
}
