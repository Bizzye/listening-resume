# Listening Resume — GUI Desktop

## Decisão de Stack

### Tauri v2 + React + TypeScript

| Componente       | Tecnologia                      | Justificativa                                                        |
| ---------------- | ------------------------------- | -------------------------------------------------------------------- |
| **Shell nativo** | Tauri v2                        | Binário ~5-10MB, webview do sistema, tray icon, notificações nativas |
| **Frontend**     | React 19 + TypeScript           | Ecossistema maduro, componentes prontos, familiaridade               |
| **Styling**      | Tailwind CSS 4                  | Rápido, utility-first, dark mode trivial                             |
| **State**        | Zustand                         | Leve, sem boilerplate, bom com async                                 |
| **Router**       | TanStack Router                 | Type-safe, file-based routing                                        |
| **Backend**      | Sidecar Node.js (CLI existente) | Reutiliza 100% do core já implementado                               |
| **IPC**          | Tauri Commands + Events         | Comunicação frontend ↔ backend tipada                                |
| **Build**        | Vite                            | HMR rápido, integração Tauri nativa                                  |
| **Monorepo**     | pnpm workspaces                 | Compartilha types entre GUI e core                                   |

### Por que Tauri v2 e não Electron?

- Binário final: **~8MB** vs **~150MB**
- RAM idle: **~30MB** vs **~100MB+**
- Usa webview nativa (WebKitGTK no Linux, WebView2 no Windows)
- Sistema de tray, notificações, autostart nativos
- Sidecar: pode empacotar o Node.js + CLI junto
- Segurança: capabilities system (permissões granulares)

---

## Arquitetura

```text
┌────────────────────────────────────────────────────────────────┐
│                        Tauri Window                             │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │               React Frontend (Webview)                    │  │
│  │                                                           │  │
│  │  ┌─────────┐ ┌──────────┐ ┌─────────┐ ┌──────────────┐  │  │
│  │  │ Record  │ │ Sessions │ │ Session │ │   Settings   │  │  │
│  │  │  View   │ │  List    │ │ Detail  │ │     View     │  │  │
│  │  └─────────┘ └──────────┘ └─────────┘ └──────────────┘  │  │
│  │                                                           │  │
│  │  ┌───────────────────────────────────────────────────┐   │  │
│  │  │            Hooks / Store (Zustand)                 │   │  │
│  │  └───────────────────────────────────────────────────┘   │  │
│  └──────────────────────────────────┬───────────────────────┘  │
│                                     │ Tauri invoke/events       │
├─────────────────────────────────────┼──────────────────────────┤
│               Tauri Rust Core       │                           │
│  ┌──────────────────────────────────▼───────────────────────┐  │
│  │  Commands: start_recording, stop_recording, list_sessions │  │
│  │            get_session, transcribe, analyze, get_devices   │  │
│  └──────────────────────────────────┬───────────────────────┘  │
│                                     │ spawn sidecar             │
│  ┌──────────────────────────────────▼───────────────────────┐  │
│  │           Node.js Sidecar (CLI existente)                 │  │
│  │  listening-resume record | transcribe | analyze | list    │  │
│  └───────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘

┌────────────────────────┐
│     System Tray        │
│  ● Recording...  0:45  │
│  ─────────────────     │
│  Start Recording       │
│  Stop Recording        │
│  ─────────────────     │
│  Open Window           │
│  Quit                  │
└────────────────────────┘
```

### Comunicação Frontend ↔ Backend

O Tauri v2 suporta **sidecar**: empacotar um binário (neste caso, o CLI Node.js bundado com `pkg` ou `sea`) que roda como processo filho. A comunicação se dá via:

1. **Tauri Commands** (Rust → Sidecar): o frontend chama `invoke("start_recording")`, o Rust spawna o sidecar com args adequados.
2. **Tauri Events** (Sidecar → Frontend): o sidecar emite eventos (chunk gravado, transcrição pronta) via stdout, que o Rust repassa ao frontend como events.
3. **SQLite direto**: o Tauri Rust core pode ler o SQLite diretamente para queries rápidas (listagem, busca) sem precisar do sidecar.

---

## Telas e UX

### 1. Dashboard (Home)

