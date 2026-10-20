# 02 — Importar arquivo de áudio/vídeo

> Status: proposta · Esforço: 🟢 · Impacto: alto · Depende de: nada

## Problema

Hoje o app só consegue produzir transcrição/resumo a partir de uma **gravação ao vivo** do áudio do sistema. Quem já tem um arquivo (uma aula baixada em `.mp4`, um `.mp3` de podcast, um `.m4a` de reunião do Zoom/Teams, um `.wav`) **não tem como processar** sem re-tocar o conteúdo no alto-falante e gravar em tempo real — algo absurdo (1h de aula = 1h esperando).

O pipeline `transcribe → analyze` já existe e funciona; o que falta é uma **ENTRADA por arquivo**. Esse é o item de maior ROI não-óbvio: reaproveita ~95% do código existente e multiplica os casos de uso (transcrever qualquer mídia já existente), sem mexer no subsistema de captura nativa (WASAPI/PulseAudio), que é a parte frágil.

## Como está hoje

A única forma de criar uma sessão com áudio é gravando. O fluxo:

1. **GUI start** — `POST /api/recording/start` em `apps/gui/server.ts:413-441` chama `recordingService.startRecording(...)`.
2. **`RecordingService.startRecording`** (`packages/core/src/application/recording.service.ts:17-104`):
   - cria a sessão em `created` e transiciona para `recording` (`recording.service.ts:41-43`);
   - cria o diretório `{sessionDir}/audio` via `storage.ensureDir` (`recording.service.ts:45-47`); `getSessionDir` resolve para `{dataDir}/sessions/{id}` (`packages/core/src/adapters/persistence/local-files.ts:16-18`);
   - registra `capture.onChunkReady(...)` que, a cada chunk WAV emitido, **lê o header WAV real** para calcular `durationMs`/`sampleRate` e chama `repo.addChunk({ id, sessionId, index, path, durationMs, sampleRate, status: "recorded" })` (`recording.service.ts:49-89`).
3. **GUI stop** — `POST /api/recording/stop` (`server.ts:443-463`) chama `recordingService.stopRecording`, que transiciona a sessão para `stopped` (`recording.service.ts:106-117`).
4. **Transcribe** — `POST /api/sessions/:id/transcribe` (`server.ts:528-578`) instancia `GroqWhisperAdapter` + `TranscriptionService` e chama `transcribeSession`.
5. **`TranscriptionService.transcribeSession`** (`packages/core/src/application/transcription.service.ts:19-71`) **itera os chunks** de `repo.getChunks(sessionId)` (`transcription.service.ts:26-54`), transcreve cada `chunk.path`, acumula offset por `chunk.durationMs`, e salva o `Transcript`.
6. **Analyze** — `POST /api/sessions/:id/analyze` (`server.ts:580-639`) lê o transcript existente e roda `AnalysisService`.

Observações-chave que tornam o import barato:

- A transcrição **não conhece a origem dos chunks** — só lê linhas da tabela `audio_chunks` (`packages/core/src/adapters/persistence/schema.ts:14-22`) e os arquivos WAV em disco. Se conseguirmos popular `audio_chunks` + arquivos WAV no layout `{dataDir}/sessions/{id}/audio/`, todo o resto funciona sem alteração.
- A máquina de estados (`packages/core/src/domain/states.ts:3-12`) permite `stopped → transcribing → transcribed → analyzing → completed`. Basta criar a sessão importada **direto em `stopped`**.
- O `ffmpeg` já é uma dependência presente e usado no server (ex.: concat de chunks em `server.ts:697-699`); no Windows o PATH é ajustado para o `ffmpeg.exe` empacotado (`server.ts:22-36`).
- O cálculo de duração por header WAV via varredura de chunks RIFF já existe em `getAudioDuration` (`server.ts:195-248`) — reutilizável para validar/derivar duração após transcodar.

O que **não existe** hoje:

- Nenhum endpoint que aceite upload/caminho de arquivo (busca por `multipart`/`formidable`/`busboy` no server: nenhum match).
- Nenhum comando `import` no CLI (`apps/cli/src/cli.ts` só tem `devices`, `record`, `list`, etc.).
- O Tauri **não tem** o plugin de diálogo de arquivos instalado: `apps/gui/src-tauri/capabilities/default.json` só concede `core:default`, `shell:allow-spawn`, `shell:allow-execute`; o `Cargo.toml` só tem `tauri-plugin-log` e `tauri-plugin-shell` (`apps/gui/src-tauri/Cargo.toml:30-31`). Para o file picker nativo será preciso adicionar `tauri-plugin-dialog`.

