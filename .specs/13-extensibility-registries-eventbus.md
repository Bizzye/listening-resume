# 13 — Extensibilidade: registries de providers, ExporterRegistry, ImportPort e event bus

> Status: proposta · Esforço: 🟡 (faseável em 4 sub-itens 🟢/🟡) · Impacto: destrava plugar novos providers (Claude/OpenAI/AssemblyAI), exporters, fontes de áudio e hooks de pipeline (auto-título, webhooks, telemetria) **sem editar vários arquivos** · Depende de: spec 10 (handlers) idealmente aplicada — concentra a instanciação num só lugar; cruza com spec 02 (fontes de áudio) e spec 06 (exporters)

## Problema

Adicionar um provider novo hoje exige tocar em **vários arquivos desconexos**, e o pipeline não tem pontos de extensão. Quatro carências:

**(a) Sem registry/factory de providers.** Os providers válidos são enums hardcoded no Zod (`config/schema.ts`), e a instanciação do adapter certo está espalhada e condicional dentro do server (`if provider === "groq" ...`). Plugar Claude/OpenAI/AssemblyAI = editar o enum + adicionar `new XAdapter(...)` em cada lugar que instancia + ajustar a lógica de fallback à mão.

**(b) Sem ExporterRegistry.** Só existe `MarkdownExporter`; o formato é escolhido por um `if (format === "text") ... else ...` inline. (Cruza com **spec 06**, que detalha novos exporters — esta spec só provê o registro que a 06 consome.)

**(c) Sem ImportPort / fonte de áudio genérica.** A única fonte é `AudioCapturePort` (gravar). Não há abstração para "importar arquivo existente" ou "capturar aba". (Cruza com **spec 02**, que define as fontes — esta spec provê a porta.)

**(d) Sem event bus / hooks.** Os services escrevem direto no repo e atualizam status; não há onde pendurar "ao transcrever → gerar título", "ao analisar → disparar webhook", "→ telemetria". Hoje qualquer um desses exige enfiar código no meio do service ou do handler.

## Como está hoje

### (a) Providers hardcoded e instanciação espalhada

Enums no Zod — `config/schema.ts`:
- transcrição: `z.enum(["groq", "whisper-cpp", "openai"])` (`schema.ts:17`) + fallback (`schema.ts:23`).
- análise: `z.enum(["ollama", "groq", "openai", "anthropic"])` (`schema.ts:30`) + fallback (`schema.ts:36`).

Note que o enum **já lista `openai`/`anthropic`** que **não têm adapter** — promessa não cumprida.

Instanciação dos adapters de transcrição — só `GroqWhisperAdapter` é usado no GUI (`server.ts:546-549`); `WhisperCppAdapter` existe (`adapters/transcription/whisper-cpp.ts`) mas o server nunca o instancia, ignorando o enum.

Instanciação de análise com fallback montado à mão — `server.ts:607-620`:

```ts
const ollama = new OllamaAdapter(config.analysis.model);
const groq = groqApiKey ? new GroqLLMAdapter(groqApiKey, config.analysis.fallback?.model ?? "...") : null;
const groqPrimary = config.analysis.provider === "groq" && groq !== null;
const analyzer = groqPrimary ? groq : ollama;
const fallback = groqPrimary ? ollama : groq;
const analysisService = new AnalysisService(analyzer, fallback, repo);
```

Adapters têm construtores heterogêneos: `GroqWhisperAdapter(apiKey, model)` (`groq-whisper.ts:14`), `WhisperCppAdapter(binaryPath, modelPath, model)` (`whisper-cpp.ts:14`), `OllamaAdapter(model, host)` (`ollama.ts:10`), `GroqLLMAdapter(apiKey, model)` (`groq-llm.ts:10`). Não há fábrica que normalize isso.

### (b) Exporter único

`MarkdownExporter implements ExporterPort` (`adapters/export/markdown.ts:3`), `readonly format = "markdown"` (`markdown.ts:4`). Port em `ports/exporter.ts:9-13`. Escolha de formato inline no server: `server.ts:1145-1155` (`if (format === "text") ... else { MarkdownExporter }`).

### (c) Só captura como fonte