```
┌─────────────────────────────────────────────────────────┐
│  🎙 Listening Resume                          [─][□][×] │
├─────────────────────────────────────────────────────────┤
│                                                         │
│   ┌───────────────────────────────────────────────┐     │
│   │        ● Click to start recording             │     │
│   │          or press Ctrl+Shift+R                │     │
│   └───────────────────────────────────────────────┘     │
│                                                         │
│   Recent Sessions                                       │
│   ─────────────────────────────────────────────         │
│   ● Team Standup        completed   hoje 14:30   [▶]    │
│   ● Homelab Tutorial    completed   hoje 10:15   [▶]    │
│   ● 1:1 com Manager    recording   agora         [■]    │
│                                                         │
│                                          [Ver todas →]  │
└─────────────────────────────────────────────────────────┘
```

### 2. Recording (Gravando)

```
┌─────────────────────────────────────────────────────────┐
│  🔴 Recording — default.monitor              [─][□][×]  │
├─────────────────────────────────────────────────────────┤
│                                                         │
│          ●  Recording...                                │
│          ██████████████░░░░░░░░  0:10:34                │
│                                                         │
│   Device: G435 Wireless Headset                         │
│   Chunks: 21 saved                                      │
│   Size:   3.2 MB                                        │
│                                                         │
│        ┌──────────────────────────────┐                 │
│        │     ■  Stop & Transcribe     │                 │
│        └──────────────────────────────┘                 │
│                                                         │
│   [ ] Auto-analyze after transcription                  │
│   Template: [meeting-summary ▼]                         │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### 3. Session Detail

```
┌─────────────────────────────────────────────────────────┐
│  ← Sessions    Homelab Tutorial               [─][□][×] │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  [Transcript]  [Summary]  [Action Items]  [Export]      │
│  ─────────────────────────────────────────────────      │
│                                                         │
│  🔍 Search transcript...                                │
│                                                         │
│  [0:00] E fala pessoal vamos fazer um vídeo mais        │
│         otimista né um vídeo 100% técnico...            │
│                                                         │
│  [0:13] vocês o meu home lab e eu vou falar para        │
│         vocês né como é que foi o processo...            │
│                                                         │
│  [0:18] as coisas que eu tive que aprender as           │
│         coisas que eu acho que são úteis...              │
│                                                         │
│  ▶ Play segment                                         │
│                                                         │
├─────────────────────────────────────────────────────────┤
│  [Re-analyze ▼]  [Export .md]  [Copy text]  [Delete]    │
└─────────────────────────────────────────────────────────┘
```

### 4. Settings

```
┌─────────────────────────────────────────────────────────┐
│  ⚙ Settings                                  [─][□][×]  │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Audio                                                  │
│  ──────                                                 │
│  Device:        [G435 Wireless ▼]                       │
│  Chunk size:    [30s ▼]                                 │
│                                                         │
│  Transcription                                          │
│  ──────────────                                         │
│  Provider:      [Groq (free) ▼]                         │
│  Language:      [Auto-detect ▼]                         │
│  API Key:       [••••••••••••] [Edit]                   │
│                                                         │
│  Analysis                                               │
│  ────────                                               │
│  Provider:      [Ollama (local) ▼]                      │
│  Model:         [llama3.1:8b ▼]                         │
│  Default tmpl:  [meeting-summary ▼]                     │
│                                                         │
│  General                                                │
│  ───────                                                │
│  [✓] Start minimized to tray                            │
│  [✓] Auto-start on login                                │
│  [ ] Auto-record when audio detected                    │
│  [✓] Show notification when analysis ready              │
│                                                         │
│  Keyboard Shortcuts                                     │
│  ──────────────────                                     │
│  Start/Stop:    Ctrl+Shift+R                            │
│  Open window:   Ctrl+Shift+L                            │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## System Tray

O app vive no tray. O workflow principal é:

1. Usuário clica no tray → "Start Recording" (ou usa hotkey global)
2. Tray ícone muda para vermelho pulsante, mostra timer
3. Usuário clica → "Stop" (ou hotkey)
4. Notificação: "Transcribing..." → "Analysis ready! Click to view"
5. Clique na notificação abre a janela no detalhe da sessão

---

## Estrutura do Monorepo