## O que precisa ser feito

1. **Core**: uma rotina que, dado um arquivo de mídia, transcoda+segmenta em chunks WAV (16 kHz mono, mesmo formato que o Whisper consome) no layout `{dataDir}/sessions/{id}/audio/`, cria a sessão em `stopped` e popula `audio_chunks`. Encapsular num novo `ImportService` (mantém a arquitetura hexagonal).
2. **GUI server**: endpoint `POST /api/sessions/import` que recebe o arquivo (upload binário **ou** caminho local, no caso do Tauri) e chama o `ImportService`; depois o usuário aciona transcribe/analyze normais (ou um modo "auto" que encadeia).
3. **Frontend**: botão "Importar arquivo" + drag-and-drop no Dashboard, com file picker do Tauri (nativo) e fallback `<input type="file">` no browser dev.
4. **CLI**: comando `listen import <arquivo>` que roda import → transcribe → analyze, espelhando `record`.
5. **Tauri**: adicionar `tauri-plugin-dialog` + permissão na capability para abrir o seletor nativo de arquivos.

## Como implementar

### 1. Core — `ImportService` + utilitário de segmentação

Criar `packages/core/src/application/import.service.ts`. Reutiliza as **mesmas portas** que `RecordingService` (`SessionRepository`, `FileStoragePort`) e roda o `ffmpeg` para transcodar.

Segmentar em chunks de N segundos espelha o que a gravação faz (chunks de `config.audio.chunkSeconds`, default 120s) — mantém os mesmos limites de tamanho que o Whisper/rate-limiter já toleram (`transcription.service.ts:36-37` usa `chunk.durationMs`). Usar o `segment` muxer do ffmpeg, que corta sem re-encode caro e nomeia sequencialmente.

Esboço:

```ts
// packages/core/src/application/import.service.ts
import { closeSync, openSync, readSync, statSync, readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { v4 as uuid } from "uuid";
import type { AudioChunk, Session } from "../domain/models.js";
import { assertTransition } from "../domain/states.js";
import type { SessionRepository } from "../ports/repository.js";
import type { FileStoragePort } from "../ports/file-storage.js";
import { logger } from "../utils/logger.js";

const execFileAsync = promisify(execFile);

export interface ImportOptions {
	chunkSeconds: number;     // ex.: config.audio.chunkSeconds (120)
	sampleRate: number;       // 16000 — formato que o Whisper consome
	channels: number;         // 1 (mono)
	title?: string | null;
	language?: string;        // default "auto"
}

export class ImportService {
	constructor(
		private repo: SessionRepository,
		private storage: FileStoragePort,
	) {}

	async importFile(sourcePath: string, opts: ImportOptions): Promise<Session> {
		if (!statSync(sourcePath).isFile()) {
			throw new Error(`Import source not found: ${sourcePath}`);
		}

		const sessionId = uuid();
		const now = new Date().toISOString();
		const session: Session = {
			id: sessionId,
			title: opts.title ?? deriveTitle(sourcePath),
			status: "created",
			startedAt: now,
			endedAt: now,
			audioSource: `file:${sourcePath}`, // marca a origem; campo já existe
			language: opts.language ?? "auto",
			createdAt: now,
		};
		this.repo.createSession(session); // sqlite.ts:121

		const audioDir = `${this.storage.getSessionDir(sessionId)}/audio`;
		await this.storage.ensureDir(audioDir);

		// ffmpeg: decodifica QUALQUER container (mp3/mp4/wav/m4a/...) → PCM 16k mono,
		// e corta em segmentos WAV de N s nomeados chunk_0000.wav, chunk_0001.wav...
		// O segment muxer numera com %04d, casando com LocalFileStorage.getChunkPath
		// (local-files.ts:20-26 usa chunk_${index padStart 4}.wav).
		await execFileAsync("ffmpeg", [
			"-y",
			"-i", sourcePath,
			"-vn",                       // ignora trilha de vídeo do mp4
			"-ac", String(opts.channels),
			"-ar", String(opts.sampleRate),
			"-c:a", "pcm_s16le",
			"-f", "segment",
			"-segment_time", String(opts.chunkSeconds),
			"-reset_timestamps", "1",
			`${audioDir}/chunk_%04d.wav`,
		]);

		// Popula audio_chunks lendo o header WAV real de cada segmento —
		// mesma lógica de RecordingService.onChunkReady (recording.service.ts:53-87).
		const files = readdirSync(audioDir).filter((f) => f.endsWith(".wav")).sort();
		if (files.length === 0) throw new Error("ffmpeg produced no audio chunks");

		files.forEach((f, index) => {
			const filePath = `${audioDir}/${f}`;
			const { durationMs, sampleRate } = readWavMeta(filePath, opts);
			const chunk: AudioChunk = {
				id: uuid(),
				sessionId,
				index,
				path: filePath,
				durationMs,
				sampleRate,
				status: "recorded", // mesmo status inicial dos chunks gravados
			};
			this.repo.addChunk(chunk); // sqlite.ts:178
		});

		// Vai direto para "stopped" — pronto para transcrever.
		// created → recording → stopped não é permitido pular direto;
		// a transição válida a partir de "created" é só "recording"
		// (states.ts:4). Portanto: created → recording → stopped.
		assertTransition("created", "recording");
		this.repo.updateSession(sessionId, { status: "recording" });
		assertTransition("recording", "stopped");
		this.repo.updateSession(sessionId, { status: "stopped", endedAt: now });

		logger.info(`Imported ${files.length} chunks from ${sourcePath} → session ${sessionId}`);
		return this.repo.getSession(sessionId)!;
	}
}
```

