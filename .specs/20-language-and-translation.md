# 20 — Idioma por sessão + tradução
> Status: proposta · Esforço: 🟡 · Impacto: Alto para conteúdo multilíngue (aulas em inglês, reuniões com estrangeiros) e para precisão da transcrição · Depende de: nada obrigatório; relaciona-se a spec 19 (i18n da UI ≠ idioma do conteúdo) e spec 16 (chat reusa o mesmo eixo de tradução)

## Problema
Duas lacunas:
1. **Idioma da transcrição é global e fixo em "auto"** — não dá para dizer "esta sessão é em inglês". Forçar o idioma melhora muito a acurácia do Whisper em áudios com sotaque/ruído, e evita o Whisper "traduzir/inventar" idioma errado.
2. **Não há tradução** — transcript e resumo saem no idioma do áudio. Quem grava uma aula em inglês não consegue um resumo em português (ou vice-versa) sem refazer tudo manualmente.

## Como está hoje
### Idioma da transcrição (global)
- Default global `transcription.language: "auto"` no schema (`packages/core/src/config/schema.ts:19`).
- O server passa **sempre o valor global** para o transcribe: `transcriptionService.transcribeSession(session.id, config.transcription.language, config.transcription.prompt || undefined)` (`apps/gui/server.ts:560-564`). Não lê nada por-sessão.
- O adapter Groq já aceita o parâmetro e trata "auto": `language: options?.language === "auto" ? undefined : options?.language` (`packages/core/src/adapters/transcription/groq-whisper.ts:27`). O port define `TranscribeOptions { language?, model?, prompt? }` (`packages/core/src/ports/transcriber.ts:3-7`). whisper.cpp idem (`adapters/transcription/whisper-cpp.ts:30,62`).
- **A coluna por-sessão JÁ EXISTE mas não é usada para isso**: `sessions.language` (`schema.ts:10`, default "auto"; modelo `Session.language` em `domain/models.ts:20`; persistido em `sqlite.ts:42,127-133`). Hoje é sempre gravada como `"auto"` em `RecordingService.startRecording` (`recording.service.ts:37`) e nunca enviada ao transcriber. **Ou seja: o campo está pronto, falta plumbing.**
- Não há UI para escolher idioma da sessão (RecordingPage só tem device/mic/mute — `RecordingPage.tsx`).

### Tradução
- Inexistente. `Transcript` (`domain/models.ts:40-49`) e `Analysis` (`:51-59`) guardam só o conteúdo original. O `ANALYSIS_SYSTEM_PROMPT` força saída em pt-BR (`packages/core/src/ports/analyzer.ts:11`), o que é uma tradução implícita do resumo mas **não** do transcript, e não é controlável.
- Os adapters de análise (Groq/Ollama) são LLMs de propósito geral — perfeitamente capazes de traduzir, mas não há fluxo/endpoint/persistência para isso.

## O que precisa ser feito
### (a) Idioma da transcrição por sessão
1. UI para escolher idioma ao iniciar a gravação (ou editar depois, antes de transcrever).
2. Persistir em `sessions.language` (já existe).
3. Server usa `session.language` em vez do global ao transcrever.

### (b) Tradução de transcript/resumo
1. Endpoint que traduz um texto (transcript ou análise) para um idioma alvo via LLM.
2. Persistir o resultado traduzido.
3. Botão "Traduzir para..." na UI.

## Como implementar

### (a) Idioma por sessão
**Captura/persistência:**
- `RecordingService.startRecording` (`recording.service.ts:17-104`): aceitar `language` no `config` e gravar em `session.language` (hoje hardcoded `"auto"` na linha 37). Sem migração — coluna já existe.
- `POST /api/recording/start` (`server.ts:412-441`): ler `language` do body (junto de `device`/`micDevice`, `server.ts:423`) e repassar.
- Alternativa/adicional: permitir editar o idioma antes de transcrever via `updateSession` (já suporta `language`, `sqlite.ts:144`) — endpoint `PATCH /api/sessions/:id` ou reuso do start.

**Uso na transcrição:**
- Em `POST /api/sessions/:id/transcribe` (`server.ts:560-564`), trocar `config.transcription.language` por `session.language` (com fallback ao global se a sessão for "auto"):
```ts
const lang = session.language && session.language !== "auto"
	? session.language
	: config.transcription.language;
transcript = await transcriptionService.transcribeSession(session.id, lang, config.transcription.prompt || undefined);
```
O resto já funciona — o adapter Groq mapeia "auto"→undefined (`groq-whisper.ts:27`).

**UI:**
- Seletor de idioma no fluxo de gravação (provavelmente em `features/recording/` ou no dashboard que inicia a gravação) e/ou na `SessionDetailPage` antes do botão "Transcribe" (`SessionDetailPage.tsx:157-164`). Lista curta: Auto, Português, Inglês, Espanhol... (ISO 639-1: `pt`, `en`, `es`). `api.startRecording` em `apps/gui/src/shared/lib/api.ts` ganha o campo `language`.