```text
listening-resume/
├── packages/
│   └── core/                    # Business logic extraída (ports, adapters, services)
│       ├── src/
│       ├── package.json
│       └── tsconfig.json
├── apps/
│   ├── cli/                     # CLI app (usa packages/core)
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   └── cli.ts
│   │   └── package.json
│   └── gui/                     # Tauri app
│       ├── src/                 # React frontend
│       │   ├── App.tsx
│       │   ├── main.tsx
│       │   ├── features/
│       │   │   ├── recording/           # Feature: gravação de áudio
│       │   │   │   ├── RecordingPage.tsx
│       │   │   │   ├── RecordButton.tsx
│       │   │   │   ├── AudioWaveform.tsx
│       │   │   │   ├── DeviceSelector.tsx
│       │   │   │   ├── useRecording.ts
│       │   │   │   └── recording.store.ts
│       │   │   ├── sessions/            # Feature: listagem e detalhes
│       │   │   │   ├── DashboardPage.tsx
│       │   │   │   ├── SessionListPage.tsx
│       │   │   │   ├── SessionDetailPage.tsx
│       │   │   │   ├── SessionCard.tsx
│       │   │   │   ├── useSessions.ts
│       │   │   │   └── sessions.store.ts
│       │   │   ├── transcription/       # Feature: transcrição e playback
│       │   │   │   ├── TranscriptViewer.tsx
│       │   │   │   ├── TranscriptSearch.tsx
│       │   │   │   ├── AudioPlayer.tsx
│       │   │   │   ├── TranscriptEditor.tsx
│       │   │   │   ├── useTranscription.ts
│       │   │   │   └── usePlayback.ts
│       │   │   ├── analysis/            # Feature: análise e resumos
│       │   │   │   ├── AnalysisPanel.tsx
│       │   │   │   ├── AnalysisTabs.tsx
│       │   │   │   ├── TemplateSelector.tsx
│       │   │   │   └── useAnalysis.ts
│       │   │   ├── export/              # Feature: exportação
│       │   │   │   ├── ExportDialog.tsx
│       │   │   │   ├── ObsidianExport.tsx
│       │   │   │   └── useExport.ts
│       │   │   └── settings/            # Feature: configurações
│       │   │       ├── SettingsPage.tsx
│       │   │       ├── AudioSettings.tsx
│       │   │       ├── ProviderSettings.tsx
│       │   │       ├── ShortcutSettings.tsx
│       │   │       └── useSettings.ts
│       │   ├── shared/                  # Componentes e utils compartilhados
│       │   │   ├── ui/                  # Design System
│       │   │   │   ├── Button.tsx
│       │   │   │   ├── IconButton.tsx
│       │   │   │   ├── Modal.tsx
│       │   │   │   ├── Dialog.tsx
│       │   │   │   ├── Dropdown.tsx
│       │   │   │   ├── Tabs.tsx
│       │   │   │   ├── Badge.tsx
│       │   │   │   ├── Tooltip.tsx
│       │   │   │   ├── Input.tsx
│       │   │   │   ├── Toggle.tsx
│       │   │   │   ├── Spinner.tsx
│       │   │   │   ├── ProgressBar.tsx
│       │   │   │   ├── Card.tsx
│       │   │   │   ├── Toast.tsx
│       │   │   │   └── index.ts         # barrel export
│       │   │   ├── hooks/               # Hooks reutilizáveis (useTheme, useNotification)
│       │   │   └── lib/
│       │   │       └── tauri.ts          # wrappers para invoke/events
│       │   └── store/
│       │       └── index.ts             # Root store (combina feature stores)
│       ├── src-tauri/           # Rust backend do Tauri
│       │   ├── src/
│       │   │   ├── main.rs
│       │   │   ├── commands.rs  # Tauri commands
│       │   │   ├── tray.rs      # System tray
│       │   │   └── sidecar.rs   # Manage Node.js sidecar
│       │   ├── Cargo.toml
│       │   ├── tauri.conf.json
│       │   └── capabilities/
│       │       └── default.json
│       ├── index.html
│       ├── package.json
│       ├── vite.config.ts
│       └── tailwind.config.ts
├── pnpm-workspace.yaml
├── package.json
├── PLAN.md
└── GUI_PLAN.md
```

---

## Migração: CLI atual → Monorepo

### Passo 1: Extrair core

Mover a lógica de negócio para `packages/core`:

