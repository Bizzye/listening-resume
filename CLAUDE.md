# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Listening Resume** is a Windows-first desktop app (Tauri 2) that records system audio (WASAPI loopback) mixed with the microphone, transcribes it (Groq Whisper or whisper.cpp), and generates notes with AI (Ollama, with Groq as fallback) from pt-BR templates. Exports go to md, pdf or docx. A headless CLI shares the same core. The full design and refactor report is in `docs/RELATORIO.md` (pt-BR). Note: `docs/` is local-only (gitignored) except `docs/images/` (README screenshots), so the report and `docs/design/` exist only in a local checkout that has them.

Language rule: code and comments are in English. **Every user-visible string is pt-BR** (UI copy, API error messages, `lastError`). The UI is a faithful port of `docs/design/` (do not edit that folder; it is the visual source of truth).

## Monorepo Structure

This is a pnpm 12 workspace (`pnpm-workspace.yaml`).

- `packages/core/`: `@listening-resume/core`, hexagonal business logic, built by tsup to `dist/`.
  - Main entry (Node-only) exports everything.
  - **`@listening-resume/core/shared`** (`src/shared.ts`) is the **browser-safe** subpath: constants, types (incl. the wire types `Session`, `SessionSummary`, `TranscriptSegment`, `Analysis`, `Settings` — the UI and server reuse them instead of redeclaring), `SESSION_STATUS_LABELS`, templates, `parseFlashcards`, `stripInlineMarkdown`, formatters. The UI may import **only** this, and only via `apps/gui/src/shared/lib/core-shared.ts`.
- `apps/cli/`: `@listening-resume/cli` (Commander).
- `apps/gui/`: React 19 + Vite 6 UI, Node API server, Tauri 2 shell, and the Rust capture binary.

Consumers (GUI server, UI, CLI) import core from **`dist/`**. After editing core, run `pnpm --filter @listening-resume/core build` (or `… dev` for tsup watch). The dev server only reloads when `dist/` changes.

## Common Commands

```bash
pnpm dev                       # Vite :1420 + API :3456 (gui `dev`)
pnpm --filter gui dev:ui       # Vite only
pnpm --filter gui dev:server   # API only (node --watch on server.ts, server/, ../../packages/core/dist)
pnpm listen <cmd>              # CLI via tsx (devices, record, list, show, transcribe, analyze, export, templates)

pnpm build                     # all packages
pnpm --filter gui build:windows  # core → vite → build:server → download-deps → build:wasapi → smoke:server → tauri (NSIS + MSI) → collect:installers
pnpm --filter gui collect:installers  # copy newest installers to <repo>/exe/LR-<YYYY-MM-DD>-<version>{-setup.exe,.msi,.deb} (date = build date)
pnpm --filter gui build:linux    # .deb
pnpm --filter gui build:wasapi   # rebuild only wasapi-capture.exe → src-tauri/binaries/
pnpm --filter gui build:server   # esbuild → src-tauri/resources/server-bundle.mjs (+ native modules, ABI fix)
pnpm --filter gui smoke:server   # boot the packaged bundle on an EPHEMERAL port + temp dirs, probe /api/devices + DB routes

pnpm test                      # unit + integration + e2e
pnpm test:unit                 # core (tests/unit) + gui (tests/ui + tests/server/unit) + Rust
pnpm test:integration          # core (tests/integration) + gui (tests/server/integration: real HTTP server, ephemeral port)
pnpm test:e2e                  # CLI e2e + Playwright (needs ports 1420 + 3456 free)
pnpm test:rust                 # cargo test --bin wasapi-capture (pure modules)
pnpm test:hardware             # Playwright @hardware: REAL capture, PLAYS BEEPS on the default output
pnpm screenshots               # Playwright @screens: regenerates docs/images/01–18
pnpm lint / pnpm format        # Biome (tabs, 100 cols)
```

Single test file: `pnpm --filter @listening-resume/core exec vitest run tests/unit/utils/wav.test.ts` (GUI: `pnpm --filter @listening-resume/gui exec vitest run tests/ui/recording.test.tsx`).
Type-check: core and cli with `tsc --noEmit`; GUI with `tsc -p tsconfig.json` (UI) and `tsc -p tsconfig.server.json` (server + server tests). Rust: `cargo clippy -- -D warnings` in `apps/gui/src-tauri`.

## Architecture

### Core (`packages/core/src`)

