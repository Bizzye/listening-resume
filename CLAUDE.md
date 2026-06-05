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
pnpm build            # Build all packages (tsup)
pnpm build:windows    # Build Windows .exe installer via Tauri
pnpm build:linux      # Build Linux .deb via Tauri

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

1. **Record**: FFmpeg captures 120s WAV chunks → `{dataDir}/sessions/{id}/audio/`
2. **Transcribe**: Groq Whisper processes each chunk (rate-limited: 18 RPM, 7000 audio sec/hr)
3. **Analyze**: Ollama (primary) → Groq fallback; user selects a template (meeting-summary, action-items, custom)
4. **Export**: MarkdownExporter combines session + transcript + analyses

## Configuration

- API keys in `.env` at workspace root (see `.env.example`) or `~/.config/listening-resume/.env`
- Runtime config editable through GUI Settings (persisted via POST `/api/config/groq-key`)
- Config schema validated with Zod in `packages/core/src/config/schema.ts`
- Platform defaults — Windows: `APPDATA\listening-resume`, `Stereo Mix` audio device; Linux: `~/.local/share/listening-resume`, `default.monitor`

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

- Windows audio capture uses a native Rust binary (`wasapi_capture`) bundled by Tauri; Linux uses FFmpeg with PipeWire/PulseAudio
- The Tauri build targets are configured in `apps/gui/src-tauri/tauri.conf.json` and `tauri.windows.conf.json`
- The GUI server bundles to a standalone `build-server.mjs` (esbuild) for production Tauri packaging
