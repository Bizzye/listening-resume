# 10 — Refatorar server.ts em handlers por domínio + router testável

> Status: proposta · Esforço: 🟡 · Impacto: testabilidade do backend (hoje 0 testes em 1238 linhas), manutenção, base para specs 11/12/13 · Depende de: nada (pré-requisito recomendado das demais specs)

## Problema

`apps/gui/server.ts` é um *god file* de 1238 linhas, sem nenhum teste. Toda a lógica de roteamento HTTP, parsing de body, CORS, tratamento de erro e a regra de cada endpoint vivem dentro de um único callback `http.createServer(async (req, res) => { ... })`. As consequências:

- **Impossível testar unidades isoladas.** Não há como exercitar "transcrever sessão" sem subir um servidor HTTP real na porta 3456 (que ainda colide com o app instalado / `pnpm dev` — ver CLAUDE.md "Gotchas").
- **Roteamento por cascata de `if`.** O matching é uma sequência de `if (route === ... && req.method === ...)` com `route.split("/")[3]`, `route.match(/regex/)` e checagens de `route.split("/").length === 4` espalhadas (ex: `server.ts:375-379`). Qualquer endpoint novo é mais um `if` no meio do bloco gigante.
- **Estado global solto.** `activeSessionId`/`recordingStartTime` (`server.ts:107-108`) e os handles de playback em `globalThis.__playbackProcess` (`server.ts:746-854`) são mutados de dentro do callback, sem encapsulamento.
- **Boilerplate repetido.** "achar sessão por prefixo de id" aparece em ~8 endpoints (`const sessions = repo.listSessions(200); const session = sessions.find((s) => s.id.startsWith(id))` — ex: `server.ts:384-386`, `534-536`, `586-588`, `654-656`, `730-732`, `1100-1102`, `1124-1126`, `1192-1194`).

## Como está hoje

Toda a aplicação é montada no topo do módulo (`server.ts:61-145`): `loadConfig()`, `SQLiteRepository`, `LocalFileStorage`, escolha do adapter de captura, `RecordingService`, boot-reconcile e estado mutável global.

Helpers locais:
- `json(res, data, status)` — `server.ts:173-181` (escreve headers CORS + JSON).
- `readBody(req)` — `server.ts:183-189`.
- `getAudioDuration(sessionId)` — `server.ts:195-248` (parser WAV robusto; ver spec 11).
- `generateBeepWav(filePath)` — `server.ts:147-171`.

O `createServer` (`server.ts:250-1216`) trata CORS preflight (`server.ts:255-263`), envolve tudo num `try/catch` que vira `500` (`server.ts:1211-1215`), e roteia inline. Grupos de endpoints identificados:

| Grupo | Endpoints (rota — `server.ts:linha`) |
|---|---|
| **audio/devices** | `POST /api/audio/test` (267), `GET /api/devices` (322) |
| **recording** | `POST /api/recording/start` (413), `POST /api/recording/stop` (444), `GET /api/recording/status` (466), `POST /api/recording/mute` (480), `GET /api/recording/levels` (507) |
| **sessions** | `GET /api/sessions` (328), `GET /api/sessions/:id` (375), `DELETE /api/sessions/:id` (1190) |
| **transcribe** | `POST /api/sessions/:id/transcribe` (529) |
| **analyze** | `POST /api/sessions/:id/analyze` (581), `DELETE /api/analyses/:id` (642) |
| **playback** | `GET /api/sessions/:id/audio` (649), `POST /api/sessions/:id/play` (725), `DELETE /api/sessions/:id/play` (871), `GET /api/playback/status` (895) |
| **templates** | `GET /api/templates` (910), `POST /api/templates` (916), `PUT /api/templates/:id` (939), `DELETE /api/templates/:id` (959) |
| **config** | `GET /api/config` (971), `POST /api/config/groq-key` (999), `DELETE /api/config/groq-key` (1059), `POST /api/config/mic` (1080), `GET /api/config/export-dir` (1164), `POST /api/config/export-dir` (1173) |
| **export** | `GET /api/sessions/:id/export` (1094), `POST /api/sessions/:id/export/save` (1118) |