```
domain/        models (Session has exportDir, lastError), states (canTransition, pt-BR labels), errors (kind → HTTP status), transcript
ports/         audio-capture (AudioCapturePort, LevelMeter, CaptureDevices/ResolvedDevices), transcriber, analyzer, repository, file-storage, exporter
adapters/
  audio/       capture-protocol.ts (pure: parseCaptureLine, buildCaptureArgs/MeterArgs/ToneArgs, mute/switchCommand, LineSplitter)
               wasapi-capture.ts (WasapiCaptureAdapter + findWasapiBinary), ffmpeg-pulse.ts (Linux), fake-capture.ts, factory.ts (createCaptureAdapter)
  transcription/ groq-whisper, whisper-cpp, factory.ts (createTranscriber(provider, cfg); chosen per call from settings)
  analysis/    ollama (primary), groq-llm (fallback)
  fake/        FakeTranscriber, FakeAnalyzer (deterministic pt-BR)
  persistence/ sqlite (Drizzle; idempotent ALTER TABLE migrations; findSessionByIdPrefix; custom templates), local-files
  export/      export-document.ts (pure ExportDocument builder), markdown.ts
application/   RecordingService (owns the ONE active recording + reconcileInterrupted + onWarning; audioSource widens as sources are added live),
               ImportService (owns an imported session: created → chunks registered → stopped; cleanup on failure — callers only convert media),
               TranscriptionService, AnalysisService, error-messages (pt-BR; describeFailure, describeCaptureWarning)
config/        schema.ts (config.toml / env, zod), loader.ts, paths.ts, settings.ts (SettingsStore → settings.json)
templates/     builtin.ts: videoaula-extracao, ata-reuniao, resumo-executivo (default), flashcards-anki (`pergunta;resposta` lines), podcast-artigo
utils/         wav.ts (readWavInfo, buildWavHeader, repairWavHeader…), listeners.ts (typed observer), rate-limiter, logger, format,
               process.ts (`run` — THE child-process helper for core, CLI and server: UTF-8 decoding, output cap (stdout head / stderr tail),
               `timedOut`, optional `ProcessRegistry` whose `killAll()` the server calls on shutdown)
constants.ts   SYSTEM_DEFAULT_DEVICE="@default", DEFAULT_SAMPLE_RATE=16000, DEFAULT_CHANNELS=1, DEFAULT_CHUNK_SECONDS=120, DEFAULT_MIC_VOLUME=1.2
```

### GUI server (`apps/gui/server.ts` is a 15-line entry; the code is in `apps/gui/server/`)

```
bootstrap.ts   env + dev-only workspace .env, PATH for bundled ffmpeg, buildDeps (real or fake), listen 127.0.0.1 (+ ::1 mirror), graceful shutdown
app.ts         createApp(deps: AppDeps) → { server, context }: CORS → guard → router → JSON-content-type check → handler
deps.ts        AppDeps (everything injectable: repo, capture, recording, settings, factories, fetch, run, clock, ids…)
http.ts        HttpError, checkRequestGuard, hasJsonOrEmptyBody, CORS, readBody/readJson, openSse
router.ts      tiny :param router (`rawBody` option for uploads)
routes/        system (health, settings, groq-key, analysis/models) · audio (devices, test tone, levels SSE) · recording · sessions · templates
services/      meters (MeterPool: one LevelMeter per device pair, shared by SSE clients, 5 s stall watchdog) · jobs (background transcribe/analyze)
               wav-stream (virtual concatenated WAV + HTTP Range) · import (runs ffmpeg inside core's ImportService) · export/ (md, pdf-lib, docx) · health · groq-key · sessions (views/cache)
```

### UI (`apps/gui/src`)

`app/` (App, boot, ErrorBoundary) · `features/` (onboarding, dashboard, navigation, recording, sessions, session-detail, templates, settings) · `shared/api` (typed client matching the HTTP API, `sse.ts` EventSource with reconnect) · `shared/hooks` (`useAudioLevels`, which keeps levels in a **ref** with no re-render; `usePolling`, `useHotkey`) · `shared/ui` (`LevelBars`, an rAF loop writing bar heights straight to the DOM; Modal, DeviceSelect…) · `store/` (zustand slices: settings, system, sessions, recording, templates, toasts, ui) · `styles/` (tokens, design, atomics, app). Fonts come from `@fontsource` (no network).

