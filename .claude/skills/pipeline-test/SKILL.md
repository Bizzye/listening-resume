---
name: pipeline-test
description: End-to-end smoke test of the Listening Resume audio pipeline (record → transcribe → analyze → export) driving the running API on port 3456 and inspecting the resulting WAV. Use to verify recording/transcription/analysis/mute/mic-mixing changes actually work, or after touching wasapi_capture.rs, server.ts, or the core services.
---

# Pipeline smoke test (pipeline-test)

Exercises the real flow through the API server and verifies the artifacts on disk. Runs without credentials too (then transcribe/analyze are checked for *graceful failure*, not success).

## 0. Preconditions

Server must be up on **3456** (only one process can bind it — see CLAUDE.md gotchas). If down, free the port and start a single clean server:

```bash
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -like '*server*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -EA SilentlyContinue }"
cd apps/gui && nohup ./node_modules/.bin/tsx server.ts >/tmp/pt.log 2>&1 &
# wait until ready:
for i in $(seq 1 24); do curl -s -m2 http://localhost:3456/api/recording/status >/dev/null 2>&1 && break; sleep 0.5; done
```

> Avoid `pnpm dev:server` (it uses `--watch`; a reload mid-test orphans the recording and clears `activeSessionId`). Plain `tsx server.ts` is stable for the test. Kill it when done.

For a meaningful transcript, **play audio on the system** during the recording window. With silence, expect an empty/"no speech" transcript — still a valid structural pass.

## 1. Pick devices

```bash
B=http://localhost:3456/api
curl -s "$B/devices"   # choose a type:"monitor" id for `device`, and optionally a type:"microphone" id for `micDevice`
curl -s "$B/config"    # hasGroqKey? (needed for transcribe + analyze success)
```

## 2. Record → stop

```bash
SID=$(curl -s -X POST "$B/recording/start" -H "Content-Type: application/json" \
  -d '{"device":"<monitor-id>","micDevice":"<mic-id-or-omit>"}' | sed -E 's/.*"id":"([^"]+)".*/\1/')
sleep 6
# (optional) test mute mid-recording: curl -s -X POST "$B/recording/mute" -d '{"target":"mic","muted":true}' -H "Content-Type: application/json"
curl -s -X POST "$B/recording/stop" >/dev/null
sleep 1
curl -s "$B/sessions/$SID"   # expect status "stopped", chunks>=1, duration ≈ wall-clock seconds
```

**Verify the WAV** with the `audio-diag` skill: duration must match real time (header-based), no clipping, and — if you tested mute — the muted segment's `max` ≈ 0.

## 3. Transcribe

```bash
curl -s -X POST "$B/sessions/$SID/transcribe"
```
- With Groq key: HTTP 200, `transcript.segments` present (or empty if silence).
- Without key: **graceful** 500 `{"error":"GROQ_API_KEY not set..."}` — no crash. Confirm the session status rolled back (not stuck in "transcribing").

## 4. Analyze

```bash
curl -s -X POST "$B/sessions/$SID/analyze" -H "Content-Type: application/json" -d '{"templateId":"meeting-summary"}'
```
- No transcript → expect **400** "No transcript found", and session NOT left in "analyzing".
- With transcript → 200, structured `analysis.content`, session → "completed" (provider may be `groq` if Ollama model isn't pulled — that's the fallback working).

## 5. Export (optional)

```bash
curl -s "$B/sessions/$SID/export" -o /dev/null -w "%{http_code} %{content_type}\n"          # text/markdown
curl -s -X POST "$B/sessions/$SID/export/save" -H "Content-Type: application/json" -d '{"format":"markdown"}'
```

## 6. Report + cleanup

Summarize each stage as PASS / GRACEFUL-FAIL / FAIL with the observed status codes and the WAV measurements. Delete the throwaway session if desired (`DELETE $B/sessions/$SID`) and kill the test server.
