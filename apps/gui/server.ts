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

// In the Tauri bundle, node.exe sits at resources/bin/ and ffmpeg.exe is alongside it.
// The Rust launcher prepends that dir to PATH, but add it here too as a safety net.
if (process.platform === "win32") {
  const bundledBin = path.join(path.dirname(process.execPath), "..", "bin");
  const altBin = path.dirname(process.execPath);
  // Dev mode runs via system node, so the bundled binaries aren't next to node.exe.
  // Fall back to the repo's src-tauri/resources/bin where download-deps-win.ps1 puts them.
  const devBin = path.join(import.meta.dirname, "src-tauri", "resources", "bin");
  for (const dir of [bundledBin, altBin, devBin]) {
    if (fs.existsSync(path.join(dir, "ffmpeg.exe"))) {
      process.env.PATH = `${dir}${path.delimiter}${process.env.PATH ?? ""}`;
      break;
    }
  }
}

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

// Prevent unhandled 'error' events on the capture adapter from crashing the server.
capture.on("error", (err: Error) => {
  logger.error(`[capture] ${err.message}`);
});

const recordingService = new RecordingService(capture, repo, storage);

// Boot reconcile: on a fresh server start nothing is actively recording or
// processing, yet a previous crash/restart can leave sessions stuck in a
// transient state ("recording", "transcribing", "analyzing"). Resolve them so
// the UI never shows a permanently-spinning badge.
try {
  for (const s of repo.listSessions(500)) {
    if (s.status === "recording") {
      const chunks = repo.getChunks(s.id);
      repo.updateSession(s.id, {
        status: chunks.length > 0 ? "stopped" : "failed",
        endedAt: s.endedAt ?? new Date().toISOString(),
      });
    } else if (s.status === "transcribing") {
      repo.updateSession(s.id, { status: "stopped" });
    } else if (s.status === "analyzing") {
      // If a transcript exists it reached "transcribed"; otherwise fall back.
      const hasTranscript = !!repo.getTranscript(s.id);
      repo.updateSession(s.id, {
        status: hasTranscript ? "transcribed" : "stopped",
      });
    }
  }
} catch (err) {
  logger.error(`[boot-reconcile] ${(err as Error).message}`);
}

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

