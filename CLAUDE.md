# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Listening Resume** is a cross-platform desktop app that captures system audio (meetings, lectures, podcasts), transcribes it via Groq Whisper, and generates AI summaries. It ships as a Tauri 2 desktop app (GUI) and a headless CLI.

## Monorepo Structure

pnpm workspaces with three packages:

- `packages/core/` — `@listening-resume/core`: shared business logic (hexagonal architecture)
- `apps/cli/` — `@listening-resume/cli`: Commander.js CLI
- `apps/gui/` — React 19 + Vite 6 frontend + Node.js API server + Tauri 2 desktop wrapper

## Common Commands

```bash
# Development
pnpm dev              # GUI dev mode: Vite (port 1420) + API server (port 3456) concurrently
pnpm dev:ui           # Vite only
pnpm dev:server       # API server only
pnpm listen           # Run CLI via tsx

# Build
pnpm build                          # Build all packages (tsup)
pnpm --filter gui build:windows     # Windows .exe (NSIS) — chains core→vite→server→deps→wasapi→smoke→tauri
pnpm --filter gui build:linux       # Linux .deb
pnpm --filter gui build:wasapi      # Rebuild ONLY the native WASAPI binary (fast; after editing wasapi_capture.rs)
pnpm --filter gui build:server      # Rebuild the production server bundle (esbuild → resources/server-bundle.mjs)
pnpm --filter gui smoke:server      # Boot the packaged bundle + GET /api/devices (build gate; needs port 3456 free)

# Test
pnpm test             # All tests
pnpm test:unit        # Unit tests (core package, vitest)
pnpm test:integration # Integration tests (core package)
pnpm test:e2e         # E2E tests (CLI)
pnpm test:watch       # Watch mode

# Lint & Format
pnpm lint             # Biome check across all packages
pnpm format           # Biome format --write
```

Running a single test file:
```bash
pnpm --filter @listening-resume/core exec vitest run src/path/to/file.test.ts
```

## Architecture

### Core Package — Hexagonal (Ports & Adapters)

```
packages/core/src/
├── domain/        # models.ts, states.ts, errors.ts — pure business types
├── ports/         # Interfaces: AudioCapturePort, TranscriberPort, AnalyzerPort, SessionRepositoryPort, FileStoragePort, ExporterPort
├── adapters/      # Implementations:
│   ├── audio/     # FFmpegWasapiAdapter (Windows), FFmpegPulseAdapter (Linux)
│   ├── transcription/ # GroqWhisperAdapter, WhisperCppAdapter
│   ├── analysis/  # OllamaAdapter, GroqLLMAdapter
│   └── persistence/   # SQLiteRepository (Drizzle ORM), LocalFileStorage, MarkdownExporter
├── application/   # RecordingService, TranscriptionService, AnalysisService
├── config/        # Zod schema + loader (.env + TOML)
└── utils/         # logger, rate-limiter (sliding window for Groq quotas), signal-handler
```

### GUI Package — Frontend + Embedded Server

- `apps/gui/src/` — React frontend with Zustand state, `features/` holds page components (dashboard, recording, sessions, settings)
- `apps/gui/server.ts` — Node.js HTTP API server on port 3456; all recording/transcription/analysis logic proxied through here
- `apps/gui/src-tauri/` — Rust/Tauri wrapper; `src/bin/wasapi_capture.rs` is the native Windows audio capture binary
- Vite dev server (port 1420) proxies `/api` → `localhost:3456`

### Session State Machine

```
created → recording → stopped → transcribing → transcribed → analyzing → completed
                                                                ↑ (re-analyze allowed)
Any state → failed
```

### Data Flow

1. **Record**: capture writes WAV chunks (default 120s each) → `{dataDir}/sessions/{id}/audio/`. Windows uses the native `wasapi-capture` binary; Linux uses FFmpeg. **Chunks are written at the device's NATIVE format** (e.g. 48000 Hz stereo), not at the config `sampleRate`/`channels`.
2. **Transcribe**: Groq Whisper processes each chunk (rate-limited: 18 RPM, 7000 audio sec/hr)
3. **Analyze**: Ollama (primary) → Groq fallback; user selects a template (meeting-summary, action-items, custom)
4. **Export**: MarkdownExporter combines session + transcript + analyses

## Configuration