### (b) Tradução via LLM
**Reuso do AnalyzerPort** (Groq/Ollama já fazem chat — `groq-llm.ts:27`, `ollama.ts:27`). Duas formas:
- **Simples (recomendado v1)**: novo método/uso de `analyze` com um template de tradução. Criar um system prompt dedicado de tradução (não o de resumo, `analyzer.ts:11`):
```ts
export const TRANSLATE_SYSTEM_PROMPT = (target: string) =>
	`Traduza o texto a seguir para ${target}. Preserve a formatação Markdown, nomes próprios e termos técnicos. Não resuma, não comente — apenas traduza fielmente.`;
```
- Adicionar um método `translate(text, targetLang)` ao `AnalyzerPort` (opcional, como o `chat` da spec 16) ou apenas montar `messages: [{system: TRANSLATE_...}, {user: text}]` direto no server reusando o client.

**Endpoints (server, `apps/gui/server.ts`):**
- `POST /api/sessions/:id/translate` — body `{ target: "pt"|"en"|..., what: "transcript"|"analysis", analysisId? }`. Escolhe provider igual ao analyze (`server.ts:607-620`), traduz, persiste.
- Texto fonte: `repo.getTranscript(id).fullText` (`sqlite.ts:233-250`) ou `repo.getAnalyses(id)` (`:267-282`).

**Persistência:**
- Resumo traduzido → criar uma **nova `Analysis`** com `templateId` tipo `"translation-en"` e `content` traduzido (reusa toda a infra: `saveAnalysis`/`getAnalyses`, `sqlite.ts:252-282`; render na UI já existe, `SessionDetailPage.tsx:564-587`). Zero migração. Marca o provider/model usados.
- Transcript traduzido → não cabe bem na tabela `transcripts` (uma por sessão). Opções: (i) salvar como `Analysis` com template `"transcript-translation-xx"` (pragmático, aparece na aba Analysis); (ii) nova coluna/tabela `translations`. Recomendo (i) na v1 — reuso máximo, sem schema novo. Trade-off: tradução de transcript aparece como "análise", semanticamente impreciso, mas funcional.

**Trade-off de tamanho**: traduzir transcript inteiro estoura `max_tokens` (Groq 4096, `groq-llm.ts:38`) e contexto Ollama (`num_ctx 8192`, `ollama.ts:39`) em aulas longas. Para transcript longo, **dividir por segmentos/parágrafos e traduzir em lotes** (mesma dor das specs 16/07). Para resumo (curto) é trivial.

**UI:**
- Aba Analysis (`SessionDetailPage.tsx:508-613`): botão "Traduzir para..." com `<select>` de idioma ao lado de "Run Again" (`:602-609`), chamando `api.translate(...)`. A tradução resultante aparece como mais um card de análise (já renderizado via `ReactMarkdown`, `:584`).
- Modelos sugeridos: Groq `llama-3.3-70b-versatile` (default fallback já configurado, `config/schema.ts:38`) traduz bem; Ollama `llama3.1:8b` aceitável para PT/EN. Sem dependência nova.

## Plano de testes
- **Unit/integração (core+server)**:
  - `transcribeSession` recebe o idioma da sessão (não o global) — mock do transcriber verifica `options.language`.
  - `language: "auto"` continua virando `undefined` no Groq (`groq-whisper.ts:27`).
  - Tradução: dado um texto curto, o endpoint cria uma `Analysis` nova com o conteúdo traduzido e provider/model corretos.
- **Manual/E2E**: gravar áudio em inglês escolhendo idioma "Inglês" → transcrição mais precisa que em "auto"; depois "Traduzir resumo para Português" → novo card em português. Usar `pipeline-test` (com idioma) e validar saída. Playwright MCP em `:1420`: `data-testid="session-language-select"`, `translate-button`.
- **Regressão**: sessões antigas com `language="auto"` continuam transcrevendo como antes (fallback ao global).

## Riscos / decisões em aberto
- **Onde guardar transcript traduzido**: reusar tabela `analyses` (sem migração) vs. tabela `translations` dedicada. v1 pragmática usa `analyses`; revisitar se virar feature central.
- **Tamanho/custo**: traduzir transcript longo = múltiplas chamadas (rate limit Groq, `config/schema.ts:42-45`); coordenar com chunking (spec 07).
- **Qualidade**: LLM pode "resumir" em vez de traduzir; prompt restritivo ("não resuma, apenas traduza") + temperatura baixa (já 0.3 nos adapters) mitigam.
- **Conflito com `ANALYSIS_SYSTEM_PROMPT`**: ele força saída pt-BR (`analyzer.ts:11`). Se o usuário escolher resumo em inglês (spec 19/20-v2), esse prompt fixo brigaria — tornar o idioma de saída do resumo configurável via `extraPrompt` (já suportado, `analysis.service.ts:33-37`) é o caminho.
- **"auto" vs. detecção**: Whisper já detecta idioma; o override por sessão é para *forçar* quando o auto erra. Deixar "Auto" como default para não regredir.
- **Idioma da UI ≠ idioma do conteúdo**: deixar claro na UI (spec 19) que o seletor de idioma da sessão é do *áudio/transcrição*, não da interface.