> **Decisão sobre estados**: `domain/states.ts:3-4` só permite `created → recording`. Duas opções:
> (a) fazer a dupla transição `created → recording → stopped` (como no esboço, zero mudança de domínio); ou
> (b) adicionar `"stopped"` à lista de `created` em `states.ts:4` (`created: ["recording", "stopped"]`) e ir direto. A opção (a) é a mais conservadora e não altera o domínio — **preferir (a)**.

`readWavMeta` reaproveita a varredura de chunks RIFF de `server.ts:216-240` (não só os offsets fixos de `recording.service.ts:56-67`, porque o ffmpeg insere um chunk `LIST`/`INFO` entre `fmt ` e `data` — exatamente o bug documentado em `server.ts:212-215`). Extrair essa varredura para um util compartilhado em `packages/core/src/utils/wav.ts` e usá-la nos três lugares (recording, getAudioDuration, import) é um bônus de qualidade, opcional para esta entrega.

Exportar o serviço no barrel do core (mesmo arquivo que já exporta `RecordingService`/`TranscriptionService`) para que `server.ts:5-19` e `cli.ts:3-21` consigam importar `ImportService`.

### 2. GUI server — `POST /api/sessions/import`

Adicionar no `switch` de rotas de `apps/gui/server.ts` (perto de `recording/start`, ~`server.ts:413`). Instanciar uma vez ao lado de `recordingService` (`server.ts` após linha 76):

```ts
import { ImportService } from "@listening-resume/core"; // adicionar ao import existente (server.ts:5-19)
const importService = new ImportService(repo, storage);
```

Suportar **dois modos de entrada** (o app é Tauri desktop, mas dev roda no browser):

- **Modo caminho (Tauri)**: o front manda `{ "path": "/abs/caminho.mp4", "autorun": true }` em JSON. O server lê o arquivo direto do disco — não trafega bytes pelo HTTP. É o caminho feliz no desktop.
- **Modo upload (browser/dev)**: `Content-Type: application/octet-stream` (ou multipart) com o binário; o server salva num temp (`os.tmpdir()`) e passa o caminho ao `ImportService`.