- `domain/` (models, states, errors)
- `ports/` (interfaces)
- `adapters/` (implementações)
- `application/` (services)
- `config/`, `utils/`, `templates/`

### Passo 2: CLI usa core como dependência

```json
// apps/cli/package.json
{ "dependencies": { "@listening-resume/core": "workspace:*" } }
```

### Passo 3: GUI usa core via sidecar

O CLI é empacotado como binário (via `pkg` ou Node.js SEA) e incluído como sidecar do Tauri. Opcionalmente, para queries de leitura (listagem, busca), o Tauri Rust lê o SQLite diretamente.

---

## Funcionalidades da GUI

### MVP (v1)

- [ ] Tray icon com Start/Stop recording
- [ ] Hotkey global (Ctrl+Shift+R)
- [ ] Dashboard com sessões recentes
- [ ] Gravação com timer e indicador visual
- [ ] Auto-transcribe + analyze ao parar
- [ ] Visualizar transcrição com timestamps
- [ ] Visualizar análise/resumo
- [ ] Busca na transcrição
- [ ] Settings: device, provider, model, API key
- [ ] Notificação nativa ao completar
- [ ] Export .md direto pela interface
- [ ] Dark/light mode
- [ ] Exportação para Obsidian/Notion
- [ ] Drag-and-drop de arquivo de áudio para transcrever
- [ ] Atalhos configuráveis
- [ ] Múltiplas análises na mesma sessão (tabs)
- [ ] Playback de áudio sincronizado com transcrição (click no timestamp → play)
- [ ] Real-time transcription (streaming enquanto grava)
- [ ] Edição manual da transcrição

### v2

- [ ] Waveform visual durante gravação
- [ ] Auto-start on login
- [ ] Detecção automática de áudio (gravar quando detecta som)
- [ ] Indicador de rate limit do Groq
- [ ] Histórico com filtros (data, status, busca full-text)

### v3

- [ ] Tags/categorias para sessões
- [ ] Multi-idioma na interface

---

## Tauri Capabilities (Permissões)

```json
{
  "identifier": "default",
  "description": "Default capability for the app",
  "permissions": [
    "core:default",
    "shell:allow-spawn",
    "shell:allow-execute",
    "notification:default",
    "global-shortcut:allow-register",
    "tray:default",
    "fs:allow-read",
    "fs:allow-write",
    "autostart:default"
  ]
}
```

---

## Tauri Commands (IPC)

```rust
// src-tauri/src/commands.rs

#[tauri::command]
async fn list_devices() -> Result<Vec<AudioDevice>, String> { ... }

#[tauri::command]
async fn start_recording(device: String) -> Result<String, String> { ... } // returns session_id

#[tauri::command]
async fn stop_recording(session_id: String) -> Result<(), String> { ... }

#[tauri::command]
async fn get_sessions(limit: u32) -> Result<Vec<Session>, String> { ... }

#[tauri::command]
async fn get_session(id: String) -> Result<SessionDetail, String> { ... }

#[tauri::command]
async fn transcribe(session_id: String) -> Result<(), String> { ... }

#[tauri::command]
async fn analyze(session_id: String, template: String) -> Result<(), String> { ... }

#[tauri::command]
async fn export_session(session_id: String, format: String) -> Result<String, String> { ... }
```

Events emitidos para o frontend:

- `recording:chunk` — novo chunk salvo
- `transcription:progress` — % da transcrição
- `transcription:complete` — transcrição finalizada
- `analysis:complete` — análise pronta

---

## Design System

### Cores

| Token            | Light     | Dark      | Uso                  |
| ---------------- | --------- | --------- | -------------------- |
| `bg-primary`     | white     | zinc-900  | Background principal |
| `bg-secondary`   | zinc-50   | zinc-800  | Cards, sidebars      |
| `accent`         | blue-500  | blue-400  | CTAs, links          |
| `recording`      | red-500   | red-400   | Estado gravando      |
| `success`        | green-500 | green-400 | Completed            |
| `warning`        | amber-500 | amber-400 | In progress          |
| `text-primary`   | zinc-900  | zinc-100  | Texto principal      |
| `text-secondary` | zinc-500  | zinc-400  | Texto secundário     |

### Tipografia

- Font: Inter (system fallback)
- Monospace: JetBrains Mono (transcrição com timestamps)

