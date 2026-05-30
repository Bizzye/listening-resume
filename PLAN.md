# Listening Resume

## Visão Geral

Software desktop que captura áudio do computador, grava sessões, transcreve e gera análises/resumos ao finalizar.

**Stack**: TypeScript · FFmpeg · Groq (transcrição) · Ollama (resumo local) · SQLite

**Filosofia**: custo zero no MVP, arquitetura extensível via adapters, pronto para novos providers e tipos de análise.

Inspiração: [Perssua](https://perssua.com/pt) — app que captura áudio de chamadas em tempo real, transcreve e fornece insights. O escopo deste projeto é mais enxuto: **gravação → transcrição → análise pós-sessão**. Recursos em tempo real ficam fora do MVP.

---

## Decisões de Produto

### Problema que o MVP resolve

- Gravar reuniões, aulas, podcasts, entrevistas ou chamadas reproduzidas no computador.
- Gerar uma transcrição pesquisável com timestamps.
- Gerar um resumo/análise estruturada ao final.
- Manter dados salvos localmente por padrão.
- Custo zero para o usuário (Groq free tier + Ollama local).

### Fora do MVP

- Tradução em tempo real.
- Sugestões ao vivo durante conversa.
- Diarização avançada de speakers.
- Interface gráfica completa.
- Sincronização cloud.
- Captura "invisível" ou comportamento furtivo.

### Ponto crítico de escopo

"Áudio do computador" pode significar coisas diferentes:

1. **Áudio de saída**: o que toca nos alto-falantes/fone. Ex: voz dos outros no Meet/Zoom.
2. **Microfone**: a voz do usuário.
3. **Mix completo**: saída + microfone.

MVP começa com **áudio de saída no Linux**. A arquitetura deve permitir adicionar **microfone/mixagem** depois via adapters.

---

## Funcionalidades Core

1. **Descoberta de dispositivos** — listar fontes de áudio disponíveis.
2. **Captura de áudio** — capturar áudio de saída do sistema via FFmpeg.
3. **Gravação resiliente** — salvar áudio em chunks para evitar perda em crash.
4. **Transcrição** — converter áudio em texto com timestamps (Groq Whisper API).
5. **Análise/Resumo** — gerar output estruturado via LLM (Ollama local).
6. **Histórico local** — listar sessões com status, arquivos e metadados.

---

## Stack Definitiva

| Camada                     | Tecnologia                            | Justificativa                                                         |
| -------------------------- | ------------------------------------- | --------------------------------------------------------------------- |
| **Linguagem**              | TypeScript (Node.js)                  | Type safety, DX, ecossistema LLM maduro, caminho natural para desktop |
| **Runtime**                | Node.js 20+                           | LTS, suporte ESM, boa performance I/O                                 |
| **CLI**                    | `commander`                           | Simples, maduro, zero magia                                           |
| **Captura de áudio**       | FFmpeg (subprocess)                   | Cross-platform, grava monitor de sink no Linux, WASAPI no Windows     |
| **Processamento**          | `fluent-ffmpeg`                       | Wrapper tipado para FFmpeg                                            |
| **Transcrição (MVP)**      | **Groq API** (Whisper large-v3-turbo) | Free tier: 8h/dia, 228x real-time, modelo large-v3 (melhor acurácia)  |
| **Transcrição (fallback)** | `whisper.cpp` (subprocess)            | Offline, privacidade total, sem custo                                 |
| **Resumo/Análise (MVP)**   | **Ollama** (local)                    | Custo zero, privacidade, modelos como Llama 3, Mistral, Qwen          |
| **Resumo (alternativo)**   | Groq LLM API / OpenAI / Anthropic     | Para quem quer qualidade cloud ou não tem hardware local              |
| **ORM/DB**                 | `better-sqlite3` + `drizzle-orm`      | Síncrono, rápido, type-safe                                           |
| **Validação**              | `zod`                                 | Schemas tipados para config, API responses, domain models             |
| **Configuração**           | `dotenv` + arquivo TOML               | `.env` para secrets, TOML para preferências                           |
| **Output CLI**             | `chalk` + `ora`                       | Cores e spinners no terminal                                          |
| **Testes**                 | `vitest`                              | Rápido, ESM nativo, compatível com TS                                 |
| **Lint/Format**            | `biome`                               | Rápido, substitui ESLint + Prettier                                   |
| **Build**                  | `tsup`                                | Bundle simples para CLI                                               |

### Dependências do sistema

- `ffmpeg` — captura e processamento de áudio
- `ollama` — LLM local para resumo (deve estar rodando)
- Groq API key (free tier) — transcrição

---

## Limites do Groq Free Tier (transcrição)

| Limite          | Valor            | Significado                           |
| --------------- | ---------------- | ------------------------------------- |
| Requests/minuto | 20               | Máx 20 chunks por minuto              |
| Requests/dia    | 2.000            | Suficiente para ~16h em chunks de 30s |
| Áudio/hora      | 7.200s (2h)      | Gargalo por hora                      |
| **Áudio/dia**   | **28.800s (8h)** | Limite diário real                    |

Reseta a cada 24h. Para uso normal (2-5 reuniões/dia), nunca será problema.

---

## Arquitetura

### Princípio: Ports and Adapters

O domínio não sabe qual provider está sendo usado. Cada componente externo é acessado via interface (port) com implementações concretas (adapters).

```text
┌──────────────────────────────────────────────────────────────────┐
│                           CLI Layer                               │
│               commander (listen record | list | show)             │
└──────────────────────────────┬───────────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────────┐
│                      Application Services                         │
│  SessionService · RecordingService · TranscriptionService         │
│  AnalysisService · ExportService                                  │
└──────────────────────────────┬───────────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────────┐
│                         Domain Models                             │
│  Session · AudioChunk · Transcript · Analysis · JobStatus         │
└──────────────────────────────┬───────────────────────────────────┘
                               │ Ports (interfaces TypeScript)
┌──────────────────────────────▼───────────────────────────────────┐
│                        Adapter Layer                              │
│                                                                   │
│  AudioCapturePort:                                                │
│    ├─ FFmpegPulseAdapter (Linux)                                  │
│    ├─ FFmpegWasapiAdapter (Windows) [futuro]                      │
│    └─ FileAdapter (testes/replay)                                 │
│                                                                   │
│  TranscriberPort:                                                 │
│    ├─ GroqWhisperAdapter (MVP — free tier)                        │
│    ├─ WhisperCppAdapter (fallback offline)                        │
│    ├─ OpenAIWhisperAdapter [futuro]                               │
│    └─ DeepgramAdapter [futuro]                                    │
│                                                                   │
│  AnalyzerPort:                                                    │
│    ├─ OllamaAdapter (MVP — local, custo zero)                     │
│    ├─ GroqLLMAdapter (alternativo — free tier LLMs)               │
│    ├─ OpenAIAdapter [futuro]                                      │
│    ├─ AnthropicAdapter [futuro]                                   │
│    └─ CustomPromptAdapter (prompts customizáveis)                 │
│                                                                   │
│  SessionRepository:                                               │
│    └─ SQLiteRepository (drizzle-orm)                              │
│                                                                   │
│  FileStoragePort:                                                 │
│    └─ LocalFileStorage                                            │
│                                                                   │
│  ExporterPort:                                                    │
│    ├─ MarkdownExporter                                            │
│    ├─ JSONExporter                                                │
│    └─ SRTExporter [futuro]                                        │
└──────────────────────────────────────────────────────────────────┘
```

### Por que "AnalyzerPort" em vez de "SummarizerPort"?

"Resumo" é apenas **um tipo** de análise. A mesma transcrição pode gerar:

- Resumo executivo
- Action items
- Decisões tomadas
- Análise de sentimento
- Extração de entidades (nomes, datas, valores)
- Q&A sobre o conteúdo
- Tradução
- Feedback de apresentação

O `AnalyzerPort` recebe transcrição + tipo de análise (via prompt template) e retorna resultado estruturado. Isso permite adicionar novos "tipos de análise" sem mudar código — apenas novos prompts.

---

## Patterns Importantes

### 1. Ports and Adapters (Hexagonal)

```typescript
// ports/transcriber.ts
export interface TranscriberPort {
  transcribe(audioPath: string, options: TranscribeOptions): Promise<TranscriptResult>;
  supports(format: string): boolean;
}

// adapters/transcription/groq-whisper.ts
export class GroqWhisperAdapter implements TranscriberPort { ... }

// adapters/transcription/whisper-cpp.ts
export class WhisperCppAdapter implements TranscriberPort { ... }
```

### 2. Pipeline em estágios

```text
capture → chunk → persist → transcribe → merge → analyze → export
```

Cada estágio é independente. Falha num estágio não perde o progresso dos anteriores.

### 3. State Machine para sessão

```text
created → recording → stopped → transcribing → analyzing → completed
                         │                          │
                         └──────── failed ──────────┘
```

### 4. Strategy Pattern para providers

Transcrição e análise são plugáveis. A config escolhe qual adapter usar:

```typescript
function createTranscriber(config: Config): TranscriberPort {
  switch (config.transcription.provider) {
    case "groq":
      return new GroqWhisperAdapter(config);
    case "whisper-cpp":
      return new WhisperCppAdapter(config);
    case "openai":
      return new OpenAIWhisperAdapter(config);
  }
}
```

### 5. Template Pattern para análises

Análises são definidas por prompt templates:

```typescript
export interface AnalysisTemplate {
  id: string;
  name: string;
  systemPrompt: string;
  userPromptTemplate: string; // usa {{transcript}} como variável
  outputSchema?: ZodSchema; // validação estruturada opcional
}
```

Permite ao usuário criar templates customizados sem alterar código.

### 6. Repository Pattern

SQLite não vaza para o domínio. Drizzle dá type-safety nas queries.

### 7. Idempotência

- Chunk já transcrito → pular.
- Análise falhou → transcrição permanece salva.
- Crash → retomar do último chunk processado.
- Re-rodar análise com template diferente → não duplica transcrição.

### 8. Rate Limiter interno

Respeitar limites do Groq automaticamente:

```typescript
// Throttle: max 20 requests/min, max 7200 audio_seconds/hour
const rateLimiter = new SlidingWindowLimiter({
  requestsPerMinute: 18, // margem de segurança
  audioSecondsPerHour: 7000,
});
```

---

## Fluxo Principal

### MVP

```text
1. Usuário roda `listen record`
2. App detecta sink monitor padrão via FFmpeg/pactl
3. FFmpeg grava chunks de 30s em WAV 16kHz mono
4. Usuário finaliza com Ctrl+C
5. App fecha chunk atual com segurança (signal handling)
6. App envia chunks para Groq Whisper API (rate-limited)
7. App junta transcrição com timestamps
8. App envia transcrição para Ollama (resumo local)
9. App salva tudo: áudio + transcrição + análise
10. App exibe resumo no terminal
```

### Por que foreground no MVP?

`listen start/stop` exige daemon, PID file, socket IPC. Complexidade desnecessária antes de validar captura + transcrição.

- MVP: `listen record` em foreground, Ctrl+C para parar.
- V2: `listen start`, `listen stop`, `listen status` com background worker.

---

## Estrutura de Pastas

```text
listening-resume/
├── src/
│   ├── index.ts                    # entry point
│   ├── cli.ts                      # comandos CLI
│   ├── config/
│   │   ├── schema.ts               # zod schemas de config
│   │   └── loader.ts               # carrega TOML + .env
│   ├── domain/
│   │   ├── models.ts               # Session, AudioChunk, Transcript, Analysis
│   │   ├── states.ts               # state machine
│   │   └── errors.ts               # domain errors
│   ├── application/
│   │   ├── session.service.ts
│   │   ├── recording.service.ts
│   │   ├── transcription.service.ts
│   │   ├── analysis.service.ts
│   │   └── export.service.ts
│   ├── ports/
│   │   ├── audio-capture.ts
│   │   ├── transcriber.ts
│   │   ├── analyzer.ts
│   │   ├── repository.ts
│   │   ├── file-storage.ts
│   │   └── exporter.ts
│   ├── adapters/
│   │   ├── audio/
│   │   │   ├── ffmpeg-pulse.ts     # Linux
│   │   │   ├── ffmpeg-wasapi.ts    # Windows (futuro)
│   │   │   └── file-input.ts       # testes/replay
│   │   ├── transcription/
│   │   │   ├── groq-whisper.ts     # MVP
│   │   │   ├── whisper-cpp.ts      # fallback local
│   │   │   └── openai-whisper.ts   # futuro
│   │   ├── analysis/
│   │   │   ├── ollama.ts           # MVP
│   │   │   ├── groq-llm.ts        # alternativo
│   │   │   └── openai.ts          # futuro
│   │   ├── persistence/
│   │   │   ├── sqlite.ts
│   │   │   └── local-files.ts
│   │   └── export/
│   │       ├── markdown.ts
│   │       └── json.ts
│   ├── templates/                   # prompt templates para análises
│   │   ├── meeting-summary.ts
│   │   ├── action-items.ts
│   │   ├── decisions.ts
│   │   └── custom.ts
│   └── utils/
│       ├── rate-limiter.ts
│       ├── subprocess.ts
│       ├── logger.ts
│       └── signal-handler.ts
├── tests/
│   ├── unit/
│   ├── integration/
│   └── fixtures/                    # WAV curto para testes
├── templates/                       # prompt templates customizáveis pelo usuário
│   └── example-custom-analysis.toml
├── package.json
├── tsconfig.json
├── biome.json
├── drizzle.config.ts
├── .env.example
├── README.md
└── PLAN.md
```

---

## Modelo de Dados

### Schema SQLite (via Drizzle)

```typescript
// sessions
export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(), // uuid
  title: text("title"),
  status: text("status").notNull(), // state machine
  startedAt: text("started_at"),
  endedAt: text("ended_at"),
  audioSource: text("audio_source"),
  language: text("language").default("auto"),
  createdAt: text("created_at").notNull(),
});

// audio_chunks
export const audioChunks = sqliteTable("audio_chunks", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  index: integer("index").notNull(),
  path: text("path").notNull(),
  durationMs: integer("duration_ms"),
  sampleRate: integer("sample_rate").default(16000),
  status: text("status").notNull(), // recorded | transcribed | failed
});

// transcripts
export const transcripts = sqliteTable("transcripts", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  pathJson: text("path_json"), // segments com timestamps
  pathTxt: text("path_txt"), // texto bruto
  language: text("language"),
  provider: text("provider"), // groq | whisper-cpp | openai
  model: text("model"),
  createdAt: text("created_at").notNull(),
});

// analyses (plural: permite múltiplas análises por sessão)
export const analyses = sqliteTable("analyses", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  templateId: text("template_id").notNull(), // meeting-summary, action-items, etc.
  provider: text("provider").notNull(), // ollama | groq | openai
  model: text("model").notNull(),
  pathMd: text("path_md"),
  pathJson: text("path_json"), // structured output quando disponível
  createdAt: text("created_at").notNull(),
});
```

Nota: tabela `analyses` (não `summaries`) porque uma sessão pode ter **múltiplas análises** com templates diferentes.

---

## Sistema de Templates de Análise

### Templates built-in

| Template ID       | Descrição                              | Output               |
| ----------------- | -------------------------------------- | -------------------- |
| `meeting-summary` | Resumo executivo de reunião            | Markdown estruturado |
| `action-items`    | Lista de pendências e responsáveis     | JSON + Markdown      |
| `decisions`       | Decisões tomadas na sessão             | Markdown             |
| `key-topics`      | Tópicos principais discutidos          | Lista                |
| `questions`       | Perguntas levantadas e respostas dadas | Markdown             |
| `sentiment`       | Análise de tom/sentimento geral        | JSON                 |

### Templates customizáveis pelo usuário

Arquivo TOML em `~/.config/listening-resume/templates/`:

```toml
[template]
id = "sales-call"
name = "Análise de Call de Vendas"

[template.prompt]
system = """
Você é um analista de vendas experiente.
Analise a transcrição de uma call comercial.
"""

user = """
Transcrição:
{{transcript}}

Gere:
1. Status do lead (quente/morno/frio)
2. Objeções levantadas
3. Próximos passos acordados
4. Pontos de melhoria do vendedor
5. Probabilidade de fechamento
"""
```

### Execução

```bash
# Usa template padrão (meeting-summary)
listen record

# Especifica template
listen record --template action-items

# Roda análise adicional sobre sessão existente
listen analyze <session-id> --template sales-call

# Roda múltiplas análises
listen analyze <session-id> --template meeting-summary --template action-items
```

---

## Configuração

### `~/.config/listening-resume/config.toml`

```toml
[audio]
backend = "ffmpeg-pulse"        # ffmpeg-pulse | ffmpeg-wasapi
device = "default"              # ou nome específico do sink
chunk_seconds = 30
sample_rate = 16000
channels = 1

[transcription]
provider = "groq"               # groq | whisper-cpp | openai
model = "whisper-large-v3-turbo"
language = "auto"               # auto | pt | en | es ...

[transcription.fallback]
provider = "whisper-cpp"        # usado quando Groq falha/offline
model = "small"

[analysis]
provider = "ollama"             # ollama | groq | openai | anthropic
model = "llama3.1:8b"          # modelo do Ollama
default_template = "meeting-summary"

[analysis.fallback]
provider = "groq"
model = "llama-3.3-70b-versatile"

[storage]
data_dir = "~/.local/share/listening-resume"

[rate_limits]
groq_rpm = 18                   # margem do limite de 20
groq_audio_seconds_per_hour = 7000  # margem do limite de 7200
```

### `.env`

```text
GROQ_API_KEY=gsk_...
# Opcionais (para adapters futuros):
# OPENAI_API_KEY=sk-...
# ANTHROPIC_API_KEY=sk-ant-...
```

---

## Gargalos e Riscos Técnicos

### 1. Captura de áudio — maior risco do projeto

**Riscos:**

- Linux pode usar PulseAudio, PipeWire com compat Pulse, ou JACK.
- Monitor do sink padrão muda quando troca fone/caixa.
- FFmpeg pode ter comportamento diferente entre distros.

**Mitigação:**

- Spike técnico antes de tudo.
- Comando `listen devices` para listar sinks.
- Flag `--device <name>` como escape hatch.
- Testar em Ubuntu, Fedora e Arch.

### 2. Groq pode mudar/remover free tier

**Mitigação:**

- Adapter pattern: trocar para `whisper-cpp` (offline) ou OpenAI com uma linha de config.
- Manter `whisper-cpp` como fallback funcional desde o MVP.

### 3. Ollama precisa estar rodando

**Mitigação:**

- Verificar conexão com Ollama antes de começar análise.
- Mensagem clara se Ollama não estiver disponível.
- Fallback para Groq LLM (free tier inclui Llama 3.3 70B).

### 4. Reuniões longas podem estourar contexto do LLM

**Mitigação:**

- Pipeline de resumo hierárquico:
  1. Transcrição dividida em blocos de ~4000 tokens.
  2. Resumo parcial de cada bloco.
  3. Consolidação dos resumos parciais.
  4. Output final estruturado.

### 5. Rate limiting do Groq

**Mitigação:**

- Rate limiter interno com sliding window.
- Queue de chunks com retry exponencial.
- Progresso salvo: se limite atingido, retomar depois.

### 6. Privacidade

**Mitigação:**

- Transcrição via Groq envia áudio para cloud — documentar claramente.
- Oferecer fallback `whisper-cpp` para quem quer 100% local.
- Análise com Ollama é 100% local por default.
- Nunca commitar `.env`.

### 7. Tamanho de arquivo por sessão

1 hora de áudio 16kHz mono WAV ≈ 115MB.

**Mitigação:**

- Comprimir para OPUS após transcrição (1h ≈ 3-5MB).
- Opção de deletar WAV original após compressão.
- Config de retenção: manter últimos N dias.

---

## Fases de Desenvolvimento

### Fase 0 — Spike de captura (1-2 dias)

- [ ] Criar projeto TS mínimo (`package.json`, `tsconfig.json`).
- [ ] Listar sinks de áudio via `pactl list sinks`.
- [ ] Gravar 30s do monitor padrão via FFmpeg subprocess.
- [ ] Salvar WAV 16kHz mono e validar reprodução.
- [ ] Documentar dependências do sistema.

**Critério**: gravar áudio de saída no Linux de forma repetível.

### Fase 1 — MVP CLI (1-2 semanas)

- [ ] Estrutura completa `src/` com ports e adapters.
- [ ] Config com TOML + `.env` + zod validation.
- [ ] `listen devices` — listar fontes de áudio.
- [ ] `listen record` — gravar em foreground com Ctrl+C.
- [ ] Gravação em chunks WAV 16kHz mono via FFmpeg.
- [ ] Signal handling graceful (SIGINT/SIGTERM).
- [ ] Transcrição via Groq Whisper API com rate limiter.
- [ ] Merge de transcrições com timestamps.
- [ ] Análise via Ollama com template `meeting-summary`.
- [ ] SQLite + drizzle para sessões/chunks/análises.
- [ ] `listen list` — listar sessões.
- [ ] `listen show <id>` — ver transcrição e resumo.
- [ ] Export em Markdown.

**Critério**: gravar sessão, transcrever via Groq, resumir via Ollama, consultar depois.

### Fase 2 — Robustez e fallbacks (1 semana)

- [ ] Fallback `whisper-cpp` quando Groq falha.
- [ ] Fallback Groq LLM quando Ollama não disponível.
- [ ] Retomar sessão após crash (idempotência por chunk).
- [ ] Retry com backoff exponencial.
- [ ] Compressão OPUS após transcrição.
- [ ] Logging estruturado.
- [ ] Testes unitários dos services.
- [ ] Testes de integração com fixture de áudio.

### Fase 3 — Templates e análises múltiplas

- [ ] Sistema de templates (`meeting-summary`, `action-items`, `decisions`).
- [ ] `listen analyze <id> --template <name>` — rodar análise extra.
- [ ] Templates customizáveis via TOML.
- [ ] Resumo hierárquico para transcrições longas.
- [ ] Structured output com zod validation.

### Fase 4 — Background service

- [ ] `listen start` / `listen stop` / `listen status`.
- [ ] Processo em background com PID file.
- [ ] IPC via Unix socket ou named pipe.
- [ ] Auto-transcrição ao finalizar.

### Fase 5 — Cross-platform

- [ ] Adapter FFmpeg WASAPI para Windows.
- [ ] Testes em Windows.
- [ ] Resolver diferenças de devices e permissões.
- [ ] Documentar setup por plataforma.

### Fase 6 — Interface desktop

- [ ] Tray icon com controles (Electron tray ou Tauri).
- [ ] Notificação ao concluir análise.
- [ ] Lista de sessões em janela simples.
- [ ] Open in editor/browser.

### Fase 7 — Recursos avançados

- [ ] Captura de microfone + saída com mixagem.
- [ ] Diarização (speaker separation).
- [ ] Novos providers (Deepgram, AssemblyAI).
- [ ] Transcrição streaming/real-time.
- [ ] Integrações: Obsidian, Notion, webhooks.
- [ ] Plugin system para adapters comunitários.

---

## Testabilidade

### Sem áudio real (unitários)

- Criação de sessão e transição de estados.
- Rate limiter (comportamento de throttle).
- Parsing de responses dos providers.
- Chunking de transcrição para resumo hierárquico.
- Validação de config com zod.
- Template rendering.

### Com fixture (integração)

- Transcrever WAV curto versionado em `tests/fixtures/`.
- Gerar análise com adapter fake/mock.
- Simular falha em chunk intermediário e retomada.
- Simular rate limit e verificar enfileiramento.

### Manual

- Captura do monitor de áudio no Linux.
- Sessão de 30, 60 e 120 minutos.
- Troca de dispositivo durante gravação.
- Ollama indisponível → fallback funciona.
- Groq rate limit atingido → queue funciona.

---

## Observabilidade

Logs mínimos por sessão:

- Device selecionado e sample rate.
- Chunk criado (index, duração, tamanho).
- Transcrição: provider, modelo, tempo de resposta, idioma detectado.
- Análise: provider, modelo, template usado, tokens consumidos.
- Erros com stack trace em arquivo de log.
- Rate limit warnings.

---

## Extensibilidade — Como adicionar novos providers

### Novo provider de transcrição

1. Implementar `TranscriberPort` interface.
2. Criar arquivo em `src/adapters/transcription/`.
3. Registrar no factory (`createTranscriber`).
4. Adicionar opção no schema de config.

### Novo tipo de análise

1. Criar arquivo em `src/templates/` ou `~/.config/listening-resume/templates/`.
2. Definir prompt system + user com `{{transcript}}`.
3. Usar via `--template <id>`.

### Novo provider de LLM

1. Implementar `AnalyzerPort` interface.
2. Criar arquivo em `src/adapters/analysis/`.
3. Registrar no factory.
4. Adicionar no schema de config.

### Novo formato de export

1. Implementar `ExporterPort` interface.
2. Criar arquivo em `src/adapters/export/`.
3. Adicionar opção no CLI (`--format`).

---

## Dependências (package.json)

```json
{
  "dependencies": {
    "commander": "^12.0.0",
    "better-sqlite3": "^11.0.0",
    "drizzle-orm": "^0.35.0",
    "zod": "^3.23.0",
    "dotenv": "^16.0.0",
    "chalk": "^5.0.0",
    "ora": "^8.0.0",
    "fluent-ffmpeg": "^2.1.0",
    "groq-sdk": "^0.8.0",
    "ollama": "^0.5.0",
    "uuid": "^10.0.0",
    "toml": "^3.0.0"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "tsup": "^8.0.0",
    "vitest": "^2.0.0",
    "@biomejs/biome": "^1.9.0",
    "@types/better-sqlite3": "^7.0.0",
    "@types/fluent-ffmpeg": "^2.1.0",
    "drizzle-kit": "^0.25.0"
  }
}
```

---

## Riscos de Arquitetura

| Risco                             | Impacto | Mitigação                              |
| --------------------------------- | ------- | -------------------------------------- |
| Captura Linux inconsistente       | Alto    | Spike técnico antes do resto           |
| Groq remove free tier             | Médio   | whisper-cpp como fallback funcional    |
| Ollama não instalado/rodando      | Médio   | Fallback Groq LLM + mensagem clara     |
| Reunião longa estoura contexto    | Alto    | Resumo hierárquico por blocos          |
| Rate limit Groq atingido          | Médio   | Queue interna + retry + fallback local |
| MVP virar app desktop cedo demais | Alto    | CLI primeiro, desktop depois           |
| Privacidade (áudio vai para Groq) | Médio   | Documentar + oferecer whisper-cpp      |
| Acoplamento a um provider         | Médio   | Interfaces desde o dia 1               |

---

## Próximo Passo

**Fase 0 — Spike de captura**:

1. `npm init` + TypeScript setup.
2. Script que lista sinks via `pactl list sinks short`.
3. Script que grava 30s do monitor padrão via FFmpeg.
4. Validar WAV gerado.
5. Se funcionar → avançar para Fase 1.

```bash
# Comando equivalente que o spike deve reproduzir via código:
ffmpeg -f pulse -i default.monitor -ac 1 -ar 16000 -t 30 chunk_001.wav
```
