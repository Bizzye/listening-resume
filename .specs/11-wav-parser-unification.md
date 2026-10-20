# 11 — Unificar parsing de header WAV num WavParser único no core

> Status: proposta · Esforço: 🟢 · Impacto: corrige risco de duração errada (a causa raiz documentada em CLAUDE.md "Audio / duration"), elimina duplicação, ganha cobertura de testes · Depende de: nada (independe da spec 10; mas se 10 já moveu `getAudioDuration`, ajustar o import)

## Problema

Existem **duas** implementações de parsing de header WAV, com lógicas divergentes:

1. A **robusta** no GUI server (`getAudioDuration`), que percorre as chunks RIFF (`fmt `/`data`/`LIST`/`fact`) e tolera `chunkSize` zerado/inválido confiando no tamanho do arquivo.
2. A **frágil** no core (`RecordingService`), que lê offsets fixos `@22/@24/@34/@40` — exatamente o que a versão robusta diz que **não** funciona quando o ffmpeg insere um `LIST/INFO` entre `fmt ` e `data`.

O comentário em `server.ts:213-216` documenta o bug: lendo `dataSize` no offset fixo 40 pega o tamanho do `LIST` (~26 bytes) e "a duração colapsa para 0:00". O `RecordingService` (usado pelo CLI) ainda usa offsets fixos e está sujeito a esse mesmo erro. Manter duas lógicas significa que um conserto num lado não chega no outro.

## Como está hoje

### Versão robusta — `apps/gui/server.ts:195-248`

`getAudioDuration(sessionId)` lista os `.wav` do diretório da sessão, lê 4096 bytes de cada header, e **caminha pelas chunks**:

```ts
let pos = 12; // skip RIFF / size / WAVE
while (pos + 8 <= read) {
  const chunkId = header.toString("ascii", pos, pos + 4);
  const chunkSize = header.readUInt32LE(pos + 4);
  if (chunkId === "fmt ") {
    channels = header.readUInt16LE(pos + 10);
    sampleRate = header.readUInt32LE(pos + 12);
    bitsPerSample = header.readUInt16LE(pos + 22);
  } else if (chunkId === "data") {
    const dataOffset = pos + 8;
    const remaining = Math.max(0, stat.size - dataOffset);
    dataBytes = chunkSize === 0 || chunkSize > remaining ? remaining : chunkSize;
    break;
  }
  pos += 8 + chunkSize + (chunkSize & 1); // word-aligned
}
const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);
if (bytesPerSecond > 0 && dataBytes > 0) totalSeconds += dataBytes / bytesPerSecond;
```

Fallback se o header for ilegível: `(stat.size - 44) / 32000` (`server.ts:242-245`). Retorna **segundos arredondados** somados de todos os chunks.

### Versão frágil — `packages/core/src/application/recording.service.ts:50-76`

Dentro do callback `onChunkReady`, por chunk:

```ts
const header = Buffer.alloc(44);
const fd = openSync(info.path, "r");
readSync(fd, header, 0, 44, 0);
closeSync(fd);
// WAV header offsets: channels@22, sampleRate@24, bitsPerSample@34, dataSize@40
const sr = header.readUInt32LE(24);
const ch = header.readUInt16LE(22);
const bps = header.readUInt16LE(34);
const dataBytes = header.readUInt32LE(40);
if (sr > 0 && ch > 0 && bps > 0) {
  actualSampleRate = sr;
  durationMs = Math.round((dataBytes / (sr * ch * (bps / 8))) * 1000);
} else { throw new Error("invalid WAV header"); }
```

Fallback: `(fileSize - 44) / (config.sampleRate * config.channels * 2)` (`recording.service.ts:71-76`). Produz **duração em ms por chunk** e o `sampleRate` real, gravados em `AudioChunk` (`recording.service.ts:78-86`).