```ts
// POST /api/sessions/import — importa arquivo de mídia existente
if (route === "/api/sessions/import" && req.method === "POST") {
	const ct = req.headers["content-type"] ?? "";
	let sourcePath: string;
	let title: string | null = null;
	let autorun = false;
	let cleanupTemp: string | null = null;

	if (ct.includes("application/json")) {
		// Modo caminho (Tauri desktop)
		const body = await readBody(req); // server.ts:183-189
		const parsed = body ? JSON.parse(body) : {};
		if (!parsed.path) return json(res, { error: "path required" }, 400);
		sourcePath = parsed.path;
		title = parsed.title ?? null;
		autorun = parsed.autorun === true;
		if (!fs.existsSync(sourcePath)) return json(res, { error: "File not found" }, 404);
	} else {
		// Modo upload (browser/dev): stream binário → temp
		const tmp = path.join(os.tmpdir(), `import_${Date.now()}`);
		await new Promise<void>((resolve, reject) => {
			const w = fs.createWriteStream(tmp);
			req.pipe(w);
			w.on("finish", () => resolve());
			w.on("error", reject);
		});
		sourcePath = tmp;
		cleanupTemp = tmp;
		title = (req.headers["x-file-name"] as string) ?? null;
	}

	// Validar extensão/whitelist (defesa contra paths arbitrários no modo caminho)
	const ext = path.extname(sourcePath).toLowerCase();
	const allowed = [".mp3", ".mp4", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".webm", ".mov", ".mkv"];
	// no modo upload a extensão pode não estar no temp — usar x-file-name p/ checar

	try {
		const session = await importService.importFile(sourcePath, {
			chunkSeconds: config.audio.chunkSeconds,
			sampleRate: 16000,
			channels: 1,
			title,
		});

		// autorun opcional: encadeia transcribe + analyze reusando o
		// MESMO código dos endpoints existentes (server.ts:546-570 e 607-636).
		// Para não duplicar, extrair helpers transcribeSessionById/analyzeSessionById
		// e chamá-los aqui e nos endpoints atuais.
		if (autorun && groqApiKey) {
			await runTranscribe(session.id);          // = corpo de server.ts:546-570
			await runAnalyze(session.id, config.analysis.defaultTemplate); // = corpo de server.ts:607-636
		}

		return json(res, { session });
	} catch (err) {
		logger.error(`Import failed: ${err}`);
		return json(res, { error: `Import failed: ${(err as Error).message}` }, 500);
	} finally {
		if (cleanupTemp) { try { fs.unlinkSync(cleanupTemp); } catch {} }
	}
}
```

> **Refactor recomendado**: hoje os corpos de transcribe (`server.ts:546-570`) e analyze (`server.ts:607-636`) estão inline nos endpoints. Para o `autorun` reusá-los sem copiar, extrair `runTranscribe(id)` e `runAnalyze(id, templateId)` e chamar tanto nos endpoints atuais quanto no import. Sem isso, o autorun teria que duplicar a lógica de rollback de estado.

Adicionar o método no client `apps/gui/src/shared/lib/api.ts` (dentro do objeto `api`, `api.ts:65`):

```ts
async importFile(path: string, opts?: { title?: string; autorun?: boolean }): Promise<{ session: SessionData }> {
	return request("/sessions/import", {
		method: "POST",
		body: JSON.stringify({ path, title: opts?.title, autorun: opts?.autorun ?? true }),
	});
},
async importUpload(file: File, opts?: { autorun?: boolean }): Promise<{ session: SessionData }> {
	const res = await fetch(`${BASE}/sessions/import`, {
		method: "POST",
		headers: { "Content-Type": "application/octet-stream", "X-File-Name": file.name },
		body: file,
	});
	if (!res.ok) throw new Error((await res.json()).error ?? "Import failed");
	return res.json();
},
```

(O `BASE` resolve `/api` em dev e `http://localhost:3456/api` no app empacotado — `api.ts:1-4`.)

### 3. Tauri — plugin de diálogo nativo

- `apps/gui/src-tauri/Cargo.toml`: adicionar `tauri-plugin-dialog = "2"` (ao lado de `tauri-plugin-shell` em `Cargo.toml:30-31`).
- `apps/gui/src-tauri/src/lib.rs`: registrar `.plugin(tauri_plugin_dialog::init())`.
- `apps/gui/src-tauri/capabilities/default.json`: adicionar `"dialog:allow-open"` ao array `permissions` (`default.json` linha de `permissions`).
- `apps/gui/package.json`: adicionar dependência `@tauri-apps/plugin-dialog` (`@tauri-apps/api` já está em `package.json:33`).