`AudioCapturePort` (`ports/audio-capture.ts:25-30`) modela apenas gravação ao vivo (`startCapture`/`stopCapture`/`onChunkReady`). `RecordingService` (`application/recording.service.ts`) é o único produtor de chunks. Não há porta para "importar um arquivo .wav/.mp3 já pronto" virar uma sessão com chunks.

### (d) Services escrevem direto no repo, sem hooks

`AnalysisService.analyzeSession` (`analysis.service.ts:15-65`) chama `repo.saveAnalysis` (`:61`) e `repo.updateSession(..., completed)` (`:62`) e retorna — nenhum ponto de extensão. Idem `TranscriptionService.transcribeSession` (`transcription.service.ts:69` salva e retorna). O título da sessão nunca é gerado automaticamente (`session.title` nasce `null` em `recording.service.ts:32` e só muda se o usuário editar).

## O que precisa ser feito

Criar quatro abstrações no core, todas plugáveis por configuração/registro, e refatorar os pontos de uso para consumi-las. Manter cada uma independente (faseável).

## Como implementar

### (a) Registries de transcrição e análise — `packages/core/src/registry/`

Definir descritores e um registro central, substituindo o enum hardcoded e a instanciação espalhada por **um ponto de extensão**.

```
packages/core/src/registry/
├── analyzer-registry.ts
├── transcriber-registry.ts
└── index.ts
```

```ts
// transcriber-registry.ts
import type { TranscriberPort } from "../ports/transcriber.js";

export interface TranscriberContext {
  groqApiKey?: string;
  model?: string;
  // espaço para apiKeys de openai/assemblyai etc.
  extra?: Record<string, string>;
}
export interface TranscriberProvider {
  id: string;                 // "groq" | "whisper-cpp" | "openai" | "assemblyai" ...
  label: string;
  requiresKey?: boolean;
  create(ctx: TranscriberContext): TranscriberPort;
}

const registry = new Map<string, TranscriberProvider>();
export function registerTranscriber(p: TranscriberProvider) { registry.set(p.id, p); }
export function getTranscriberProvider(id: string) { return registry.get(id); }
export function listTranscriberProviders() { return [...registry.values()]; }
export function createTranscriber(id: string, ctx: TranscriberContext): TranscriberPort {
  const p = registry.get(id);
  if (!p) throw new Error(`Unknown transcriber provider: ${id}`);
  return p.create(ctx);
}
```

Registrar os existentes (num módulo de bootstrap, ex: `registry/builtins.ts`, importado pelo barrel):

```ts
registerTranscriber({ id: "groq", label: "Groq Whisper", requiresKey: true,
  create: (ctx) => new GroqWhisperAdapter(ctx.groqApiKey!, ctx.model) });
registerTranscriber({ id: "whisper-cpp", label: "whisper.cpp (local)",
  create: (ctx) => new WhisperCppAdapter(ctx.extra?.binaryPath, ctx.extra?.modelPath!, ctx.model) });
```

Análise idêntica (`analyzer-registry.ts`), registrando `ollama` e `groq`. Um futuro `claude`/`openai` é **um `registerAnalyzer(...)` novo + o adapter** — sem tocar server, schema ou services.

**Config schema** (`config/schema.ts:17,30`): trocar `z.enum([...])` por `z.string()` validado contra `listTranscriberProviders()`/`listAnalyzerProviders()` em runtime (refine), ou manter enum mas gerá-lo a partir do registry. Recomendação: `z.string().refine(id => getTranscriberProvider(id) !== undefined, ...)` para o enum deixar de ser a fonte da verdade.

**Server** (`server.ts:546-549` e `607-620`): substituir pela fábrica. A lógica primary/fallback vira genérica:

```ts
const transcriber = createTranscriber(config.transcription.provider, { groqApiKey: state.groqApiKey, model: config.transcription.model });

const primary = createAnalyzer(config.analysis.provider, { groqApiKey: state.groqApiKey, model: config.analysis.model });
const fallbackId = config.analysis.fallback?.provider;
const fallback = fallbackId ? createAnalyzer(fallbackId, { groqApiKey: state.groqApiKey, model: config.analysis.fallback!.model }) : null;
const analysisService = new AnalysisService(primary, fallback, repo, eventBus);
```