- API keys in `.env` at workspace root (see `.env.example`) or `~/.config/listening-resume/.env`
- Runtime config editable through GUI Settings (persisted via POST `/api/config/groq-key`)
- Config schema validated with Zod in `packages/core/src/config/schema.ts`
- Data dir (sessions, sqlite) — Windows: `%LOCALAPPDATA%\listening-resume`; Linux: `~/.local/share/listening-resume`
- Config `.env` dir — Windows: `%APPDATA%\listening-resume\.env`; Linux: `~/.config/listening-resume/.env`
- Default audio device — Windows: `Stereo Mix`; Linux: `default.monitor`

## Toolchain

| Concern | Tool |
|---------|------|
| Build (core/cli) | tsup |
| Build (GUI) | Vite 6 |
| Desktop | Tauri 2 (Rust) |
| Test | Vitest |
| Lint/Format | Biome (tabs, 100-char lines, organize imports) |
| ORM | Drizzle ORM + better-sqlite3 |
| Validation | Zod |

All packages use ES modules (`"type": "module"`) and TypeScript strict mode.

## Platform Notes

- Windows audio capture uses a native Rust binary (`wasapi-capture`, source `src/bin/wasapi_capture.rs`) bundled by Tauri; Linux uses FFmpeg with PipeWire/PulseAudio
- The Tauri build targets are configured in `apps/gui/src-tauri/tauri.conf.json` and `tauri.windows.conf.json`
- `scripts/build-server.mjs` (esbuild) bundles the server into `resources/server-bundle.mjs` for production packaging; native modules can't be bundled and are copied alongside

## Gotchas & Hard-Won Knowledge

**Audio / duration**
- `wasapi-capture` records at the device's **native format** (e.g. 48 kHz stereo), ignoring `config.sampleRate`/`channels`. Compute duration from the **WAV header**, never from config. The GUI server does this in `getAudioDuration` (`server.ts`) by reading each chunk's header — this is separate from `RecordingService` (used by the CLI).
- The capture loop is **wall-clock paced**: it emits the number of frames real time demands, filling silence when loopback delivers none (loopback is silent + fires no event when nothing plays). This keeps duration accurate and lets mic-only recordings work.
- Mic is mixed into the loopback stream with resample + a **soft limiter** (avoid clipping / "estourado"). Linux mirrors this with ffmpeg `alimiter`.
- Live **mute** on Windows = stdin commands to the binary (`mute-sys`, `unmute-sys`, `mute-mic`, `unmute-mic`) → atomic flags read per frame. `FFmpegWasapiAdapter.setInputMute` writes them.
- "Test Sound" on Windows routes to the selected device via the binary's `--play-tone --device` (SoundPlayer can only reach the default device; ffplay isn't always present).

**Dev / runtime**
- Only one process can bind **port 3456**. The installed app AND `pnpm dev` both want it — free it before builds (the smoke-test needs it) and before starting dev. Kill stragglers: `node.exe` whose command line matches `*server*`.
- `node --watch` (dev:server) **reloads on file changes and clears in-memory state** (`activeSessionId`, playback handles). A reload mid-recording orphans the session — boot-reconcile then marks it stopped/failed.
- UI is testable via **Playwright MCP** (configured) against `http://localhost:1420`. Key controls carry `data-testid` / `aria-label` (e.g. `session-card`, `recording-device-select`, `stop-recording-button`).

**Packaging (the fragile part)**
- `build-server.mjs` copies native modules (`better-sqlite3` + `bindings`, `file-uri-to-path`, `drizzle-orm`) from the pnpm store by **dynamic version match**; it aborts the build if any is missing. A missing/ABI-mismatched native module crashes the packaged server on boot (symptom: app stuck on "Loading devices…").
- `pnpm smoke:server` boots the bundle with the bundled node and probes `/api/devices` — it's a **build gate** in `build:windows`/`build:linux`.
- `download-deps-win.ps1` bundles `node.exe`, `ffmpeg.exe`, `ffplay.exe` into `resources/bin/`. The bundled node version is **ABI-coupled** to the better-sqlite3 prebuild.
- The installed Tauri webview's origin is `http://tauri.localhost` (Windows) / `tauri://localhost` (mac/Linux) — **origin guards must allow these** or the installed app gets 403 (bit the Groq-key endpoint).
- The backend node process is spawned hidden on Windows via `CREATE_NO_WINDOW` (`src-tauri/src/lib.rs`).

**Generated artifacts (gitignored, do not commit / do not hand-edit)**
- `resources/server-bundle.mjs`, `resources/bin/`, `resources/node_modules/`, `src-tauri/binaries/`, `src-tauri/target/`, installers (`*.exe`/`*.msi`).