No front, abrir o picker nativo (retorna **caminho absoluto** — ideal para o modo caminho do endpoint):

```ts
import { open } from "@tauri-apps/plugin-dialog";

async function pickAndImport() {
	const selected = await open({
		multiple: false,
		filters: [{ name: "Áudio/Vídeo", extensions: ["mp3","mp4","wav","m4a","aac","ogg","flac","webm","mov","mkv"] }],
	});
	if (typeof selected === "string") {
		await api.importFile(selected, { autorun: true });
	}
}
```

### 4. Frontend — botão + drag-and-drop no Dashboard

O Dashboard já tem o botão "New Recording" (`apps/gui/src/features/dashboard/DashboardPage.tsx:27-34`, `onClick={startRecording}` vindo do store `apps/gui/src/store/index.ts`). Adicionar ao lado um botão "Importar arquivo" e uma zona de drop:

- **Botão**: chama `pickAndImport()` (Tauri) ou, em dev/browser, dispara um `<input type="file" accept="audio/*,video/*">` oculto e usa `api.importUpload(file)`.
- **Drag-and-drop**: handlers `onDragOver`/`onDrop` na área principal do Dashboard. No Tauri, o evento de file-drop entrega caminhos absolutos (via `getCurrentWebview().onDragDropEvent`); no browser, `e.dataTransfer.files[0]` → `importUpload`.
- Adicionar no store (`apps/gui/src/store/index.ts`) uma ação `importFile(pathOrFile)` que: chama a API, dá refresh em `sessions` (mesmo refresh usado após `stopRecording`), e seleciona a sessão criada (`selectSession`, já usado em `DashboardPage.tsx:70`).
- UX: mostrar estado "Importando… / Transcrevendo…" reaproveitando os badges de status já existentes (a sessão entra em `stopped` e, com `autorun`, passa por `transcribing → completed` — os badges em `Badge.tsx` já cobrem esses status).
- Acessibilidade/testabilidade: dar `data-testid="import-file-button"` e `data-testid="import-dropzone"` (o projeto usa testids para Playwright — ver CLAUDE.md).

### 5. CLI — `listen import <arquivo>`

Adicionar em `apps/cli/src/cli.ts` (espelhando o comando `record` em `cli.ts:50-140`):

```ts
program
	.command("import")
	.description("Importar arquivo de áudio/vídeo e processá-lo (transcrever + resumir)")
	.argument("<file>", "Caminho do arquivo (mp3/mp4/wav/m4a/...)")
	.option("-t, --template <template>", "Analysis template", "meeting-summary")
	.option("--no-analyze", "Pular análise")
	.action(async (file, opts) => {
		const config = loadConfig();
		const dataDir = resolveDataDir(config);
		fs.mkdirSync(dataDir, { recursive: true });
		const repo = new SQLiteRepository(path.join(dataDir, "listening-resume.db"));
		const storage = new LocalFileStorage(dataDir);
		const importService = new ImportService(repo, storage); // novo import no topo

		const spinner = ora(`Importando ${file}...`).start();
		const session = await importService.importFile(path.resolve(file), {
			chunkSeconds: config.audio.chunkSeconds,
			sampleRate: 16000,
			channels: 1,
		});
		spinner.succeed(`Importado (${repo.getChunks(session.id).length} chunks)`);

		// A partir daqui é IDÊNTICO ao record (cli.ts:88-135):
		const groqKey = process.env.GROQ_API_KEY;
		if (!groqKey) { /* avisa e sai (cli.ts:89-92) */ return; }
		const transcriptionService = new TranscriptionService(
			new GroqWhisperAdapter(groqKey, config.transcription.model), repo,
			{ requestsPerMinute: config.rateLimits.groqRpm, audioSecondsPerHour: config.rateLimits.groqAudioSecondsPerHour },
		);
		await transcriptionService.transcribeSession(session.id, config.transcription.language, config.transcription.prompt || undefined);
		// ... analyze idêntico a cli.ts:109-135
	});
```

Adicionar `ImportService` ao import de `@listening-resume/core` no topo do CLI (`cli.ts:3-21`).

## Plano de testes

