# Code Review — Follow-ups

Itens levantados na review (staff-eng) que **não foram aplicados** ainda. Para análise/priorização futura.
Os P0 e a maioria dos P1 já foram corrigidos e estão no build atual.

---

## P1-5 — Encapsular estado global de playback (deferido de propósito)

**Onde:** `apps/gui/server.ts` — `(globalThis as any).__playbackProcess`, `__playbackStartTime`, `__playbackSeekOffset`.

**Problema:** estado de playback vive em variáveis globais untyped via `globalThis`. Funciona para o caso single-user/local, mas:
- Sem tipo → erros de digitação não pegam em compile-time.
- Espalhado por 3 handlers (`POST /play`, `DELETE /play`, `GET /playback/status`) → fácil esquecer de resetar um campo.
- `as any` repetido em cada acesso.

**Por que não apliquei agora:** é refactor que toca os 3 handlers de playback que eu acabei de consertar (kill-before-spawn, seek-trim, cleanup de temp). Mexer logo antes do build final do instalador = risco de regredir playback sem ganho funcional. Baixo valor imediato, melhor fazer com calma + teste.

**Proposta:** módulo `apps/gui/src/playback-state.ts` (ou top de `server.ts`):
```ts
interface PlaybackState {
  process: import("node:child_process").ChildProcess | null;
  startTime: number;
  seekOffset: number;
}
const playback: PlaybackState = { process: null, startTime: 0, seekOffset: 0 };

function stopPlayback() {
  if (playback.process) { try { playback.process.kill(); } catch {} playback.process = null; }
}
```
Trocar os 3 handlers para usar `playback.*` + `stopPlayback()`. Sem `globalThis`, sem `as any`.

---

## P1-4 — Pacing wall-clock vs stream realtime (tradeoff a revisitar)

**Onde:** `apps/gui/src-tauri/src/bin/wasapi_capture.rs` — loop de captura.

**Estado:** resolvi o problema de silêncio/mic-only fazendo o output ser paceado por wall-clock (escreve os frames que o tempo real exige; preenche silêncio quando loopback não entrega).

**Risco residual:**
- Sob jitter de scheduler (GC do SO, pico de CPU), o preenchimento de silêncio pode intercalar micro-gaps no áudio contínuo.
- O cap de backlog de ~1s **descarta áudio do sistema** num stall longo.

**Proposta a avaliar:** drenar a `sample_queue` por completo antes de preencher silêncio (só preenche se a fila está vazia E estamos atrasados vs target). Reduz chance de glitch trocando audio-real-atrasado por silêncio. Precisa de teste auditivo com gravação longa + carga.

---

## P2 — Itens menores

- **`getAudioDuration` fallback inconsistente** (`server.ts`): no `catch` usa `32000` hardcoded (16k mono) enquanto o caminho normal lê o header real. Caminho quase inalcançável, mas inconsistente. Unificar.
- **`download-deps-win.ps1`**: re-baixa o zip de ~100MB sempre que ffplay falta (sem cache do zip baixado). Cachear o zip em `%TEMP%` e reusar.
- **Resample do mic** (`wasapi_capture.rs`): nearest-neighbor, sem filtro anti-alias. OK para voz, ruim para música no mic. Considerar interpolação linear no mínimo.

---

## Sugestões de projeto (Win + Linux)

1. **CI matrix (GitHub Actions)** — `windows-latest` + `ubuntu-latest` rodando `lint` + `test` + build. Teria pego os bugs do better-sqlite3 e do ffplay antes do usuário. **Maior ROI.**
2. **Smoke-test no CI** — já existe `pnpm smoke:server` (boota o bundle + `GET /api/devices`). Adicionar no pipeline como gate de regressão.
3. **Versão do node em um lugar só** — hoje `22.16.0` está hardcoded em `download-deps-win.ps1` e implicitamente acoplado ao ABI do prebuild do better-sqlite3 copiado pelo `build-server.mjs`. Se divergir, o app instalado crasha no boot (silencioso). Centralizar numa constante/var + o smoke-test cobre a regressão.
4. **Dependências do `.deb` (Linux)** — confirmar que o pacote declara `ffmpeg` (e pipewire/pulse) como dependência. No Windows o ffmpeg é bundled; no Linux depende do sistema.
5. **Paridade de mix documentada** — a lógica de mix divergiu: Windows usa `soft_limit` em Rust, Linux usa `alimiter` do ffmpeg. Documentar o alvo comum (~-1 a -3 dBFS de headroom) pra não divergirem de novo.

---

## Já aplicado nesta sessão (referência)

- ✅ Duração WAV correta (lê header real) — `server.ts` `getAudioDuration`
- ✅ Captura paceada por wall-clock (mic grava em silêncio, sem crackle) — `wasapi_capture.rs`
- ✅ Mix mic+sistema **com soft-limiter** (sem estourar) — `wasapi_capture.rs`
- ✅ Listagem de mics + campo `type` no Windows — `wasapi_capture.rs`
- ✅ Test sound roteia pro device selecionado (`--play-tone`) — `wasapi_capture.rs` + `ffmpeg-wasapi.ts`
- ✅ Seek via ffmpeg trim + ffplay bundled — `server.ts` + `download-deps-win.ps1`
- ✅ PATH dev resolve ffmpeg bundled — `server.ts`
- ✅ Reconcile de sessões presas no boot + rollback transcribe/analyze — `server.ts`
- ✅ Dropdowns com retry não-bloqueante + filtro de mic na lista de gravação — `store/index.ts` + `SettingsPage.tsx`
- ✅ `build-server.mjs` resolve módulos nativos dinamicamente + aborta se faltar
- ✅ Smoke-test do bundle como gate de build — `smoke-test-server.mjs`
- ✅ Console do backend escondido no Windows (CREATE_NO_WINDOW) — `lib.rs`
- ✅ `.gitignore` completo + `server-bundle.mjs` destrackeado