### Rust capture binary (`apps/gui/src-tauri/src/bin/wasapi-capture/`)

`main.rs` (entry) · `protocol.rs` (argv, stdin commands, stdout lines; pure) · `dsp.rs` (decode, channel map, Resampler = FIR anti-alias + linear interp, JitterBuffer, **DriftController** PI loop that nudges the resample ratio, mix, `soft_limit`, `rms_to_level`; pure) · `control.rs` (command/event state machine → Actions; pure) · `sink.rs` (WAV chunk writer) · `source.rs` (one thread per source: `@default` watcher, unplug fallback/restore, **`EventHandle` guard** that closes the event handle the `wasapi` crate leaks) · `engine.rs` (wall-clock mixer: 10 ms tick, LEVEL every 50 ms) · `devices.rs`. Pure modules are unit-tested by `pnpm test:rust`; the rest need COM/Windows.

`src-tauri/src/lib.rs` spawns the node server hidden (`CREATE_NO_WINDOW`) with `LR_SHUTDOWN_ON_STDIN_EOF=1`, assigns it to a **Job Object (KILL_ON_JOB_CLOSE)** so node, wasapi-capture and ffmpeg die with the app, and on exit closes the server's stdin, waits 4 s, then kills it. The webview capability (`capabilities/default.json`) grants only `core:default` + `shell:allow-open` (used by `openExternal`); the open scope is restricted to `http(s)://` / `mailto:` by `plugins.shell.open` in `tauri.conf.json`.

### Session state machine (enforced in core services)

```
created → recording → stopped → transcribing → transcribed → analyzing → completed
created → stopped (import finished: ImportService)
re-transcribe / re-analyze from settled states · any → failed (lastError, pt-BR)
```

## Binary protocol (wasapi-capture ⇄ WasapiCaptureAdapter)

- Modes: `--list-devices` (prints `DEVICES:<json>`), `--play-tone [--device X]`, capture (`--output-dir --prefix --chunk-seconds --sample-rate --channels --device [--mic] --mic-volume`; the adapter ALWAYS sends `--mic-volume` so a mic added live uses it), `--meter-only --device [--mic]` (no files).
- stdout: `CHUNK:<abs path>` · `LEVEL:<sys>,<mic>` (about every 50 ms, post-mute, dBFS −60..0 → 0..1) · `DEVICE:<sys>|<mic>|<changed>` (`both` on the first line, then `sys`/`mic` = the source that reopened/went away; the parser still accepts the legacy 2-field form as `changed: null`) · `WARN:<msg>`. Human logs go to stderr.
- A live switch is acknowledged only by a `DEVICE:` line about the switched source (`acknowledgedSources` in `wasapi-capture.ts`): a line from the other source (e.g. the mic reopening on a new default, still carrying the old system name) must not satisfy it.
- stdin: `q` (finalize the chunk and exit; EOF does the same) · `mute-sys` `unmute-sys` `mute-mic` `unmute-mic` · `set-sys <name|@default>` · `set-mic <name|@default|none>`. A live switch keeps the timeline and the current chunk.
- Device ids travel inside newline-delimited stdin. Core's `assertDeviceId(id, field?)` rejects every control char (U+0000–U+001F, U+007F) and ids > 512 chars with a `ValidationError`; the server routes use the same function (400 naming the field).
- Binary lookup order: `LR_WASAPI_BIN`, then the packaged layout next to the bundled node, then `…/src-tauri/binaries/wasapi-capture.exe` walking up from cwd or the module dir, then PATH. If it is missing, startup fails with a clear error that names `build:wasapi`.

## HTTP API & security guard

Base `http://localhost:3456/api`, JSON, errors `{ error }`. Endpoints: see `docs/RELATORIO.md` §5 (health, settings, config/groq-key, devices, audio/test, **audio/levels SSE**, recording/{start,stop,discard,status,mute,devices}, sessions CRUD + transcribe/analyze/audio(Range)/import/export/export/save, analyses, templates).