**Core (vitest, `packages/core`)**
- Teste unit/integração de `ImportService.importFile` com um WAV de fixture curto: verifica que (a) a sessão fica em `stopped`, (b) `repo.getChunks` retorna ≥1 chunk com `durationMs` plausível e `status: "recorded"`, (c) os arquivos existem em `{sessionDir}/audio/chunk_0000.wav`. Mockar `execFile`/ffmpeg ou usar ffmpeg real no integration suite.
- Teste de segmentação: arquivo > `chunkSeconds` gera múltiplos chunks com índices contíguos `0..N-1`.
- Teste de duração via header: confirmar que a varredura RIFF não cai no bug do chunk `LIST` (regressão de `server.ts:212-215`) — duração ≠ 0.
- Teste de transição: garantir que `created → recording → stopped` é aplicado (e que pular para `stopped` direto, sem a mudança em `states.ts`, lançaria — documenta a decisão).

**E2E pipeline**
- Reutilizar a skill `pipeline-test` contra o server na 3456: importar um `.mp3` real via `POST /api/sessions/import` (modo caminho), depois `transcribe` + `analyze`, e validar o WAV resultante com a skill `audio-diag` (formato 16k mono, sem clipping).
- Caso de vídeo: importar um `.mp4` e confirmar que `-vn` descartou o vídeo e a transcrição saiu.

**CLI (e2e, `apps/cli`)**
- `listen import fixture.wav --no-analyze` cria sessão `stopped`/`transcribed` e imprime contagem de chunks; depois `listen list` mostra a sessão.

**GUI (Playwright MCP em `http://localhost:1420`)**
- Clicar `import-file-button` → (mockar diálogo) → sessão aparece na lista e progride de `stopped` a `completed` com `autorun`.
- Drag-and-drop de um arquivo na `import-dropzone`.

**Erros**
- Arquivo inexistente → 404. Extensão não suportada → 400. ffmpeg falha (arquivo corrompido) → 500 com mensagem e sessão não deixada presa em estado transiente (rollback / delete da sessão criada).

## Riscos / decisões em aberto

- **ffmpeg ausente**: o import depende 100% do ffmpeg no PATH. No app empacotado isso já é resolvido (`server.ts:22-36` + `download-deps-win.ps1`), mas no CLI rodando em máquina sem ffmpeg falhará. Detectar cedo e dar erro claro ("ffmpeg não encontrado").
- **Limpeza em falha**: se o ffmpeg falhar no meio, a sessão já foi criada em `created`/`recording`. Decidir: deletar a sessão (`repo.deleteSession`, existe em `sqlite.ts:292`) ou marcá-la `failed` (`recording → failed` é válido, `states.ts:5`). Recomendo **deletar** para não poluir a lista com sessões vazias.
- **Upload de arquivos grandes pelo HTTP** (modo browser/dev): uma aula de 1h em `.mp4` pode ter centenas de MB; o `readBody` atual (`server.ts:183-189`) acumula em string e não serve para binário — por isso o modo upload usa `req.pipe(writeStream)`. No desktop (caso real) usa-se o **modo caminho**, que não trafega bytes. Aceitável.
- **Sample rate de import vs. gravação**: import fixa 16 kHz mono (ótimo p/ Whisper e menor footprint), enquanto gravações guardam o formato nativo do device (ex.: 48 kHz estéreo — CLAUDE.md "Audio / duration"). Isso significa que o áudio importado tocado de volta (`GET /api/sessions/:id/audio`, `server.ts:648`) terá qualidade reduzida. Se reproduzir o original importado for requisito, guardar uma cópia do arquivo original — fora do escopo desta entrega.
- **Whitelist de extensões no modo caminho** é segurança importante: como o caminho vem do cliente, validar extensão evita passar caminhos arbitrários ao ffmpeg. O `-vn` já protege contra processar trilhas de vídeo.
- **`audioSource` = `file:...`**: estou reusando o campo existente (`models.ts:19`, schema `audio_source` em `schema.ts:8`) para distinguir sessões importadas. UI pode usar isso para um badge "Importado". Sem migração de schema.
- **Refactor de transcribe/analyze inline → helpers**: necessário só se quisermos `autorun`. Se preferir manter o endpoint de import "burro" (só cria a sessão `stopped`) e deixar o usuário clicar transcribe/analyze, o autorun e o refactor caem — esforço fica ainda menor. Decisão de produto.
