import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import {
  loadConfig,
  resolveDataDir,
  FFmpegPulseAdapter,
  FFmpegWasapiAdapter,
  GroqWhisperAdapter,
  OllamaAdapter,
  GroqLLMAdapter,
  SQLiteRepository,
  LocalFileStorage,
  RecordingService,
  TranscriptionService,
  AnalysisService,
  MarkdownExporter,
  logger,
} from "@listening-resume/core";

// Load .env from workspace root
const rootDir = path.resolve(import.meta.dirname, "../..");
const envPath = path.join(rootDir, ".env");
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Remove surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

const config = loadConfig();
const dataDir = resolveDataDir(config);
const dbPath = path.join(dataDir, "listening-resume.db");

fs.mkdirSync(dataDir, { recursive: true });

const repo = new SQLiteRepository(dbPath);
const storage = new LocalFileStorage(dataDir);
const capture =
  process.platform === "win32"
    ? new FFmpegWasapiAdapter()
    : new FFmpegPulseAdapter();
const recordingService = new RecordingService(capture, repo, storage);

let activeSessionId: string | null = null;
let recordingStartTime: number | null = null;

// Runtime Groq API key (from env or set via GUI)
let groqApiKey = process.env.GROQ_API_KEY || "";
const configDir =
  process.platform === "win32"
    ? path.join(
        process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
        "listening-resume",
      )
    : path.join(os.homedir(), ".config", "listening-resume");
const configEnvPath = path.join(configDir, ".env");
// Load key from config .env if not already set
if (!groqApiKey && fs.existsSync(configEnvPath)) {
  const envLines = fs.readFileSync(configEnvPath, "utf-8").split("\n");
  for (const line of envLines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("GROQ_API_KEY=")) {
      let val = trimmed.slice("GROQ_API_KEY=".length).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      groqApiKey = val;
    }
  }
  // Ensure restrictive file permissions (owner-only read/write) — Unix only
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(configEnvPath, 0o600);
      fs.chmodSync(configDir, 0o700);
    } catch {
      // Non-critical
    }
  }
}

function json(res: http.ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(data));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
  });
}