(Se a spec 10 estiver aplicada, isso fica nos handlers `transcribe.ts`/`analyze.ts` — um ponto cada.)

**Endpoint novo (opcional, alimenta a UI de Settings):** `GET /api/providers` retornando `listAnalyzerProviders()`/`listTranscriberProviders()` com `{ id, label, requiresKey }`, para a UI listar dinamicamente.

### (b) ExporterRegistry — `packages/core/src/registry/exporter-registry.ts`

Espelha o de análise; `ExporterPort` já existe (`ports/exporter.ts`). Registrar `MarkdownExporter` e (spec 06) um `TextExporter`/`PdfExporter`/`JsonExporter`.

```ts
export interface ExporterProvider { format: string; label: string; create(): ExporterPort; }
const exporters = new Map<string, ExporterProvider>();
export function registerExporter(p: ExporterProvider) { exporters.set(p.format, p); }
export function createExporter(format: string): ExporterPort { /* lookup + throw */ }
export function listExporters(): ExporterProvider[] { return [...exporters.values()]; }
```

Server (`server.ts:1145-1155`, e também `1107`/`1152`): `const exporter = createExporter(format)` em vez do `if/else`. O `format === "text"` que hoje monta o texto inline (`server.ts:1146-1148`) vira um `TextExporter` registrado (detalhe na **spec 06**).

### (c) ImportPort / fonte de áudio genérica — `packages/core/src/ports/audio-source.ts`

Generalizar a origem dos chunks. Manter `AudioCapturePort` (gravação ao vivo) e adicionar uma porta de **importação** para a spec 02 (arquivo existente, aba do navegador, etc.):

```ts
export interface ImportPort {
  id: string;                                  // "file" | "tab" ...
  canHandle(input: ImportInput): boolean;
  /** Produz chunks WAV no outputDir e retorna seus ChunkInfo, sem gravar ao vivo. */
  import(input: ImportInput, outputDir: string): Promise<ChunkInfo[]>;
}
export interface ImportInput { kind: "file"; path: string } // ampliado pela spec 02
```

Um `ImportRegistry` análogo aos de cima. Um `ImportService` (irmão de `RecordingService`) cria a sessão, chama o import escolhido, grava os `AudioChunk` via repo e dispara o evento `onChunksReady` (ver (d)). Detalhes das fontes concretas (file/tab) ficam na **spec 02**; esta spec só estabelece a porta + registry + service esqueleto, reaproveitando `ChunkInfo` (`ports/audio-capture.ts:20-23`) e `readWavInfo` (spec 11) para duração.

### (d) Event bus / hooks no pipeline — `packages/core/src/application/events.ts`

Um emitter tipado injetado nos services. Mínimo viável:

```ts
export interface PipelineEvents {
  recordingStopped: { sessionId: string; chunks: number };
  transcribed: { sessionId: string; transcript: Transcript };
  analyzed: { sessionId: string; analysis: Analysis };
}
export class PipelineEventBus {
  private handlers: { [K in keyof PipelineEvents]?: Array<(p: PipelineEvents[K]) => void | Promise<void>> } = {};
  on<K extends keyof PipelineEvents>(e: K, h: (p: PipelineEvents[K]) => void | Promise<void>) { (this.handlers[e] ??= []).push(h); }
  async emit<K extends keyof PipelineEvents>(e: K, p: PipelineEvents[K]) {
    for (const h of this.handlers[e] ?? []) { try { await h(p); } catch (err) { logger.warn(`hook ${String(e)} failed: ${err}`); } }
  }
}
```

Injetar como dependência **opcional** nos services (não quebra chamadas existentes):

- `TranscriptionService` (`transcription.service.ts:11-17` no construtor; emitir após `saveTranscript` em `:69`): `await this.events?.emit("transcribed", { sessionId, transcript })`.
- `AnalysisService` (`analysis.service.ts:9-13` no construtor; emitir após `saveAnalysis` em `:61`): `await this.events?.emit("analyzed", { sessionId, analysis })`.