`server.listen(PORT)` + handlers de `EADDRINUSE`/`SIGTERM`/`SIGINT`: `server.ts:1218-1238`.

## O que precisa ser feito

1. Separar **composição** (criação de config/repo/adapters/services — o "container") da **definição de rotas**.
2. Expor um `createApiRouter(deps)` puro que recebe as dependências por injeção e devolve um handler `(req, res) => Promise<void>`, **testável sem porta de rede** (instanciando `http.IncomingMessage`/`ServerResponse` fakes ou via `supertest`/`undici`).
3. Extrair handlers por domínio em arquivos pequenos.
4. Extrair middleware: CORS, parsing de body JSON, wrapper de erro → `500`, e o helper `json`.
5. Centralizar utilitários repetidos (`findSessionByPrefix`, `getAudioDuration`).
6. Manter o entrypoint `server.ts` como um arquivo fino que só monta o container e chama `server.listen`.
7. **Garantir que `scripts/build-server.mjs` continue funcionando** (esbuild aponta para `server.ts`).

## Como implementar

### Estrutura proposta

```
apps/gui/
├── server.ts                       # entrypoint fino (mantém o nome — é o que o esbuild bundla)
└── server/
    ├── container.ts                # createContainer(): monta config, repo, storage, capture, services, estado
    ├── router.ts                   # createApiRouter(deps) → (req,res) handler; tabela de rotas
    ├── types.ts                    # ApiDeps, Handler, RouteMatch
    ├── middleware/
    │   ├── cors.ts                 # applyCors(res), handlePreflight(req,res)
    │   ├── body.ts                 # readBody / readJson
    │   ├── respond.ts              # json(res, data, status)  (movido de server.ts:173-181)
    │   └── errors.ts              # withErrorHandling(handler)
    ├── lib/
    │   ├── sessions.ts             # findSessionByPrefix(repo, idPrefix)
    │   └── audio-duration.ts       # getAudioDuration (ver spec 11 — vira import do core)
    └── handlers/
        ├── devices.ts             # GET /api/devices, POST /api/audio/test
        ├── recording.ts           # start/stop/status/mute/levels
        ├── sessions.ts            # list/detail/delete
        ├── transcribe.ts          # POST :id/transcribe
        ├── analyze.ts             # POST :id/analyze, DELETE /api/analyses/:id
        ├── playback.ts            # audio/play/play(DELETE)/playback-status (+ estado playback encapsulado)
        ├── templates.ts          # CRUD templates
        ├── config.ts             # config GET, groq-key, mic, export-dir
        └── export.ts             # export, export/save
```

### Tipos centrais (`server/types.ts`)

```ts
import type http from "node:http";
import type { AppConfig } from "@listening-resume/core";

export interface ApiDeps {
  config: AppConfig;
  dataDir: string;
  repo: SessionRepository;            // import do core
  storage: FileStoragePort;
  capture: AudioCapturePort;
  recordingService: RecordingService;
  // estado mutável encapsulado, não global:
  state: {
    activeSessionId: string | null;
    recordingStartTime: number | null;
    groqApiKey: string;
    playback: { proc: ChildProcess | null; startTime: number; seekOffset: number };
  };
  // dependências de I/O para chave Groq (hoje inline em server.ts:112-145, 999-1077)
  configDir: string;
  configEnvPath: string;
}

export type Handler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: { deps: ApiDeps; url: URL; params: Record<string, string> },
) => Promise<void> | void;
```

### Router (`server/router.ts`)

Substituir a cascata de `if` por uma tabela. Cada rota é `{ method, pattern, handler }`, com `pattern` suportando `:id`. Casa o regex de id parcial que já existe (`/^\/api\/sessions\/[^/]+\/transcribe$/` etc.) via um matcher simples:

