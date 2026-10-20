---
name: win-build
description: Build the Windows/Linux installer end-to-end for Listening Resume — stops running servers, runs the full build chain, confirms the smoke-test passed, and reports the installer paths + sizes. Use when asked to "build the exe/installer", "package the app", "gerar instalador", or after changes that need a fresh installer.
---

# Build the installer (win-build)

This repo's installer build is fragile (native modules, bundled node/ffmpeg, a self-validating smoke-test) and the dev server / installed app fight over **port 3456**. Follow this exactly.

## Steps

1. **Stop running app/dev servers** (the smoke-test boots the bundle on an ephemeral port, but a running installed app/dev server can lock files under `src-tauri/resources` and `binaries/`). Match the server entry precisely — a bare `*server*` filter also kills VS Code's `tsserver`:
   ```bash
   powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -match 'server\.ts|server-bundle\.mjs|vite' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -EA SilentlyContinue }"
   ```

2. **Run the build** (in background — it takes ~5-10 min: core → vite → server bundle → download-deps → wasapi → smoke-test → tauri bundle):
   - Windows: `pnpm --filter @listening-resume/gui build:windows`
   - Linux:   `pnpm --filter @listening-resume/gui build:linux`

3. **Confirm the smoke-test passed** in the log — must contain `✓ server booted and listed N device(s)`. If it says `server crashed on startup`, the bundle is broken (usually a native module missing in `build-server.mjs`); fix that before shipping.

4. **Report the artifacts**:
   ```bash
   ls -la exe/
   ```
   The build's last step (`collect:installers`) copies them to `<repo>/exe/` as `LR-<YYYY-MM-DD>-<version>-setup.exe` / `.msi` (originals stay in `apps/gui/src-tauri/target/release/bundle/`). The NSIS `*-setup.exe` is the recommended installer.

## Notes
- For a code-only change to the app shell (`lib.rs`) you can re-bundle faster with `pnpm --filter gui tauri build` (skips deps/wasapi), but only after `build:server` is current.
- After editing the binary (`src-tauri/src/bin/wasapi-capture/`), run `pnpm test:rust` then `pnpm --filter @listening-resume/gui build:wasapi`; the dev server picks up the new binary on the next recording.
- `smoke:server` (and `build:server`) run `scripts/native-abi.mjs`, which fetches the better-sqlite3 prebuild matching the BUNDLED node (needs network to GitHub releases).
- Never hand-edit `resources/server-bundle.mjs` / `resources/node_modules/` / `binaries/` — they're generated.