Diferenças relevantes: o core lê só 44 bytes (não cabe `fmt ` + `LIST` + `data`), usa offsets fixos, e expõe `sampleRate` além da duração. O server soma segundos de vários arquivos e não precisa do sampleRate.

## O que precisa ser feito

1. Criar um `WavParser` único em `packages/core/src/utils/wav.ts` com a lógica robusta (RIFF walk).
2. Expor uma API que sirva aos dois consumidores:
   - O core precisa, por arquivo: `{ sampleRate, channels, bitsPerSample, durationMs }`.
   - O server precisa: somar a duração (segundos) de uma lista de arquivos.
3. Migrar `RecordingService` e `getAudioDuration` para consumir o parser.
4. Exportar do barrel do core (`packages/core/src/index.ts`) para o GUI usar via `@listening-resume/core`.

## Como implementar

### Novo arquivo `packages/core/src/utils/wav.ts`

```ts
import { closeSync, openSync, readSync, statSync } from "node:fs";

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataBytes: number;
  durationMs: number;
}

const DEFAULT_HEADER_BYTES = 4096; // cobre fmt + LIST/INFO + fact antes do data

/** Lê o header de um WAV percorrendo as chunks RIFF (tolerante a LIST/INFO/fact
 *  inseridos pelo ffmpeg e a dataSize zerada/inválida em WAVs de streaming). */
export function readWavInfo(filePath: string): WavInfo | null {
  let header: Buffer;
  let fileSize: number;
  try {
    fileSize = statSync(filePath).size;
    const fd = openSync(filePath, "r");
    header = Buffer.alloc(DEFAULT_HEADER_BYTES);
    const read = readSync(fd, header, 0, DEFAULT_HEADER_BYTES, 0);
    closeSync(fd);
    header = header.subarray(0, read);
  } catch {
    return null;
  }
  if (header.length < 12 || header.toString("ascii", 0, 4) !== "RIFF") return null;

  let channels = 0, sampleRate = 0, bitsPerSample = 0, dataBytes = 0;
  let pos = 12;
  while (pos + 8 <= header.length) {
    const chunkId = header.toString("ascii", pos, pos + 4);
    const chunkSize = header.readUInt32LE(pos + 4);
    if (chunkId === "fmt ") {
      channels = header.readUInt16LE(pos + 10);
      sampleRate = header.readUInt32LE(pos + 12);
      bitsPerSample = header.readUInt16LE(pos + 22);
    } else if (chunkId === "data") {
      const dataOffset = pos + 8;
      const remaining = Math.max(0, fileSize - dataOffset);
      dataBytes = chunkSize === 0 || chunkSize > remaining ? remaining : chunkSize;
      break;
    }
    pos += 8 + chunkSize + (chunkSize & 1);
  }
  const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);
  if (bytesPerSecond <= 0 || dataBytes <= 0) return null;
  return {
    sampleRate, channels, bitsPerSample, dataBytes,
    durationMs: Math.round((dataBytes / bytesPerSecond) * 1000),
  };
}
```

### `RecordingService` passa a usar `readWavInfo` (`recording.service.ts:50-89`)

```ts
this.capture.onChunkReady((info) => {
  const wav = readWavInfo(info.path);
  let durationMs: number;
  let actualSampleRate = config.sampleRate;
  if (wav) {
    actualSampleRate = wav.sampleRate;
    durationMs = wav.durationMs;
  } else {
    // fallback preservado (recording.service.ts:71-76)
    const fileSize = statSync(info.path).size;
    durationMs = Math.round(((fileSize - 44) / (config.sampleRate * config.channels * 2)) * 1000);
  }
  const chunk: AudioChunk = { /* ...igual... */ durationMs, sampleRate: actualSampleRate };
  this.repo.addChunk(chunk);
});
```

Os imports `openSync/readSync/closeSync` no topo (`recording.service.ts:1`) deixam de ser necessários (só sobra `statSync` para o fallback).

### `getAudioDuration` passa a usar `readWavInfo` (`server.ts:195-248`)

Vira um somatório fino:

```ts
import { readWavInfo } from "@listening-resume/core";

function getAudioDuration(sessionId: string): number {
  const audioDir = path.join(dataDir, "sessions", sessionId, "audio");
  if (!fs.existsSync(audioDir)) return 0;
  const wavFiles = fs.readdirSync(audioDir).filter((f) => f.endsWith(".wav")).sort();
  let totalSeconds = 0;
  for (const f of wavFiles) {
    const filePath = path.join(audioDir, f);
    const wav = readWavInfo(filePath);
    if (wav) totalSeconds += wav.durationMs / 1000;
    else totalSeconds += Math.max(0, fs.statSync(filePath).size - 44) / 32000; // fallback server.ts:242-245
  }
  return Math.round(totalSeconds);
}
```

Se a spec 10 já tiver movido `getAudioDuration` para `apps/gui/server/lib/audio-duration.ts`, a troca acontece nesse arquivo.

### Barrel export (`packages/core/src/index.ts`)

Adicionar junto aos demais Utils (perto da linha que exporta `logger`):

```ts
export { readWavInfo, type WavInfo } from "./utils/wav.js";
```

### Ordem de migração segura

1. Criar `utils/wav.ts` + testes unitários (não toca nada existente). `pnpm test:unit`.
2. Exportar no barrel; `pnpm --filter @listening-resume/core build`.
3. Migrar `RecordingService`; rodar testes de integração do core (gravação) se existirem; senão, smoke do CLI (`pnpm listen` curto).
4. Migrar `getAudioDuration` no GUI; `pnpm --filter gui smoke:server` (que faz `GET /api/devices`; complementar com `GET /api/sessions` numa sessão real). Conferir que a duração de uma sessão de teste bate (skill `audio-diag` lê o header real e dá o valor esperado).

## Plano de testes

Testes unitários novos em `packages/core/tests/unit/wav.test.ts`, com WAVs sintéticos em buffer gravados em `tmpdir`:

- **WAV canônico** (44 bytes, `data` no offset 36): duração correta.
- **WAV com `LIST/INFO` entre `fmt ` e `data`** (o caso do ffmpeg): NÃO colapsa para 0 — este é o regression test que prova a unificação. (A versão antiga do core falharia aqui.)
- **`dataSize` zerado** (streaming): cai no `remaining` = tamanho do arquivo.
- **`dataSize` maior que o arquivo** (stale): usa `remaining`.
- **Header não-RIFF / arquivo truncado**: retorna `null` (consumidores caem no fallback).
- **48000 Hz estéreo 16-bit**: confere que `sampleRate`/`channels` lidos são os do header, não os do config (regra de ouro do CLAUDE.md).

Verificação cruzada com a skill `audio-diag` num WAV real de sessão: a duração reportada pelo `/api/sessions/:id` deve bater com a do header.

## Riscos / decisões em aberto

- **Dependência core → fs**: o core já importa `node:fs` em `recording.service.ts:1` e `local-files.ts`, então `utils/wav.ts` usar `node:fs` síncrono não introduz acoplamento novo. Opcional (não recomendado para esta spec): variante `readWavInfoFromBuffer(buf, fileSize)` pura, mantendo o I/O fora, para testar sem tocar disco — deixa o core mais hexagonal. Pode ficar para depois.
- **Tamanho do header lido**: o server lê 4096 bytes; manter esse valor cobre os casos reais. Se algum WAV tiver chunks gigantes antes do `data`, o `data` pode cair fora dos 4096 — improvável com ffmpeg, mas o fallback cobre.
- **Arredondamento**: o server soma `durationMs/1000` e arredonda no fim (mantido); o core arredonda por chunk em ms (mantido). Pequena divergência de arredondamento entre os dois caminhos é aceitável e já existe hoje.
- **Bundle**: `utils/wav.ts` é TS puro do core, sem nativos — o esbuild do `build-server.mjs` inlina sem problema (não é `--external`).