```ts
const routes: Array<{ method: string; pattern: string; handler: Handler }> = [
  { method: "GET",  pattern: "/api/devices",                    handler: listDevices },
  { method: "POST", pattern: "/api/audio/test",                 handler: testAudio },
  { method: "POST", pattern: "/api/recording/start",            handler: startRecording },
  { method: "GET",  pattern: "/api/sessions/:id",               handler: getSession },
  { method: "POST", pattern: "/api/sessions/:id/transcribe",    handler: transcribe },
  // ...
];

export function createApiRouter(deps: ApiDeps) {
  return withErrorHandling(async (req, res) => {
    if (req.method === "OPTIONS") return handlePreflight(req, res);  // server.ts:255-263
    const url = new URL(req.url ?? "/", "http://localhost");
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const params = matchPattern(r.pattern, url.pathname);
      if (params) return r.handler(req, res, { deps, url, params });
    }
    json(res, { error: "Not found" }, 404);  // server.ts:1210
  });
}
```

`matchPattern` precisa replicar o comportamento atual de **prefixo de id** só onde existe hoje (a resolução por prefixo é feita pelo handler via `findSessionByPrefix`, não pelo router — manter assim). O `:id` no pattern captura o segmento bruto; `findSessionByPrefix` (`server/lib/sessions.ts`) encapsula `repo.listSessions(200).find(s => s.id.startsWith(id))`.

### Handler de exemplo (`server/handlers/transcribe.ts`)

Move-se `server.ts:529-578` quase literal, trocando acessos a globais por `ctx.deps`:

```ts
export const transcribe: Handler = async (req, res, { deps, params }) => {
  const { repo, config, state } = deps;
  const session = findSessionByPrefix(repo, params.id);
  if (!session) return json(res, { error: "Session not found" }, 404);
  if (!state.groqApiKey)
    return json(res, { error: "GROQ_API_KEY not set. Configure in Settings." }, 500);
  const transcriber = new GroqWhisperAdapter(state.groqApiKey, config.transcription.model);
  const service = new TranscriptionService(transcriber, repo, {
    requestsPerMinute: config.rateLimits.groqRpm,
    audioSecondsPerHour: config.rateLimits.groqAudioSecondsPerHour,
  });
  repo.updateSession(session.id, { status: "transcribing" });
  try {
    const t = await service.transcribeSession(session.id, config.transcription.language, config.transcription.prompt || undefined);
    repo.updateSession(session.id, { status: "transcribed" });
    return json(res, { transcript: { segments: t.segments, fullText: t.fullText } });
  } catch (err) {
    repo.updateSession(session.id, { status: "stopped" });
    throw err;  // withErrorHandling vira 500
  }
};
```

> Nota: a instanciação de adapters dentro do handler (GroqWhisperAdapter, OllamaAdapter, etc.) é exatamente o que a **spec 13** propõe extrair para um *registry/factory*. Esta spec só move o código; a spec 13 troca a instanciação. Fazer 10 antes deixa 13 trivial (um ponto de mudança por handler).

### Entrypoint fino (`server.ts`)

```ts
import http from "node:http";
import { createContainer } from "./server/container.js";
import { createApiRouter } from "./server/router.js";

const deps = createContainer();              // toda a montagem de server.ts:61-145 + boot-reconcile
const server = http.createServer(createApiRouter(deps));
const PORT = 3456;
server.on("error", /* server.ts:1220-1226 */);
server.listen(PORT, /* server.ts:1228-1233 */);
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
```

A carga de `.env` da raiz (`server.ts:38-59`), o ajuste de `PATH` no Windows (`server.ts:24-36`) e o boot-reconcile (`server.ts:85-105`) vão para `container.ts`.

### Manter o bundle funcionando

