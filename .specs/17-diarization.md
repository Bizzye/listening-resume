# 17 — Diarização (rotular quem falou)
> Status: proposta · Esforço: 🔴 · Impacto: Alto para reuniões/entrevistas (transcrição vira "ata" legível); baixo para podcasts mono-locutor · Depende de: nada obrigatório; combina muito bem com spec 18 (live) e 20 (idioma)

## Problema
A transcrição é um fluxo único de texto sem identificar locutores. Numa reunião com 4 pessoas, o resumo (`meeting-summary` pede explicitamente "Quem são os participantes... infira pelos nomes/vozes", `packages/core/src/templates/meeting-summary.ts:10-11`) tem que adivinhar quem falou o quê. Falta diarização: segmentar o áudio por locutor e rotular ("Falante 1:", "Falante 2:").

## Como está hoje
- Whisper (Groq e whisper.cpp) **não faz diarização nativa**. O adapter Groq pede `verbose_json` com `timestamp_granularities: ["segment"]` (`packages/core/src/adapters/transcription/groq-whisper.ts:23-35`) e mapeia para `{ start, end, text }` — sem `speaker` (`groq-whisper.ts:37-41`).
- O modelo de segmento é puramente temporal: `TranscriptSegment { start; end; text }` (`packages/core/src/domain/models.ts:34-38`). Nenhum campo de locutor.
- O contrato do transcriber devolve `{ segments, fullText, language, duration }` (`packages/core/src/ports/transcriber.ts:9-14`), também sem locutor.
- Persistência: segmentos serializados como JSON em `transcripts.segments_json` (`packages/core/src/adapters/persistence/schema.ts:24-33`; serialização em `sqlite.ts:223`, desserialização em `sqlite.ts:243`). Schema flexível — adicionar campo no objeto não exige migração de coluna.
- Pipeline de transcrição itera chunks e concatena segmentos com offset acumulado (`packages/core/src/application/transcription.service.ts:30-54`). É **aqui** que a diarização precisaria entrar (ou logo após).
- `fullText` é só os textos concatenados (`transcription.service.ts:56`), e o preview/UI também (`apps/gui/server.ts:332-364`, render em `SessionDetailPage.tsx:484-502`).

## O que precisa ser feito
1. Produzir, para cada trecho de fala, um rótulo de locutor estável ao longo da sessão.
2. Casar os turnos de locutor (do diarizador) com os segmentos de texto do Whisper (do transcriber) por sobreposição temporal.
3. Estender modelo/persistência/UI/export para carregar e exibir o locutor.

## Opções (trade-offs)

### Opção A — pyannote.audio via sidecar Python (recomendada para qualidade)
Modelo local de diarização state-of-the-art. Roda como processo Python separado, igual ao `wasapi-capture` é um sidecar Rust hoje (padrão de sidecar já existe — ver `CLAUDE.md` "Windows audio capture uses a native Rust binary").
- **Prós**: melhor qualidade; 100% local (alinha com a privacidade do default Ollama, `config/schema.ts:30`); sem custo por uso.
- **Contras**: dependência pesada (Python + torch + pyannote, ~GBs); empacotamento Windows/Tauri complicado (hoje só se bundla `node.exe`/`ffmpeg.exe` via `download-deps-win.ps1`, ver `CLAUDE.md` Packaging); precisa token HuggingFace p/ baixar o modelo; lento sem GPU.

### Opção B — serviço externo (Deepgram, AssemblyAI, etc.)
APIs de transcrição que já entregam diarização junto.
- **Prós**: zero infra local; qualidade boa; resolveria transcrição+diarização num request.
- **Contras**: custo por minuto; privacidade (áudio vai pra terceiro); seria um **novo `TranscriberPort`** concorrendo com Groq — mudança de arquitetura, não só add-on; o app é vendido como "local-first".

### Opção C — heurística sem ML (barata, baixa qualidade)
Inferir troca de locutor por pausas longas entre segmentos (gaps no `end`→`start`) e/ou, no caso do mix mic+loopback (ver `CLAUDE.md` "Mic is mixed into the loopback stream"), separar "eu (mic)" de "outros (sistema)" gravando **duas trilhas** em vez de mixar.
- **Prós**: sem dependência nova; a separação mic vs. sistema é tecnicamente real e útil ("Eu:" vs. "Reunião:").
- **Contras**: pausas não identificam *quem*, só *que mudou*; não distingue vozes dentro da trilha do sistema. A trilha dupla exige mexer no `wasapi_capture.rs` e no `FFmpegPulseAdapter` (escopo grande).

**Recomendação**: começar pela **Opção C-trilha-dupla** (separar mic/sistema → 2 rótulos: "Você" e "Participantes") como MVP de baixo risco que já melhora reuniões 1:N; oferecer **Opção A (pyannote)** como modo opcional "diarização avançada" para quem aceita o download. Evitar a Opção B enquanto o posicionamento for local-first.

## Como implementar (assumindo Opção A como alvo final, com o casamento sendo comum a A e C)