The guard (`server/http.ts`) runs on every request. **Any new route inherits it, so do not bypass it:**
1. `Host` must be `localhost`, `127.0.0.1`, `[::1]` or `tauri.localhost` (no port, or the listening port). This blocks DNS rebinding.
2. If an `Origin` header is present, it must be on the exact allow-list: `http://localhost:1420`, `http://127.0.0.1:1420`, `http://tauri.localhost`, `https://tauri.localhost`, `tauri://localhost`, plus `LR_ALLOWED_ORIGINS`. **`Origin: null` is always rejected.**
3. A state-changing request without `Origin` is accepted only when there is no `Sec-Fetch-Site` header (CLI, tests, curl).
4. A GET without `Origin` that has `Sec-Fetch-Site: cross-site|same-site` (`<audio>` and downloads from the Tauri webview) must carry an allowed `Referer` origin.
5. POST/PUT/PATCH/DELETE must send `application/json` or an empty body (415). This forces a CORS preflight. Only routes registered with `{ rawBody: true }` (import upload) are exempt. Keep new mutating routes JSON.

## Configuration & env vars

- **`settings.json` (in the config dir) is the source of truth for user preferences** (devices, provider, models, toggles, theme, exportDir…). `SettingsStore` validates with zod and writes atomically. `config.toml` and `.env` only hold low-level defaults and secrets. The CLI reads `settings.json` too.
- Config dir: `%APPDATA%\listening-resume` / `~/.config/listening-resume` (`.env` with `GROQ_API_KEY`, `config.toml`, `settings.json`). Data dir: `%LOCALAPPDATA%\listening-resume` / `~/.local/share/listening-resume` (sqlite, `sessions/<id>/audio/*.wav`).
- Default devices are `@default` (`SYSTEM_DEFAULT_DEVICE`) for both system and mic. `micDevice: null` means no mic.
- Server env vars: `LR_PORT` (default 3456), `LR_HOST` (single bind address; default binds 127.0.0.1 + ::1), `LR_FAKE_CAPTURE=1` (fake capture, transcriber, analyzer and health; hermetic), `LR_FAKE_DELAY_MS` (fake job latency, default 600), `LR_DATA_DIR`, `LR_CONFIG_DIR`, `LR_ALLOWED_ORIGINS` (comma-separated), `LR_SHUTDOWN_ON_STDIN_EOF=1` (set by Tauri), `LR_IMPORT_TIMEOUT_MS` (ffmpeg import, default 30 min). Core: `LR_WASAPI_BIN` (binary override), `LISTENING_RESUME_CONFIG_DIR` (config dir override used by core and the CLI; the server's `LR_CONFIG_DIR` takes precedence for the server). `OLLAMA_HOST` is honored.
- The workspace-root `.env` is loaded **only in dev** (source checkout). The packaged bundle never reads it.

## Gotchas & Hard-Won Knowledge

**Audio / duration**
- The output WAV format is **config-driven** (`audio.sampleRate`/`channels`, default **16 kHz mono**, 16-bit). The binary resamples and channel-maps every source to it, so a device switch never changes the format. Still, **compute duration from the WAV header** with core `readWavInfo`/`tryReadWavInfo`, never from config. Imports can differ, and `readWavInfo` handles stale/zero header sizes (killed writers).
- The mixer is **wall-clock paced**: it emits exactly the frames real time demands and fills silence when a source delivers nothing. WASAPI loopback is silent and fires no event when nothing plays. This keeps chunk duration equal to real time and makes mic-only recordings work. Per-source jitter buffers plus `DriftController` absorb device clock drift.
- The mic is mixed with gain (`micVolume`, default 1.2) plus `soft_limit` (linear to ±0.8, then a tanh knee). Linux mirrors this with ffmpeg `alimiter`.
- `@default` sources poll the Windows default endpoint every 1 s and reopen on change (emitting `DEVICE:`). A lost named device emits `WARN`, falls back to default, and switches back when it reappears.
- Warnings path: binary `WARN:` → adapter `onWarning` → `RecordingService.onWarning` → SSE `event: warning` `{ message, fallback }` (pt-BR via `describeCaptureWarning`) → toast on the recording screen; while a named device is in fallback the screen shows `system-device-fallback` / `mic-device-fallback` ("Indisponível — gravando de …"). The CLI prints the same message.
- The mixer resyncs (instead of writing the gap as silence) when the wall clock jumps > 5 s between iterations (suspend/resume) and emits `WARN:relógio saltou Xs (suspensão?) — sincronizado` (`clock_skip` in `engine.rs`).
- Linux (`FFmpegPulseAdapter`): `capabilities.levels = false` (the UI shows a neutral "breathing" waveform), and a device switch finishes the chunk and restarts ffmpeg (new chunk index).
- Levels path: binary `LEVEL` → adapter → `RecordingService.onLevels` → SSE `/api/audio/levels` → `useAudioLevels` ref → `LevelBars` rAF. Without a recording, the SSE uses a `MeterPool` meter (`--meter-only`). The stream ends with `event: ended` when a recording starts or stops, and the client reconnects into the right mode.

**Dev / runtime**
- Only one process can bind **port 3456**. The installed app, `pnpm dev`, and the Playwright webServer all want it, and Playwright also needs 1420 (set `E2E_REUSE=1` to reuse running servers). Kill stragglers: `node.exe` whose command line matches `server.ts|server-bundle.mjs` (a bare `*server*` match also kills VS Code's tsserver). `smoke:server` and the server integration tests use ephemeral ports and do NOT need 3456.
- `dev:server` uses `node --watch` on `server.ts`, `server/`, and `packages/core/dist`. A reload **kills an active recording** (in-memory state). Boot runs `RecordingService.reconcileInterrupted()` (recording → stopped/failed, transcribing → stopped/failed, analyzing → transcribed/stopped). A `recording` session whose newest chunk was modified < 10 s ago (or that started < 10 s ago with no chunk yet) is **skipped**: another process (the CLI) is recording it — the binary rewrites the WAV header every 1 s.
- **Do not run `pnpm install` while dev servers or the packaged app are running.** Windows file locks on `better-sqlite3`'s `.node` break the install. pnpm 12 ignores `onlyBuiltDependencies`, so dependency build scripts are allowed via **`allowBuilds`** in `pnpm-workspace.yaml` (better-sqlite3, esbuild). Add new native deps there.
- E2E is **hermetic**: `e2e/support/start-server.mjs` runs the server with `LR_FAKE_CAPTURE=1` and fresh `LR_DATA_DIR`/`LR_CONFIG_DIR` under `%TEMP%\lr-e2e\` (wiped each run; first-run onboarding state). `--real` (the @hardware suite) uses real WASAPI and plays test tones through the speakers. Playwright runs serially (1 worker).
- UI testability: key controls carry `data-testid`: `record-button`, `recording-screen`, `waveform`, `recording-device-select`, `mic-device-select`, `mute-system-button`, `mute-mic-button`, `silence-warning`, `system-device-fallback`, `mic-device-fallback`, `stop-recording-button`, `session-card`, `session-detail`, `status-badge`, `player`, `toast`, `nav-*`, `meter-system`…

**Packaging (the fragile part)**
- `build-server.mjs` copies the native modules (`better-sqlite3`, `bindings`, `file-uri-to-path`, `drizzle-orm`), resolved exactly as node would resolve them from core and then realpath'd into the pnpm store, and aborts if any is missing.
- **Native ABI**: the pnpm store's better-sqlite3 is built for the node that ran `pnpm install` (e.g. Node 24 = ABI 137), but the app bundles **node 22.16.0 (ABI 127)** (`download-deps-win.ps1`). `scripts/native-abi.mjs` (run by build:server and again by smoke:server) loads the copy with the bundled node and fetches the matching prebuild into `resources/node_modules` only (never the store). A mismatch leaves the installed app stuck on "Carregando dispositivos…".
- `smoke:server` is a **build gate** in `build:windows`/`build:linux`.
- The capture binary's module dir is `src/bin/wasapi-capture/` (hyphen = binary name; the Tauri bundler scans `src/bin` by dir name). `Cargo.toml` has `autobins = false` with explicit `[[bin]]` entries `app` (`src/main.rs`) and `wasapi-capture` (`src/bin/wasapi-capture/main.rs`). Add any new binary there.
- CI: `.github/workflows/build-windows.yml`. The `test` job (windows-latest, pnpm 12, Node 24) runs install → build → lint → unit → integration → e2e. The `build-windows` job runs on `v*` tags or manual dispatch and executes `build:windows`. Project skills in `.claude/skills/` (`audio-diag`, `pipeline-test`, `win-build`) target the current API.
- The installed webview origin is `http://tauri.localhost` (Windows) / `tauri://localhost`. These are already on the allow-list. Any new origin check must accept them, or the installed app gets 403s.

**Generated artifacts (gitignored, do not commit, do not hand-edit)**
- `resources/server-bundle.mjs`, `resources/bin/`, `resources/node_modules/`, `src-tauri/binaries/`, `src-tauri/target/`, installers (`*.exe`/`*.msi`).