`build-server.mjs:18-21` chama `esbuild server.ts --bundle ...`. Como o esbuild **resolve e inlina os imports relativos** (`./server/...`), o bundle continua um único `server-bundle.mjs` — **sem mudança no script**. Pontos de atenção:

- Os novos arquivos usam `import ... from "./server/..."` com extensão `.js` (regra ESM do projeto). Confirmar que o `tsconfig`/esbuild resolve. O esbuild com `--bundle` lida com isso.
- `--external:better-sqlite3 --external:drizzle-orm` continuam válidos (só o core importa esses).
- Rodar o build gate `pnpm --filter gui smoke:server` após a refatoração (boota o bundle + `GET /api/devices`).

### Ordem de migração segura

1. Criar `server/middleware/{respond,cors,body,errors}.ts` movendo `json`/`readBody`/preflight/try-catch **sem mudar comportamento**. Importá-los no `server.ts` atual. Rodar smoke.
2. Criar `server/lib/sessions.ts` (`findSessionByPrefix`) e substituir as ~8 cópias inline. Smoke.
3. Criar `server/container.ts` extraindo a montagem do topo. `server.ts` passa a importar `deps`. Smoke.
4. Criar `server/router.ts` + `server/types.ts` com a tabela vazia delegando ainda ao bloco antigo (feature flag), depois migrar **um grupo de handler por commit** (devices → recording → sessions → ...). Após cada grupo: smoke + teste novo.
5. Quando todos os grupos migrarem, apagar o bloco de `if` antigo.

## Plano de testes

- **Infra nova**: adicionar Vitest no `apps/gui` (hoje os testes vivem só no core). Configurar `vitest.config.ts` em `apps/gui`.
- **Unit (sem rede)**: para cada handler, montar `ApiDeps` com um `repo` fake (in-memory implementando `SessionRepository`) e mocks de services; chamar `handler(req, res, ctx)` com `req`/`res` fakes (objeto com `writeHead`/`end` espionados) e assertar status + corpo JSON.
  - `findSessionByPrefix`: acha por prefixo, retorna `null` quando não existe.
  - `matchPattern`: casa `/api/sessions/:id/transcribe`, rejeita método errado, extrai `params.id`.
  - `transcribe`: 404 sem sessão, 500 sem groqKey, rollback para `stopped` em erro do service.
  - `analyze`: 400 sem transcript, escolha primary/fallback conforme `config.analysis.provider`.
  - `config/groq-key`: rejeita origem não-local (403), valida formato `gsk_...`, persiste no `.env`.
- **Integração (com porta)**: 1 teste que sobe `createApiRouter` num `http.Server` efêmero (porta 0, não 3456) e faz `GET /api/devices` e `GET /api/sessions` via `fetch`.
- **Gate de build**: `pnpm --filter gui build:server && pnpm --filter gui smoke:server` precisa passar.

## Riscos / decisões em aberto

- **Estado de playback global** (`globalThis.__playbackProcess`): hoje sobrevive a `node --watch` reload? Não — reload limpa memória (CLAUDE.md). Mover para `deps.state.playback` mantém o comportamento; confirmar que nada externo lê `globalThis.__playback*`.
- **`node --watch` (dev:server)**: mais arquivos = mais triggers de reload. Aceitável; o watch já recarrega tudo.
- **Resolução de id parcial**: manter `listSessions(200)` + `startsWith` por enquanto (mesma semântica). Idealmente vira `repo.findByIdPrefix` no port (cruza com spec 12), mas fora do escopo desta spec.
- **Decidir framework**: manter `http` cru (zero deps, alinhado ao atual) vs adotar um micro-router. Recomendação: `http` cru + `matchPattern` próprio — não introduzir dependência nova que o esbuild teria que bundlar.
- **Origin guard** (`server.ts:1005-1013`): ao mover para middleware/handler, **preservar** o regex que libera `tauri.localhost`/`tauri://` (senão o app instalado quebra com 403 — bug já documentado em CLAUDE.md).