### Componentes-chave (por feature)

- **recording/** — `RecordButton` (pulsante), `AudioWaveform`, `DeviceSelector`
- **sessions/** — `SessionCard` (listagem compacta), `DashboardPage` (home)
- **transcription/** — `TranscriptViewer` (lista virtualizada + busca), `AudioPlayer` (sync com timestamps), `TranscriptEditor`
- **analysis/** — `AnalysisPanel` (markdown rendered), `AnalysisTabs` (múltiplas análises)
- **export/** — `ExportDialog`, `ObsidianExport`
- **settings/** — `AudioSettings`, `ProviderSettings`, `ShortcutSettings`
- **shared/ui/** — `Button`, `Modal`, `Dropdown`, `Tabs`, `Badge` (design system)

---

## Fases de Desenvolvimento

### Fase 0 — Setup monorepo + Tauri scaffold (1-2 dias)

- [ ] Reestruturar para monorepo pnpm workspaces
- [ ] Extrair `packages/core` do código atual
- [ ] `apps/cli` consumindo core
- [ ] Scaffold Tauri v2 + React + Vite em `apps/gui`
- [ ] Verificar que CLI continua funcionando

### Fase 1 — GUI básica + tray (3-5 dias)

- [ ] Tray icon com menu (Start/Stop/Quit)
- [ ] Janela principal com Dashboard
- [ ] Integração com sidecar (start/stop recording)
- [ ] Listagem de sessões (lendo SQLite)
- [ ] Indicador de gravação (timer, chunks)

### Fase 2 — Transcrição e Análise na GUI (3-5 dias)

- [ ] Trigger transcription após stop
- [ ] Progress indicator
- [ ] Visualização da transcrição com timestamps
- [ ] Visualização da análise (markdown rendered)
- [ ] Notificação nativa ao completar

### Fase 3 — Polish + Settings (2-3 dias)

- [ ] Tela de Settings completa
- [ ] Hotkey global (Ctrl+Shift+R)
- [ ] Dark/light mode
- [ ] Busca na transcrição
- [ ] Export .md pela interface
- [ ] Responsividade e animações

### Fase 4 — Distribuição (2-3 dias)

- [ ] Bundle do CLI como sidecar (Node.js SEA ou pkg)
- [ ] Build Linux (.deb, .AppImage)
- [ ] Build Windows (.msi) [futuro]
- [ ] Auto-updater do Tauri
- [ ] CI/CD para releases

---

## Dependências da GUI

```json
{
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "@tauri-apps/api": "^2.0.0",
    "@tauri-apps/plugin-shell": "^2.0.0",
    "@tauri-apps/plugin-notification": "^2.0.0",
    "@tauri-apps/plugin-global-shortcut": "^2.0.0",
    "@tauri-apps/plugin-autostart": "^2.0.0",
    "@tanstack/react-router": "^1.0.0",
    "zustand": "^5.0.0",
    "react-markdown": "^9.0.0",
    "tailwindcss": "^4.0.0",
    "lucide-react": "^0.400.0",
    "date-fns": "^4.0.0"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2.0.0",
    "vite": "^6.0.0",
    "@vitejs/plugin-react": "^4.0.0",
    "typescript": "^5.5.0"
  }
}
```

---

## Requisitos do Sistema para Build

- **Rust** (via rustup) — para compilar o shell Tauri
- **Node.js 20+** — frontend build + sidecar
- **Tauri CLI** — `cargo install tauri-cli`
- Linux: `libwebkit2gtk-4.1-dev`, `libappindicator3-dev`, `librsvg2-dev`
- pnpm 9+

---

## Riscos

| Risco                                 | Impacto | Mitigação                                            |
| ------------------------------------- | ------- | ---------------------------------------------------- |
| Sidecar Node.js aumenta tamanho       | Médio   | Node.js SEA (~40MB) ou usar Bun como runtime (~50MB) |
| WebKitGTK inconsistente entre distros | Médio   | Testar em Ubuntu, Fedora, Arch                       |
| Hotkey global pode conflitar          | Baixo   | Permitir customização                                |
| SQLite lock entre sidecar e Rust      | Alto    | WAL mode + reads separados por processo              |
| Tauri v2 ainda evolui rápido          | Baixo   | Fixar versão, acompanhar releases                    |