/** Calculate total audio duration (seconds) from WAV files on disk */
function getAudioDuration(
  sessionId: string,
  sampleRate = 16000,
  channels = 1,
): number {
  const audioDir = path.join(dataDir, "sessions", sessionId, "audio");
  if (!fs.existsSync(audioDir)) return 0;
  const wavFiles = fs
    .readdirSync(audioDir)
    .filter((f) => f.endsWith(".wav"))
    .sort();
  let totalBytes = 0;
  for (const f of wavFiles) {
    const stat = fs.statSync(path.join(audioDir, f));
    totalBytes += Math.max(0, stat.size - 44); // subtract WAV header
  }
  const bytesPerSecond = sampleRate * channels * 2; // 16-bit PCM
  return Math.round(totalBytes / bytesPerSecond);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost`);
  const route = url.pathname;

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  try {
    // POST /api/audio/test — play a test tone on the selected device
    if (route === "/api/audio/test" && req.method === "POST") {
      const body = await readBody(req);
      const { device } = body ? JSON.parse(body) : {};
      const audioDevice = device ?? config.audio.device;

      const testFile = path.join(dataDir, "test-tone.wav");
      const { execSync } = await import("node:child_process");
      try {
        // Generate tone file if it doesn't exist
        if (!fs.existsSync(testFile)) {
          execSync(
            `ffmpeg -y -f lavfi -i "sine=frequency=880:duration=0.5" -f lavfi -i "sine=frequency=660:duration=0.5" -f lavfi -i "sine=frequency=880:duration=0.5" -filter_complex "[0][1][2]concat=n=3:v=0:a=1" "${testFile}"`,
            { timeout: 5000, stdio: "pipe" },
          );
        }
        // Play test tone using platform-appropriate method
        if (process.platform === "win32") {
          execSync(`ffplay -nodisp -autoexit -loglevel quiet "${testFile}"`, {
            timeout: 5000,
            stdio: "pipe",
          });
        } else {
          // Strip .monitor suffix to get the sink name
          const sink = audioDevice.replace(/\.monitor$/, "");
          execSync(`pw-play --target="${sink}" "${testFile}"`, {
            timeout: 5000,
            stdio: "pipe",
          });
        }
      } catch {
        return json(res, { error: "Failed to play test sound" }, 500);
      }

      return json(res, { ok: true });
    }

    // GET /api/devices — list audio devices
    if (route === "/api/devices" && req.method === "GET") {
      const devices = await capture.listDevices();
      return json(res, { devices });
    }

    // GET /api/sessions — list sessions
    if (route === "/api/sessions" && req.method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const sessions = repo.listSessions(limit);
      // Enrich with chunk count + duration + transcript preview
      const enriched = sessions.map((s) => {
        const chunks = repo.getChunks(s.id);
        const duration = getAudioDuration(
          s.id,
          config.audio.sampleRate,
          config.audio.channels,
        );
        const transcript = repo.getTranscript(s.id);
        let preview: string | null = null;
        if (transcript && transcript.segments.length > 0) {
          const silenceArtifacts = [
            "thank you.",
            "thanks for watching.",
            "bye.",
            "you",
            "thanks.",
            "thank you for watching.",
            "off",
            "off.",
          ];
          const meaningful = transcript.segments.filter(
            (seg) => !silenceArtifacts.includes(seg.text.trim().toLowerCase()),
          );
          preview =
            meaningful
              .slice(0, 3)
              .map((seg) => seg.text.trim())
              .join(" ")
              .slice(0, 120) || null;
        }
        return {
          ...s,
          chunks: chunks.length,
          duration,
          preview,
        };
      });
      // Newest first
      enriched.sort(
        (a, b) =>
          new Date(b.startedAt ?? 0).getTime() -
          new Date(a.startedAt ?? 0).getTime(),
      );
      return json(res, { sessions: enriched });
    }

    // GET /api/sessions/:id — session detail
    if (
      route.startsWith("/api/sessions/") &&
      req.method === "GET" &&
      route.split("/").length === 4
    ) {
      const id = route.split("/")[3];
      if (!id) return json(res, { error: "Missing session ID" }, 400);

      // Support partial ID
      const sessions = repo.listSessions(200);
      const session = sessions.find((s) => s.id.startsWith(id));
      if (!session) return json(res, { error: "Session not found" }, 404);

      const chunks = repo.getChunks(session.id);
      const transcript = repo.getTranscript(session.id);
      const analyses = repo.getAnalyses(session.id);
      const duration = getAudioDuration(
        session.id,
        config.audio.sampleRate,
        config.audio.channels,
      );

      return json(res, {
        session: {
          ...session,
          chunks: chunks.length,
          duration,
        },
        transcript: transcript
          ? {
              segments: transcript.segments,
              fullText: transcript.fullText,
              language: transcript.language,
              provider: transcript.provider,
              model: transcript.model,
            }
          : null,
        analyses,
      });
    }

    // POST /api/recording/start — start recording
    if (route === "/api/recording/start" && req.method === "POST") {
      if (activeSessionId) {
        return json(
          res,
          { error: "Already recording", sessionId: activeSessionId },
          409,
        );
      }

      const body = await readBody(req);
      const { device, micDevice } = body ? JSON.parse(body) : {};
      const audioDevice = device ?? config.audio.device;
      const mic = micDevice ?? config.audio.micDevice ?? undefined;

      const session = await recordingService.startRecording(audioDevice, {
        sampleRate: config.audio.sampleRate,
        channels: config.audio.channels,
        chunkSeconds: config.audio.chunkSeconds,
        micDevice: mic || undefined,
        micVolume: config.audio.micVolume,
      });

      activeSessionId = session.id;
      recordingStartTime = Date.now();
      logger.info(
        `GUI: Recording started — session ${session.id} on ${audioDevice}`,
      );
      return json(res, { session, startTime: recordingStartTime });
    }

    // POST /api/recording/stop — stop recording
    if (route === "/api/recording/stop" && req.method === "POST") {
      if (!activeSessionId) {
        return json(res, { error: "Not recording" }, 400);
      }

      const sessionId = activeSessionId;
      await recordingService.stopRecording(sessionId);
      activeSessionId = null;
      recordingStartTime = null;
      logger.info(`GUI: Recording stopped — session ${sessionId}`);

      // Get updated session
      const session = repo.getSession(sessionId);
      const chunks = repo.getChunks(sessionId);

      return json(res, {
        session,
        chunks: chunks.length,
      });
    }

    // GET /api/recording/status — current recording status
    if (route === "/api/recording/status" && req.method === "GET") {
      if (!activeSessionId) {
        return json(res, { recording: false });
      }
      const chunks = repo.getChunks(activeSessionId);
      return json(res, {
        recording: true,
        sessionId: activeSessionId,
        startTime: recordingStartTime,
        chunks: chunks.length,
      });
    }

    // POST /api/recording/mute — mute/unmute mic or system audio (recording only, not system-wide)
    if (route === "/api/recording/mute" && req.method === "POST") {
      const body = await readBody(req);
      const { target, muted } = body ? JSON.parse(body) : {};
      // target: "mic" | "system"
      if (!target || typeof muted !== "boolean") {
        return json(
          res,
          { error: "Invalid params: target and muted required" },
          400,
        );
      }
      if (!activeSessionId) {
        return json(res, { error: "No active recording" }, 400);
      }
      try {
        await (capture as any).setInputMute(target, muted);
        return json(res, { target, muted });
      } catch (err) {
        logger.warn(`Mute failed: ${err}`);
        return json(res, { error: "Mute command failed" }, 500);
      }
    }

    // GET /api/recording/levels — get current mute state of recording inputs
    if (route === "/api/recording/levels" && req.method === "GET") {
      if (!activeSessionId) {
        return json(res, {
          system: { volume: 1, muted: false },
          mic: { volume: 1, muted: false },
        });
      }
      try {
        const state = (capture as any).getInputMuteState();
        return json(res, {
          system: { volume: 1, muted: state.system },
          mic: { volume: 1, muted: state.mic },
        });
      } catch {
        return json(res, {
          system: { volume: 1, muted: false },
          mic: { volume: 1, muted: false },
        });
      }
    }

    // POST /api/sessions/:id/transcribe — transcribe a session
    if (
      route.match(/^\/api\/sessions\/[^/]+\/transcribe$/) &&
      req.method === "POST"
    ) {
      const id = route.split("/")[3];
      const sessions = repo.listSessions(200);
      const session = sessions.find((s) => s.id.startsWith(id!));
      if (!session) return json(res, { error: "Session not found" }, 404);

      if (!groqApiKey) {
        return json(
          res,
          { error: "GROQ_API_KEY not set. Configure in Settings." },
          500,
        );
      }

      const transcriber = new GroqWhisperAdapter(
        groqApiKey,
        config.transcription.model,
      );
      const transcriptionService = new TranscriptionService(transcriber, repo, {
        requestsPerMinute: config.rateLimits.groqRpm,
        audioSecondsPerHour: config.rateLimits.groqAudioSecondsPerHour,
      });

      repo.updateSession(session.id, { status: "transcribing" });
      const transcript = await transcriptionService.transcribeSession(
        session.id,
        config.transcription.language,
        config.transcription.prompt || undefined,
      );
      repo.updateSession(session.id, { status: "transcribed" });

      return json(res, {
        transcript: {
          segments: transcript.segments,
          fullText: transcript.fullText,
        },
      });
    }

    // POST /api/sessions/:id/analyze — analyze a session
    if (
      route.match(/^\/api\/sessions\/[^/]+\/analyze$/) &&
      req.method === "POST"
    ) {
      const id = route.split("/")[3];
      const sessions = repo.listSessions(200);
      const session = sessions.find((s) => s.id.startsWith(id!));
      if (!session) return json(res, { error: "Session not found" }, 404);

      const body = await readBody(req);
      const { templateId } = body ? JSON.parse(body) : {};
      const template = repo.getTemplate(
        templateId ?? config.analysis.defaultTemplate,
      );
      if (!template) return json(res, { error: "Template not found" }, 404);

      const analyzer = new OllamaAdapter(config.analysis.model);
      const fallback = groqApiKey
        ? new GroqLLMAdapter(groqApiKey, config.analysis.fallback?.model)
        : null;
      const analysisService = new AnalysisService(analyzer, fallback, repo);

      repo.updateSession(session.id, { status: "analyzing" });
      const analysis = await analysisService.analyzeSession(
        session.id,
        template,
      );
      repo.updateSession(session.id, { status: "completed" });

      return json(res, { analysis });
    }

    // DELETE /api/analyses/:id — delete a single analysis
    if (route.match(/^\/api\/analyses\/[^/]+$/) && req.method === "DELETE") {
      const id = decodeURIComponent(route.split("/")[3]);
      repo.deleteAnalysis(id);
      return json(res, { ok: true });
    }

    // GET /api/sessions/:id/audio — serve concatenated WAV audio
    if (
      route.match(/^\/api\/sessions\/[^/]+\/audio$/) &&
      req.method === "GET"
    ) {
      const id = route.split("/")[3];
      const sessions = repo.listSessions(200);
      const session = sessions.find((s) => s.id.startsWith(id!));
      if (!session) return json(res, { error: "Session not found" }, 404);

      const audioDir = path.join(dataDir, "sessions", session.id, "audio");
      if (!fs.existsSync(audioDir))
        return json(res, { error: "No audio files" }, 404);

      const chunks = fs
        .readdirSync(audioDir)
        .filter((f) => f.endsWith(".wav"))
        .sort();
      if (chunks.length === 0)
        return json(res, { error: "No audio files" }, 404);

      // For a single chunk, just stream the file directly
      if (chunks.length === 1) {
        const filePath = path.join(audioDir, chunks[0]);
        const stat = fs.statSync(filePath);
        res.writeHead(200, {
          "Content-Type": "audio/wav",
          "Content-Length": stat.size,
          "Access-Control-Allow-Origin": "*",
          "Accept-Ranges": "bytes",
        });
        fs.createReadStream(filePath).pipe(res);
        return;
      }

      // Multiple chunks: concatenate WAV files using ffmpeg (async to avoid blocking)
      const { exec } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execAsync = promisify(exec);
      const os = await import("node:os");
      const chunkPaths = chunks.map((c) => path.join(audioDir, c));
      const concatList = chunkPaths
        .map((p) => `file '${p.replace(/\\/g, "/")}'`)
        .join("\n");
      const listFile = path.join(os.tmpdir(), `concat_${session.id}.txt`);
      const outFile = path.join(os.tmpdir(), `audio_${session.id}.wav`);
      fs.writeFileSync(listFile, concatList);

      try {
        await execAsync(
          `ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${outFile}"`,
        );
        const stat = fs.statSync(outFile);
        res.writeHead(200, {
          "Content-Type": "audio/wav",
          "Content-Length": stat.size,
          "Access-Control-Allow-Origin": "*",
          "Accept-Ranges": "bytes",
        });
        fs.createReadStream(outFile).pipe(res);
      } catch (err) {
        return json(res, { error: "Failed to concatenate audio" }, 500);
      } finally {
        try {
          fs.unlinkSync(listFile);
        } catch {}
        // Clean up temp file after a delay
        setTimeout(() => {
          try {
            fs.unlinkSync(outFile);
          } catch {}
        }, 5000);
      }
      return;
    }

    // POST /api/sessions/:id/play — play audio via system player (bypasses WebKit)
    if (
      route.match(/^\/api\/sessions\/[^/]+\/play$/) &&
      req.method === "POST"
    ) {
      const id = route.split("/")[3];
      const sessions = repo.listSessions(200);
      const session = sessions.find((s) => s.id.startsWith(id!));
      if (!session) return json(res, { error: "Session not found" }, 404);

      const audioDir = path.join(dataDir, "sessions", session.id, "audio");
      if (!fs.existsSync(audioDir))
        return json(res, { error: "No audio files" }, 404);

      const chunks = fs
        .readdirSync(audioDir)
        .filter((f) => f.endsWith(".wav"))
        .sort();
      if (chunks.length === 0)
        return json(res, { error: "No audio files" }, 404);

      // Kill any existing playback
      if ((globalThis as any).__playbackProcess) {
        try {
          (globalThis as any).__playbackProcess.kill();
        } catch {}
        (globalThis as any).__playbackProcess = null;
      }

      const { spawn } = await import("node:child_process");
      let audioFile: string;

      if (chunks.length === 1) {
        audioFile = path.join(audioDir, chunks[0]);
      } else {
        // Concatenate chunks first
        const { promisify } = await import("node:util");
        const { exec } = await import("node:child_process");
        const execAsync = promisify(exec);
        const os = await import("node:os");
        const chunkPaths = chunks.map((c) => path.join(audioDir, c));
        const concatList = chunkPaths
          .map((p) => `file '${p.replace(/\\/g, "/")}'`)
          .join("\n");
        const listFile = path.join(os.tmpdir(), `concat_${session.id}.txt`);
        const outFile = path.join(os.tmpdir(), `play_${session.id}.wav`);
        fs.writeFileSync(listFile, concatList);
        try {
          await execAsync(
            `ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${outFile}"`,
          );
          fs.unlinkSync(listFile);
        } catch {
          return json(res, { error: "Failed to concatenate audio" }, 500);
        }
        audioFile = outFile;
      }

      // Parse seek time from body
      const body = await new Promise<string>((resolve) => {
        let data = "";
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => resolve(data));
      });
      const { seek } = body ? JSON.parse(body) : { seek: 0 };

      // Play via ffplay (headless, no video window)
      const args = ["-nodisp", "-autoexit", "-loglevel", "quiet"];
      if (seek && seek > 0) {
        args.push("-ss", String(seek));
      }
      args.push(audioFile);

      const proc = spawn("ffplay", args, { stdio: "ignore" });
      (globalThis as any).__playbackProcess = proc;
      (globalThis as any).__playbackStartTime = Date.now();
      (globalThis as any).__playbackSeekOffset = seek || 0;

      proc.on("close", () => {
        if ((globalThis as any).__playbackProcess === proc) {
          (globalThis as any).__playbackProcess = null;
        }
      });

      return json(res, {
        playing: true,
        startTime: Date.now(),
        seek: seek || 0,
      });
    }

    // DELETE /api/sessions/:id/play — stop playback
    if (
      route.match(/^\/api\/sessions\/[^/]+\/play$/) &&
      req.method === "DELETE"
    ) {
      if ((globalThis as any).__playbackProcess) {
        try {
          (globalThis as any).__playbackProcess.kill();
        } catch {}
        (globalThis as any).__playbackProcess = null;
      }
      return json(res, { playing: false });
    }

    // GET /api/playback/status — get current playback status
    if (route === "/api/playback/status" && req.method === "GET") {
      const proc = (globalThis as any).__playbackProcess;
      const isPlaying = proc !== null && proc !== undefined && !proc.killed;
      let currentTime = 0;
      if (isPlaying) {
        const elapsed =
          (Date.now() -
            ((globalThis as any).__playbackStartTime || Date.now())) /
          1000;
        currentTime = ((globalThis as any).__playbackSeekOffset || 0) + elapsed;
      }
      return json(res, { playing: isPlaying, currentTime });
    }

    // GET /api/templates — list templates
    if (route === "/api/templates" && req.method === "GET") {
      const templates = repo.listTemplates();
      return json(res, { templates });
    }

    // POST /api/templates — create template
    if (route === "/api/templates" && req.method === "POST") {
      const body = await readBody(req);
      const { name, userPromptTemplate } = body ? JSON.parse(body) : {};
      if (!name || !userPromptTemplate) {
        return json(
          res,
          { error: "name and userPromptTemplate are required" },
          400,
        );
      }
      if (!userPromptTemplate.includes("{{transcript}}")) {
        return json(
          res,
          { error: "userPromptTemplate must contain {{transcript}}" },
          400,
        );
      }
      const id = `custom-${Date.now().toString(36)}`;
      const template = repo.createTemplate({ id, name, userPromptTemplate });
      return json(res, { template }, 201);
    }

    // PUT /api/templates/:id — update template
    if (route.match(/^\/api\/templates\/[^/]+$/) && req.method === "PUT") {
      const id = decodeURIComponent(route.split("/")[3]);
      const body = await readBody(req);
      const { name, userPromptTemplate } = body ? JSON.parse(body) : {};
      if (
        userPromptTemplate &&
        !userPromptTemplate.includes("{{transcript}}")
      ) {
        return json(
          res,
          { error: "userPromptTemplate must contain {{transcript}}" },
          400,
        );
      }
      const template = repo.updateTemplate(id, { name, userPromptTemplate });
      if (!template) return json(res, { error: "Template not found" }, 404);
      return json(res, { template });
    }

    // DELETE /api/templates/:id — delete template (only custom)
    if (route.match(/^\/api\/templates\/[^/]+$/) && req.method === "DELETE") {
      const id = decodeURIComponent(route.split("/")[3]);
      const existing = repo.getTemplate(id);
      if (!existing) return json(res, { error: "Template not found" }, 404);
      if (existing.builtin) {
        return json(res, { error: "Cannot delete builtin templates" }, 400);
      }
      repo.deleteTemplate(id);
      return json(res, { ok: true });
    }

    // GET /api/config — current config
    if (route === "/api/config" && req.method === "GET") {
      return json(res, {
        audio: {
          device: config.audio.device,
          micDevice: config.audio.micDevice,
          micVolume: config.audio.micVolume,
          sampleRate: config.audio.sampleRate,
        },
        transcription: {
          provider: config.transcription.provider,
          model: config.transcription.model,
        },
        analysis: {
          provider: config.analysis.provider,
          model: config.analysis.model,
        },
        exportDir: config.storage.exportDir.replace(
          /^~/,
          process.env.HOME || "~",
        ),
        hasGroqKey: !!groqApiKey,
        maskedGroqKey: groqApiKey
          ? `gsk_${"*".repeat(8)}...${groqApiKey.slice(-4)}`
          : null,
      });
    }

    // POST /api/config/groq-key — set Groq API key
    if (route === "/api/config/groq-key" && req.method === "POST") {
      // Only allow requests from localhost origins
      const origin = req.headers.origin || req.headers.referer || "";
      if (
        origin &&
        !origin.match(/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?/)
      ) {
        return json(res, { error: "Forbidden" }, 403);
      }

      const body = await readBody(req);
      const { key } = body ? JSON.parse(body) : {};
      if (typeof key !== "string" || !key.trim()) {
        return json(res, { error: "key is required" }, 400);
      }

      const trimmedKey = key.trim();

      // Validate Groq key format
      if (!trimmedKey.match(/^gsk_[a-zA-Z0-9]{20,}$/)) {
        return json(
          res,
          { error: "Invalid Groq API key format. Must start with gsk_" },
          400,
        );
      }

      groqApiKey = trimmedKey;

      // Persist to config dir .env with restrictive permissions
      try {
        fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
        let envContent = "";
        if (fs.existsSync(configEnvPath)) {
          envContent = fs.readFileSync(configEnvPath, "utf-8");
        }
        const lines = envContent
          .split("\n")
          .filter((l) => !l.trim().startsWith("GROQ_API_KEY="));
        if (groqApiKey) {
          lines.push(`GROQ_API_KEY=${groqApiKey}`);
        }
        fs.writeFileSync(
          configEnvPath,
          lines.filter(Boolean).join("\n") + "\n",
          { mode: 0o600 },
        );
      } catch {
        // Non-critical — key is still set in memory
      }
      return json(res, { ok: true, hasGroqKey: !!groqApiKey });
    }

    // DELETE /api/config/groq-key — remove Groq API key
    if (route === "/api/config/groq-key" && req.method === "DELETE") {
      groqApiKey = "";
      try {
        if (fs.existsSync(configEnvPath)) {
          const envContent = fs.readFileSync(configEnvPath, "utf-8");
          const lines = envContent
            .split("\n")
            .filter((l) => !l.trim().startsWith("GROQ_API_KEY="));
          fs.writeFileSync(
            configEnvPath,
            lines.filter(Boolean).join("\n") + "\n",
            { mode: 0o600 },
          );
        }
      } catch {
        // Non-critical
      }
      return json(res, { ok: true, hasGroqKey: false });
    }

    // POST /api/config/mic — set microphone device
    if (route === "/api/config/mic" && req.method === "POST") {
      const body = await readBody(req);
      const { micDevice, micVolume } = body ? JSON.parse(body) : {};
      config.audio.micDevice = micDevice || null;
      if (micVolume !== undefined) {
        config.audio.micVolume = Math.max(0, Math.min(2, micVolume));
      }
      return json(res, {
        ok: true,
        micDevice: config.audio.micDevice,
        micVolume: config.audio.micVolume,
      });
    }

    // GET /api/sessions/:id/export — export session as markdown
    if (
      route.match(/^\/api\/sessions\/[^/]+\/export$/) &&
      req.method === "GET"
    ) {
      const id = route.split("/")[3];
      const sessions = repo.listSessions(200);
      const session = sessions.find((s) => s.id.startsWith(id!));
      if (!session) return json(res, { error: "Session not found" }, 404);

      const transcript = repo.getTranscript(session.id);
      const analyses = repo.getAnalyses(session.id);

      const exporter = new MarkdownExporter();
      const content = await exporter.export({ session, transcript, analyses });

      res.writeHead(200, {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="session-${session.id.slice(0, 8)}.md"`,
      });
      res.end(content);
      return;
    }

    // POST /api/sessions/:id/export/save — save export to disk
    if (
      route.match(/^\/api\/sessions\/[^/]+\/export\/save$/) &&
      req.method === "POST"
    ) {
      const id = route.split("/")[3];
      const sessions = repo.listSessions(200);
      const session = sessions.find((s) => s.id.startsWith(id!));
      if (!session) return json(res, { error: "Session not found" }, 404);

      const rawBody = await readBody(req);
      const { format = "markdown" } = rawBody ? JSON.parse(rawBody) : {};
      const exportDir = config.storage.exportDir.replace(
        /^~/,
        process.env.HOME || "~",
      );
      fs.mkdirSync(exportDir, { recursive: true });

      const title = session.title || `session-${session.id.slice(0, 8)}`;
      const safeTitle = title
        .replace(/[^a-zA-Z0-9\u00C0-\u024F _-]/g, "")
        .slice(0, 80);
      const dateStr = new Date(session.createdAt).toISOString().slice(0, 10);

      let filename: string;
      let content: string;

      if (format === "text") {
        const transcript = repo.getTranscript(session.id);
        content = transcript?.segments?.map((s) => s.text).join("\n") || "";
        filename = `${dateStr}_${safeTitle}.txt`;
      } else {
        const transcript = repo.getTranscript(session.id);
        const analyses = repo.getAnalyses(session.id);
        const exporter = new MarkdownExporter();
        content = await exporter.export({ session, transcript, analyses });
        filename = `${dateStr}_${safeTitle}.md`;
      }

      const filepath = path.join(exportDir, filename);
      fs.writeFileSync(filepath, content, "utf-8");
      logger.info(`GUI: Exported session to ${filepath}`);
      return json(res, { ok: true, path: filepath });
    }

    // GET /api/config/export-dir — get export directory
    if (route === "/api/config/export-dir" && req.method === "GET") {
      const exportDir = config.storage.exportDir.replace(
        /^~/,
        process.env.HOME || "~",
      );
      return json(res, { exportDir });
    }

    // POST /api/config/export-dir — set export directory
    if (route === "/api/config/export-dir" && req.method === "POST") {
      const rawBody = await readBody(req);
      const { dir } = rawBody ? JSON.parse(rawBody) : {};
      if (!dir || typeof dir !== "string") {
        return json(res, { error: "Missing dir" }, 400);
      }
      // Validate path exists or can be created
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {
        return json(res, { error: "Cannot create directory" }, 400);
      }
      config.storage.exportDir = dir;
      return json(res, { ok: true, exportDir: dir });
    }

    // DELETE /api/sessions/:id — delete a session
    if (route.match(/^\/api\/sessions\/[^/]+$/) && req.method === "DELETE") {
      const id = route.split("/")[3];
      const sessions = repo.listSessions(200);
      const session = sessions.find((s) => s.id.startsWith(id!));
      if (!session) return json(res, { error: "Session not found" }, 404);

      // Delete from database
      repo.deleteSession(session.id);

      // Delete audio files
      const sessionDir = path.join(dataDir, "sessions", session.id);
      if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true });
      }

      logger.info(`GUI: Deleted session ${session.id}`);
      return json(res, { ok: true });
    }

    // 404
    json(res, { error: "Not found" }, 404);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.error(`API error: ${message}`);
    json(res, { error: message }, 500);
  }
});

const PORT = 3456;
server.listen(PORT, () => {
  logger.info(`API server running on http://localhost:${PORT}`);
  console.log(`🎙  Listening Resume API — http://localhost:${PORT}`);
  console.log(`   Audio device: ${config.audio.device}`);
  console.log(`   Data dir: ${dataDir}`);
});
