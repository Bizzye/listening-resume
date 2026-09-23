# 18 — Transcrição ao vivo (streaming durante a gravação)
> Status: proposta · Esforço: 🔴 · Impacto: Alto na percepção (app "vivo"; feedback imediato de que o áudio está sendo capturado) · Depende de: nada obrigatório; cruza com spec 20 (idioma por sessão) e atrito com spec 17 (diarização ao vivo é inviável)

## Problema
Transcrição roda **só depois** que a gravação termina. Durante a gravação a tela mostra apenas tempo, nº de chunks e um waveform decorativo — nenhum texto. O usuário não vê o que está sendo transcrito enquanto fala, e só descobre problemas (mic mudo, idioma errado) ao final. Falta transcrição incremental ao vivo.

## Como está hoje
- Transcrição é totalmente pós-gravação: `POST /api/sessions/:id/transcribe` (`apps/gui/server.ts:528-578`) chama `transcribeSession`, que **itera todos os chunks já salvos** num loop (`packages/core/src/application/transcription.service.ts:30-54`). É um lote, não um stream.
- Chunks são emitidos durante a gravação via callback: `RecordingService` registra `this.capture.onChunkReady((info) => { ... addChunk ... })` (`packages/core/src/application/recording.service.ts:49-89`). O contrato do port é `onChunkReady(callback: (info: ChunkInfo) => void)` (`packages/core/src/ports/audio-capture.ts:29`). Ou seja, **já existe o evento "chunk fechado" em tempo real** — hoje ele só persiste o chunk, não dispara transcrição.
- Default de chunk é 120s (`config/schema.ts:11`, `chunkSeconds`), passado em `server.ts:430`. Para "ao vivo" perceptível isso é longo demais — texto só apareceria a cada 2 min.
- O server não tem nenhum canal de push (SSE/WebSocket); tudo é request/response JSON via `http.createServer` (`apps/gui/server.ts:250`) com helper `json()` (`server.ts:173-181`). Estado de gravação é só `activeSessionId`/`recordingStartTime` (`server.ts:107-108`).
- UI de gravação (`apps/gui/src/features/recording/RecordingPage.tsx`) faz **polling** a cada 2s para nº de chunks (`RecordingPage.tsx:29-40`, `api.getRecordingStatus`) e níveis de mute (`RecordingPage.tsx:43-57`). Não há área de texto.
- Rate limit existe e é central: `SlidingWindowLimiter` (18 RPM, 7000s/h — `config/schema.ts:42-45`), usado em `transcription.service.ts:16` e `:37`.

## O que precisa ser feito
1. Ao fechar **cada chunk durante a gravação**, transcrever incrementalmente (em background, sem bloquear a captura).
2. Empurrar os segmentos novos para a UI em tempo real (SSE ou WebSocket).
3. Montar o texto ao vivo no `RecordingPage`.
4. Ao parar, **não retranscrever do zero** — reaproveitar o que já foi feito ao vivo (a infra de "pular chunk já transcrito" já existe).

## Como implementar

### 1. Disparar transcrição por chunk (server)
O ponto-chave: `onChunkReady` (`recording.service.ts:49`) já roda por chunk em tempo real, mas está no **core** e não tem acesso ao transcriber (RecordingService só conhece capture/repo/storage, `recording.service.ts:11-15`). Duas abordagens:

- **(Preferida) No server**, após `startRecording` (`server.ts:427-433`), registrar um segundo handler no capture: `capture.onChunkReady(async (info) => { ... transcrever info.path ... })`. Mas `onChunkReady` hoje **sobrescreve** (não acumula) em `FFmpegWasapiAdapter`/`FFmpegPulseAdapter` — verificar a implementação; se for setter único, mudar o adapter para suportar múltiplos listeners (é `EventEmitter`-friendly: o capture já é `EventEmitter`, `server.ts:75` faz `capture.on("error", ...)`). Recomendado: emitir um evento `"chunk"` no `EventEmitter` e ter o RecordingService e o server escutando independentemente.
- Alternativa: passar um `TranscriberPort` opcional ao `RecordingService` para ele transcrever inline — acopla gravação a transcrição, menos limpo.

Cada transcrição de chunk usa o mesmo `GroqWhisperAdapter` já construído no transcribe (`server.ts:546-549`) e **respeita o rate limiter** (`transcription.service.ts:37`). Persistir os segmentos incrementalmente: marcar o chunk como `"transcribed"` (`updateChunk`, `sqlite.ts:193-198`) e ir acumulando segmentos. Isso encaixa perfeitamente no loop existente que **pula chunks já transcritos** (`transcription.service.ts:31-34`): ao parar, um `transcribeSession` final só processa o que faltou e salva o `Transcript` consolidado.