Hooks plugáveis (registrados no `container.ts`/server bootstrap), cada um isolado:
- **auto-título**: on `transcribed`, se `session.title == null`, gerar via analyzer curto e `repo.updateSession(id, { title })`. Resolve o `title: null` de `recording.service.ts:32`.
- **webhook**: on `analyzed`, POST para uma URL configurável.
- **telemetria**: on `*`, contar eventos.

Erros em hooks **não** derrubam o pipeline (try/catch no `emit`).

### Ordem de migração segura

1. (a) Registries — criar, registrar os 2+2 existentes, **manter** a instanciação antiga funcionando; depois trocar os call-sites do server por `createTranscriber`/`createAnalyzer`. Smoke + `pipeline-test`.
2. (d) Event bus — adicionar param opcional aos services (default `undefined` = comportamento atual). Sem hooks ainda. Testes dos services continuam passando.
3. (d) primeiro hook (auto-título) atrás do event bus. Validar com `pipeline-test`.
4. (b) ExporterRegistry — registrar `MarkdownExporter`, trocar o `if/else` do server. (Resto na spec 06.)
5. (c) ImportPort/registry/service esqueleto. (Fontes concretas na spec 02.)

## Plano de testes

- **(a)** `createTranscriber("groq", { groqApiKey })` retorna `GroqWhisperAdapter` com `provider==="groq"`; `createAnalyzer("ollama", {...})` idem; id desconhecido lança; `listAnalyzerProviders()` inclui os registrados. Config schema rejeita provider sem adapter registrado.
- **(b)** `createExporter("markdown")` retorna `MarkdownExporter`; formato desconhecido lança; `listExporters()` lista os registrados.
- **(c)** `ImportService` com um import fake (gera 1 chunk) cria sessão, grava `AudioChunk` no `InMemoryRepository` (spec 12), emite `recordingStopped`/chunksReady.
- **(d)** `PipelineEventBus`: `on`+`emit` chama handlers em ordem; um handler que lança **não** impede os outros nem propaga; `AnalysisService` com event bus injetado emite `analyzed` após salvar (espionar com fake repo). Hook auto-título seta `session.title` quando era `null` e não sobrescreve quando já existe.
- **Regressão**: `pipeline-test` (record → transcribe → analyze → export) verde após cada fase.

## Riscos / decisões em aberto

- **Acoplamento config ↔ registry**: trocar `z.enum` por validação contra o registry exige que os builtins estejam registrados **antes** de `loadConfig()`. Garantir que `registry/builtins.ts` seja importado no topo do barrel/`loadConfig`. Risco de ordem de import; mitigar com import explícito no `container.ts`.
- **Construtores heterogêneos** (`whisper-cpp` precisa de `binaryPath`/`modelPath` que hoje nem vêm do config): o `TranscriberContext.extra` cobre, mas o schema de config precisa ganhar esses campos para whisper-cpp ser realmente usável (hoje o enum lista mas o server nunca instancia — dívida pré-existente).
- **Chaves de API por provider**: hoje só existe `groqApiKey` (state do server). Claude/OpenAI/AssemblyAI exigem suas próprias chaves → generalizar o armazenamento de chaves (o `.env` em `configDir`, `server.ts:112-145`) para um mapa por provider. Fora do escopo de implementação aqui, mas o `TranscriberContext`/`AnalyzerContext` já prevê via `extra`.
- **Cruzamentos**: (b) é o pré-requisito de infra da **spec 06** (não duplicar — esta spec só cria o registry, 06 cria os exporters). (c) é o pré-requisito de infra da **spec 02** (esta cria a porta, 02 cria as fontes). Alinhar nomenclatura (`format`, `ImportInput.kind`) com essas specs ao implementar.
- **Event bus síncrono vs fila**: o `emit` é `await` sequencial inline — suficiente para auto-título/telemetria. Webhooks lentos podem atrasar a resposta HTTP; se virar problema, mover hooks "lentos" para fire-and-forget (não-await) ou uma fila. Decisão adiável.
- **Bundle**: tudo é TS puro do core; o esbuild (`build-server.mjs:18-21`) inlina sem mudança. Nenhum novo `--external`.