function generateBeepWav(filePath: string): void {
  const sampleRate = 44100;
  const numSamples = Math.floor(sampleRate * 1.5);
  const buf = Buffer.alloc(44 + numSamples * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + numSamples * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(numSamples * 2, 40);
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const freq = t < 0.5 ? 880 : t < 1.0 ? 660 : 880;
    const sample = Math.sin(2 * Math.PI * freq * t) * 0.7 * 32767;
    buf.writeInt16LE(Math.round(sample), 44 + i * 2);
  }
  fs.writeFileSync(filePath, buf);
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

/** Calculate total audio duration (seconds) from WAV files on disk.
 * Reads each WAV header for its real sample rate / channels / bit depth —
 * the WASAPI adapter records at the device's native format (e.g. 48000 Hz
 * stereo), not the requested 16000/1, so assuming defaults overcounts. */
function getAudioDuration(sessionId: string): number {
  const audioDir = path.join(dataDir, "sessions", sessionId, "audio");
  if (!fs.existsSync(audioDir)) return 0;
  const wavFiles = fs
    .readdirSync(audioDir)
    .filter((f) => f.endsWith(".wav"))
    .sort();
  let totalSeconds = 0;
  for (const f of wavFiles) {
    const filePath = path.join(audioDir, f);
    try {
      const fd = fs.openSync(filePath, "r");
      const header = Buffer.alloc(4096);
      const read = fs.readSync(fd, header, 0, 4096, 0);
      fs.closeSync(fd);
      const stat = fs.statSync(filePath);

      // Walk the RIFF chunks instead of using fixed offsets: ffmpeg inserts a
      // LIST/INFO (and sometimes fact) chunk between `fmt ` and `data`, so the
      // data size never lives at offset 40 — reading it there yields the LIST
      // size (~26 bytes) and the duration collapses to 0:00.
      let channels = 0;
      let sampleRate = 0;
      let bitsPerSample = 0;
      let dataBytes = 0;
      let pos = 12; // skip RIFF / size / WAVE
      while (pos + 8 <= read) {
        const chunkId = header.toString("ascii", pos, pos + 4);
        const chunkSize = header.readUInt32LE(pos + 4);
        if (chunkId === "fmt ") {
          channels = header.readUInt16LE(pos + 10);
          sampleRate = header.readUInt32LE(pos + 12);
          bitsPerSample = header.readUInt16LE(pos + 22);
        } else if (chunkId === "data") {
          const dataOffset = pos + 8;
          const remaining = Math.max(0, stat.size - dataOffset);
          // Streaming WAVs write a 0 or stale size; trust file size when off.
          dataBytes =
            chunkSize === 0 || chunkSize > remaining ? remaining : chunkSize;
          break;
        }
        pos += 8 + chunkSize + (chunkSize & 1); // chunks are word-aligned
      }
      const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);
      if (bytesPerSecond > 0 && dataBytes > 0)
        totalSeconds += dataBytes / bytesPerSecond;
    } catch {
      // Fallback: assume 16-bit mono 16000 Hz if header unreadable
      const stat = fs.statSync(filePath);
      totalSeconds += Math.max(0, stat.size - 44) / 32000;
    }
  }
  return Math.round(totalSeconds);
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
        // Generate tone WAV in Node.js — no ffmpeg required
        if (!fs.existsSync(testFile)) {
          generateBeepWav(testFile);
        }
        // Play using platform-appropriate built-in tools
        if (process.platform === "win32") {
          // Strip "(Loopback)" suffix to get the render (output) device name for routing.
          const outputDevice = audioDevice.replace(/ \(Loopback\)$/i, "").trim();

          // Preferred: native WASAPI binary renders the tone directly to the selected
          // device. SoundPlayer (the fallback) can only reach the system default.
          let routedToDevice = false;
          if (
            capture instanceof FFmpegWasapiAdapter &&
            (capture as FFmpegWasapiAdapter).hasNativeBinary
          ) {
            try {
              await (capture as FFmpegWasapiAdapter).playTestTone(outputDevice);
              routedToDevice = true;
            } catch {
              // Native tone failed — fall through to SoundPlayer (default device).
            }
          }

          if (!routedToDevice) {
            const psPath = testFile.replace(/\\/g, "/");
            execSync(
              `powershell -NoProfile -Command "$sp = New-Object System.Media.SoundPlayer '${psPath}'; $sp.PlaySync()"`,
              { timeout: 5000, stdio: "pipe" },
            );
          }
        } else {
          // Strip .monitor suffix to get the PipeWire sink name
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
        const duration = getAudioDuration(s.id);
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
      const duration = getAudioDuration(session.id);

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
      if (typeof (capture as any).setInputMute !== "function") {
        return json(res, { target, muted, supported: false });
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
      let transcript: Awaited<
        ReturnType<typeof transcriptionService.transcribeSession>
      >;
      try {
        transcript = await transcriptionService.transcribeSession(
          session.id,
          config.transcription.language,
          config.transcription.prompt || undefined,
        );
      } catch (err) {
        // Roll back so the session doesn't stay stuck in "transcribing".
        repo.updateSession(session.id, { status: "stopped" });
        throw err;
      }
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

      // Don't enter "analyzing" if there's nothing to analyze.
      const existingTranscript = repo.getTranscript(session.id);
      if (!existingTranscript) {
        return json(
          res,
          { error: "No transcript found for session. Transcribe first." },
          400,
        );
      }

      const ollama = new OllamaAdapter(config.analysis.model);
      const groq = groqApiKey
        ? new GroqLLMAdapter(
            groqApiKey,
            config.analysis.fallback?.model ?? "llama-3.3-70b-versatile",
          )
        : null;
      // Respect the configured provider. Groq (cloud 70b, 128k context) extracts
      // far more from long lectures; Ollama (local 8b) is the private, free option.
      // Whichever isn't primary becomes the automatic fallback.
      const groqPrimary = config.analysis.provider === "groq" && groq !== null;
      const analyzer = groqPrimary ? groq : ollama;
      const fallback = groqPrimary ? ollama : groq;
      const analysisService = new AnalysisService(analyzer, fallback, repo);

      const prevStatus = session.status;
      repo.updateSession(session.id, { status: "analyzing" });
      let analysis: Awaited<
        ReturnType<typeof analysisService.analyzeSession>
      >;
      try {
        analysis = await analysisService.analyzeSession(session.id, template);
      } catch (err) {
        // Roll back so the session doesn't stay stuck in "analyzing".
        repo.updateSession(session.id, {
          status: prevStatus === "completed" ? "completed" : "transcribed",
        });
        throw err;
      }
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

      // Check if ffplay is available; on Windows fall back to PowerShell SoundPlayer.
      let ffplayAvailable = true;
      if (process.platform === "win32") {
        try {
          const { execSync: es } = await import("node:child_process");
          es("where ffplay", { stdio: "pipe", timeout: 2000 });
        } catch {
          ffplayAvailable = false;
        }
      }

      let proc: import("node:child_process").ChildProcess;
      if (ffplayAvailable) {
        // Play via ffplay (headless, no video window)
        const args = ["-nodisp", "-autoexit", "-loglevel", "quiet"];
        if (seek && seek > 0) args.push("-ss", String(seek));
        args.push(audioFile);
        proc = spawn("ffplay", args, { stdio: "ignore" });
      } else {
        // Windows fallback: PowerShell System.Media.SoundPlayer. SoundPlayer can't
        // seek — it always plays the file from the start. To honor a seek, trim the
        // WAV from the seek point into a temp file with the bundled ffmpeg, then play
        // that. (-ss before -i is sample-accurate for PCM WAV since every sample is a
        // seek point, and fast.)
        let fileToPlay = audioFile;
        if (seek && seek > 0) {
          try {
            const os = await import("node:os");
            const { promisify } = await import("node:util");
            const { exec } = await import("node:child_process");
            const execAsync = promisify(exec);
            const seekFile = path.join(os.tmpdir(), `seek_${session.id}.wav`);
            // -bitexact suppresses ffmpeg's ISFT metadata chunk so the data chunk
            // stays at the standard offset — keeps SoundPlayer happy.
            await execAsync(
              `ffmpeg -y -loglevel quiet -bitexact -ss ${seek} -i "${audioFile}" -bitexact "${seekFile}"`,
            );
            fileToPlay = seekFile;
          } catch {
            // ffmpeg trim failed — play from start rather than not at all.
            fileToPlay = audioFile;
          }
        }
        const safeFile = fileToPlay.replace(/'/g, "''");
        proc = spawn(
          "powershell",
          [
            "-NoProfile", "-NonInteractive", "-Command",
            `$sp = New-Object System.Media.SoundPlayer '${safeFile}'; $sp.PlaySync()`,
          ],
          { stdio: "ignore" },
        );
      }

      // Always guard against spawn errors to prevent server crash.
      proc.on("error", (err) => {
        logger.error(`Playback spawn error: ${err.message}`);
        if ((globalThis as any).__playbackProcess === proc) {
          (globalThis as any).__playbackProcess = null;
        }
      });

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
        backend: ffplayAvailable ? "ffplay" : "powershell",
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
      // Clean up the seek-trim temp file (created by the SoundPlayer fallback path).
      const playId = route.split("/")[3];
      if (playId) {
        const sessions = repo.listSessions(200);
        const sess = sessions.find((s) => s.id.startsWith(playId));
        if (sess) {
          const seekFile = path.join(os.tmpdir(), `seek_${sess.id}.wav`);
          fs.rmSync(seekFile, { force: true });
        }
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
      // Only allow requests from local origins. This includes the Vite dev server
      // (http://localhost:1420) AND the packaged Tauri webview, whose origin is
      // `http://tauri.localhost` (Windows/WebView2) or `tauri://localhost`
      // (macOS/Linux) — the old localhost-only check rejected those with a 403,
      // surfacing as "Erro ao salvar a chave" in the installed app.
      const origin = req.headers.origin || req.headers.referer || "";
      if (
        origin &&
        !origin.match(
          /^(https?|tauri):\/\/(localhost|127\.0\.0\.1|tauri\.localhost)(:\d+)?(\/|$)/,
        )
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

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} already in use. Kill the other process and retry.`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  logger.info(`API server running on http://localhost:${PORT}`);
  console.log(`API server running on http://localhost:${PORT}`);
  console.log(`   Audio device: ${config.audio.device}`);
  console.log(`   Data dir: ${dataDir}`);
});

// On SIGTERM (sent by Node watch mode on restart) exit immediately so the port
// is released before the new instance tries to bind.
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