**Reduzir `chunkSeconds`** durante gravação para ~15-30s (config nova `audio.liveChunkSeconds`) para latência aceitável — trade-off direto com nº de requests (rate limit) e custo.

### 2. Canal de push — SSE (recomendado sobre WebSocket)
SSE é mais simples e basta para servidor→cliente unidirecional. Novo endpoint no `http.createServer` (`server.ts:250`):

```ts
// GET /api/recording/stream  (SSE)
if (route === "/api/recording/stream" && req.method === "GET") {
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
		"Access-Control-Allow-Origin": "*",
	});
	liveClients.add(res);
	req.on("close", () => liveClients.delete(res));
	return; // não fechar res
}
```

Manter um `Set<http.ServerResponse>` em escopo de módulo (`liveClients`). Quando um chunk for transcrito, fazer broadcast: `for (const c of liveClients) c.write(\`data: ${JSON.stringify({ sessionId, segments })}\n\n\`)`. WebSocket exigiria uma lib nova (`ws`) e mais cuidado no bundle (`build-server.mjs`, ver `CLAUDE.md` Packaging) — SSE usa só o `http` nativo, zero dependência.

### 3. UI (RecordingPage)
- Abrir `new EventSource(\`${BASE}/recording/stream\`)` ao montar enquanto `isRecording` (`RecordingPage.tsx:21-27`), fechar no cleanup. Acumular segmentos num `useState`.
- Renderizar uma área de texto rolável com o transcript ao vivo (auto-scroll para o fim), abaixo/no lugar do waveform (`RecordingPage.tsx:91-93`).
- Adicionar `api` helper se preferir, mas `EventSource` é melhor usar direto. `BASE` vem de `apps/gui/src/shared/lib/api.ts:1-4`.

### 4. Tauri / dev
- Em produção a UI fala com `http://localhost:3456` (`api.ts:1-4`); SSE atravessa isso normalmente. Confirmar que o proxy do Vite (porta 1420 → 3456) repassa `text/event-stream` sem buffer (Vite costuma ok).
- `node --watch` (dev:server) reinicia e mata SSE (gotcha conhecido — `CLAUDE.md` "node --watch reloads and clears in-memory state"). Cliente deve reconectar (EventSource já reconecta sozinho).

## Plano de testes
- **Unit/integração (core)**: o "skip de chunk já transcrito" (`transcription.service.ts:31-34`) garante que após transcrição ao vivo o `transcribeSession` final não dobra segmentos nem reprocessa — testar com chunks pré-marcados `"transcribed"`.
- **Integração (server)**: abrir SSE, simular `onChunkReady`, verificar que o cliente recebe `data:` com segmentos; rate limiter não é violado com chunks curtos.
- **Manual/E2E**: `pnpm dev`, iniciar gravação tocando áudio com fala, ver texto aparecer ao vivo em `RecordingPage`; parar e confirmar que a transcrição final bate com o ao vivo (sem duplicação). Skills `pipeline-test` (fluxo) e `audio-diag` (validar chunks). Playwright MCP em `:1420` — adicionar `data-testid="live-transcript"`.

## Riscos / decisões em aberto
- **Rate limit / custo**: chunks curtos = mais requests; 18 RPM (`config/schema.ts:43`) limita a granularidade mínima (chunk de 15s ≈ 4 req/min por sessão, ok; mas várias sessões/uso intenso aproxima do teto). Decidir o `liveChunkSeconds` default.
- **Latência inerente**: Whisper precisa do chunk fechado; "ao vivo" será sempre atrasado por ~chunkSeconds. Streaming sub-segundo exigiria outro motor (ex.: whisper.cpp streaming local) — fora de escopo.
- **Custo de tokens/áudio dobrado?**: garantir que o transcribe final reusa os chunks (já resolvido pelo skip) para não pagar duas vezes.
- **whisper.cpp local**: para ao vivo realmente barato/privado, usar `WhisperCppAdapter` (`adapters/transcription/whisper-cpp.ts`) ao vivo e Groq no final — decisão de produto.
- **Diarização ao vivo (spec 17)**: inviável em tempo real; declarar explicitamente que diarização é só pós-gravação.
- **Reconexão/estado**: se o server reiniciar (dev `--watch`) ou a aba fechar, a UI ao vivo perde o buffer; o transcript persistido nos chunks é a fonte da verdade ao reabrir.
