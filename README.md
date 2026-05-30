# Listening Resume

Grava áudio do sistema (videoaulas, reuniões, podcasts), transcreve automaticamente e gera resumos inteligentes com IA.

## Funcionalidades

- **Captura de áudio** — grava áudio do sistema + microfone simultaneamente (PipeWire/PulseAudio no Linux, WASAPI no Windows)
- **Transcrição automática** — Whisper via Groq, OpenAI ou whisper-cpp local
- **Análise com IA** — resumos, notas de estudo, atas de reunião via Ollama, Groq, OpenAI ou Anthropic
- **Templates personalizáveis** — crie seus próprios prompts de análise
- **Interface gráfica** — app desktop com Tauri (leve, nativo)
- **Indicador de gravação** — ícone na bandeja do sistema muda quando está gravando
- **Controle de mute** — mute/unmute microfone e áudio do sistema durante a gravação
- **CLI** — interface de linha de comando para uso headless

## Arquitetura

```
listening-resume/
├── packages/core/     # Lógica de negócio (captura, transcrição, análise)
├── apps/gui/          # App desktop (Tauri + React + Vite)
└── apps/cli/          # Interface de linha de comando
```

## Requisitos

### Linux

- Node.js ≥ 20
- FFmpeg
- PipeWire ou PulseAudio

### Windows

- Node.js ≥ 20
- FFmpeg (incluso no instalador)
- Nenhuma configuração adicional de áudio necessária (usa WASAPI)

### Providers de IA (pelo menos um):

| Provider | Uso | Configuração |
|----------|-----|-------------|
| **Groq** (recomendado) | Transcrição + Análise | `GROQ_API_KEY` no `.env` |
| **Ollama** | Análise local | Instalar e rodar `ollama serve` |
| **whisper-cpp** | Transcrição local | Instalar binário |
| **OpenAI** | Transcrição + Análise | `OPENAI_API_KEY` no `.env` |
| **Anthropic** | Análise | `ANTHROPIC_API_KEY` no `.env` |

## Instalação

### Linux (rápido)

```bash
./install.sh
```

### Desenvolvimento

```bash
# Instalar dependências
pnpm install

# Rodar em modo desenvolvimento
pnpm dev

# Build + instalar localmente (.deb)
pnpm --filter gui install:linux
```

### Windows

```bash
pnpm --filter gui build:windows
```

Gera o instalador `.exe` em `apps/gui/src-tauri/target/release/bundle/nsis/`.

## Configuração

Copie o `.env.example` para `.env` e configure suas API keys:

```bash
cp .env.example .env
```

```env
GROQ_API_KEY=gsk_...
```

## Comandos

| Comando | Descrição |
|---------|-----------|
| `pnpm dev` | Inicia GUI em modo desenvolvimento |
| `pnpm build` | Build de todos os pacotes |
| `pnpm --filter gui build:linux` | Gera .deb para Linux |
| `pnpm --filter gui install:linux` | Build + instala .deb localmente |
| `pnpm --filter gui build:windows` | Gera .exe para Windows (rodar no Windows) |
| `pnpm test` | Roda todos os testes |
| `pnpm listen` | CLI: inicia gravação |

## Stack

- **Frontend**: React, Tailwind CSS, Zustand, Vite
- **Desktop**: Tauri v2 (Rust)
- **Backend**: Node.js (servidor HTTP embarcado na app)
- **Banco**: SQLite (better-sqlite3 + Drizzle ORM)
- **Áudio**: FFmpeg (subprocess)
- **Transcrição**: Whisper (Groq/OpenAI/local)
- **Análise**: LLMs (Ollama/Groq/OpenAI/Anthropic)

## Licença

Projeto pessoal.