### Onde encaixa no pipeline
Entre transcrição e armazenamento, em `TranscriptionService.transcribeSession` (`transcription.service.ts:19-71`). Após obter `allSegments` (linha 51) e antes de montar/salvar o `Transcript` (linhas 56-69), rodar diarização e anotar locutores.

### 1. Novo port
`packages/core/src/ports/diarizer.ts`:
```ts
export interface SpeakerTurn { start: number; end: number; speaker: string; } // ex.: "SPEAKER_00"
export interface DiarizerPort {
	diarize(audioPath: string): Promise<SpeakerTurn[]>;
	isAvailable(): Promise<boolean>;
}
```

### 2. Adapter sidecar (Opção A)
`packages/core/src/adapters/diarization/pyannote-sidecar.ts`: faz `spawn` de um script Python que recebe o WAV e imprime JSON `[{start, end, speaker}]` no stdout. **Importante**: diarizar o áudio da **sessão inteira** (chunks concatenados), não chunk a chunk — locutores precisam ser consistentes entre chunks; rótulos por chunk não casariam. O server já sabe concatenar chunks com ffmpeg (`apps/gui/server.ts:683-699`); reusar essa lógica para gerar um WAV único antes de diarizar.

### 3. Casar locutores ↔ segmentos
Função pura nova (`packages/core/src/utils/`): para cada `TranscriptSegment`, achar o `SpeakerTurn` com maior sobreposição `[start,end]` e setar `segment.speaker`. Empate/sem overlap → herdar do segmento anterior.

### 4. Modelo + persistência
- `TranscriptSegment` (`domain/models.ts:34-38`): adicionar `speaker?: string`. Como segmentos são salvos como JSON (`sqlite.ts:223`/`:243`), **não há migração de coluna** — transcrições antigas simplesmente não terão o campo (UI deve tratar `undefined`).
- `TranscriberPort`/result não muda; quem injeta o speaker é o `TranscriptionService`, não o transcriber.

### 5. Server / config
- `analysisConfigSchema`/`transcriptionConfigSchema` (`config/schema.ts:16-40`): novo bloco `diarization: { enabled: boolean (default false), provider: "pyannote" | "channels" }`.
- `POST /api/sessions/:id/transcribe` (`apps/gui/server.ts:528-578`): se diarização ligada, instanciar o `DiarizerPort` e passar ao `TranscriptionService` (hoje ele recebe só transcriber+repo+rateLimits, `transcription.service.ts:11-17` e `server.ts:550-553`).

### 6. UI / export
- `TranscriptPanel` (`SessionDetailPage.tsx:323-506`): renderizar `seg.speaker` antes do texto (`SessionDetailPage.tsx:498-500`), com cor por locutor. Filtro de busca atual (`SessionDetailPage.tsx:62-66`) continua igual.
- `fullText` no service (`transcription.service.ts:56`): opcionalmente prefixar `"Falante X: "` para que os templates (ex.: `meeting-summary.ts`) recebam os locutores no prompt — melhora muito o resumo de reunião.
- `MarkdownExporter` (`packages/core/src/adapters/persistence/`, usado em `server.ts:1107`): incluir locutor na transcrição exportada.

## Plano de testes
- **Unit**: a função de casamento turno↔segmento (overlap, herança em gap, fronteiras). Fixtures JSON com turns e segments conhecidos. `pnpm test:unit`.
- **Integração**: `transcribeSession` com um `DiarizerPort` fake injetado retornando turns fixos → segmentos saem com `speaker` correto e persistidos.
- **Sidecar (Opção A)**: smoke do script Python com um WAV de 2 locutores conhecido; comparar nº de locutores detectados.
- **Manual**: gravar reunião real (ou simular 2 vozes), transcrever com diarização ligada, conferir rótulos na aba Transcript e no `meeting-summary`. Usar skill `audio-diag` para validar o WAV de entrada.

## Riscos / decisões em aberto
- **Empacotamento (o maior risco)**: pyannote (Python+torch) não cabe no esquema atual de bundle (`download-deps-win.ps1` só traz node/ffmpeg; nativos são frágeis — ver `CLAUDE.md` Packaging). Decidir: download sob demanda no primeiro uso? feature só em dev/Linux na v1?
- **Latência**: diarização local sem GPU é lenta; conflita com spec 18 (live) — diarização ao vivo é dificílima, deixar só para pós-processamento.
- **Privacidade vs. qualidade**: Opção B (externa) é a mais fácil mas fere o local-first.
- **Trilha dupla (Opção C)** muda a captura (`wasapi_capture.rs` e mix com `alimiter` no Linux — `CLAUDE.md` "Mic is mixed"), e hoje grava-se no formato nativo do device (`recording.service.ts:49-89`); separar trilhas é mexer em terreno frágil já documentado como gotcha.
- **Rótulos genéricos**: "SPEAKER_00" não é nome real; permitir o usuário renomear locutores na UI seria um follow-up valioso (persistir mapa id→nome por sessão).
