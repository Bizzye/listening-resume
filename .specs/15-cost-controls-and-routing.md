# 15 — Controles de custo + roteamento por tamanho + indicador de quota

> Status: proposta · Esforço: 🔴 · Impacto: alto · Depende de: spec 01 (whisper-cpp como provider real) para o roteamento de transcrição cair em local

## Problema

O app usa o **free tier** da Groq, que tem limites apertados: 18 RPM, 7000
segundos de áudio/hora (Whisper) e 12k TPM (LLM). Hoje:

1. **Não há visibilidade de quota** — o usuário só descobre que estourou quando
   uma transcrição/análise falha (429) no meio do fluxo, sem aviso prévio.
2. **Sem roteamento por tamanho** — toda transcrição vai para Groq e toda análise
   tenta o provider configurado primeiro, independentemente do tamanho. Uma aula
   longa (muitos chunks / transcript gigante) bate nos limites de Groq quando
   poderia rodar local (Ollama/whisper.cpp) **sem TPM**.
3. **`num_ctx` fixo no Ollama** (`8192`) — transcripts curtos desperdiçam VRAM e
   transcripts longos são **silenciosamente truncados** (o modelo só "vê" o
   começo). Deveria dimensionar ao texto, com teto de VRAM.

## Como está hoje

- `SlidingWindowLimiter` controla RPM e áudio-segundos/hora por **janela
  deslizante**, mas **não expõe estado/uso** — só `waitForSlot()` que bloqueia:
  `packages/core/src/utils/rate-limiter.ts:15`. Os contadores `timestamps` e
  `audioSeconds` são privados (`rate-limiter.ts:2-3`), sem getter de "quanto resta".
- Limites default: `groqRpm: 18`, `groqAudioSecondsPerHour: 7000`:
  `packages/core/src/config/schema.ts:42-45`. O TPM (12k) **não está modelado** em
  lugar nenhum.
- O limiter é instanciado dentro do `TranscriptionService`
  (`packages/core/src/application/transcription.service.ts:16`) e usado por chunk
  em `transcription.service.ts:37` (`waitForSlot(durationSec)`). É **efêmero por
  request** no GUI server (recriado em `apps/gui/server.ts:550`), então o estado de
  quota **não sobrevive entre requests** — a janela deslizante real da Groq não é
  rastreada de forma global.
- A transcrição é **por chunk**, não "tudo numa chamada": loop em
  `transcription.service.ts:30` chama `transcriber.transcribe(chunk.path, ...)`
  por chunk (`transcription.service.ts:40`). (Boa base para roteamento.)
- Análise: o endpoint escolhe primário/fallback por `config.analysis.provider`
  (`apps/gui/server.ts:617-620`); `AnalysisService` faz primário→fallback em
  `packages/core/src/application/analysis.service.ts:28-49`. **Não considera o
  tamanho do transcript** para escolher provider.
- Ollama: `num_ctx: 8192` fixo e `num_predict: 4096` fixos:
  `packages/core/src/adapters/analysis/ollama.ts:39-40` (com comentário explicando
  o trade-off VRAM em `ollama.ts:34-38`).
- Groq LLM: `max_tokens: 4096` fixo, com comentário de que `prompt + max_tokens`
  conta no TPM (12k free) e 8k estourava 413: `groq-llm.ts:37-38`.
- `GET /api/config` (`server.ts:970`) não devolve nenhum dado de uso/quota.

## O que precisa ser feito

1. **Indicador de uso/quota na UI** antes de estourar: rastrear consumo Groq
   (RPM, áudio-seg/h, TPM aproximado) num limiter **persistente em memória do
   server** (não por request) e expor via endpoint.
2. **Roteamento automático por tamanho**:
   - Transcrição: se o total estimado de áudio (ou o que sobra de quota) for
     grande → usar whisper.cpp local; se pequeno e Groq tem quota → Groq.
   - Análise: se o transcript for grande (tokens estimados acima de um limiar de
     TPM Groq) → Ollama local; se pequeno → Groq (mais capaz).
3. **`num_ctx` adaptativo no Ollama** dimensionado ao tamanho do texto, com cap de
   VRAM configurável.

## Como implementar

### A. Core — limiter observável e persistente

Estender `packages/core/src/utils/rate-limiter.ts` com getters de uso, sem mexer
na semântica de `waitForSlot`:

```ts
export interface QuotaUsage {
	rpmUsed: number; rpmMax: number;
	audioSecUsed: number; audioSecMax: number; // janela de 1h
	tpmUsed: number; tpmMax: number;           // janela de 1min (novo)
}

export class SlidingWindowLimiter {
	private tokens: { time: number; value: number }[] = []; // novo: para TPM
	private maxTpm: number;
	// ...
	recordTokens(n: number) { this.tokens.push({ time: Date.now(), value: n }); }
	getUsage(): QuotaUsage {
		const now = Date.now(); this.cleanup(now);
		this.tokens = this.tokens.filter((t) => t.time > now - 60_000);
		return {
			rpmUsed: this.timestamps.length, rpmMax: this.maxRpm,
			audioSecUsed: this.audioSeconds.reduce((s, e) => s + e.value, 0), audioSecMax: this.maxAudioSecondsPerHour,
			tpmUsed: this.tokens.reduce((s, e) => s + e.value, 0), tpmMax: this.maxTpm,
		};
	}
}
```

Adicionar `groqTpm: z.number().default(12000)` em
`rateLimitsConfigSchema` (`packages/core/src/config/schema.ts:42`).

Criar um **singleton de limiter no GUI server** (em vez de recriar por request em
`server.ts:550`): um módulo `apps/gui/quota.ts` que mantém uma instância do
`SlidingWindowLimiter` viva enquanto o processo rodar, compartilhada por
transcribe e analyze. (Limitação conhecida: `node --watch` zera ao recarregar —
aceitável; ver Riscos.)

### B. Core — estimadores de tamanho

Criar `packages/core/src/utils/sizing.ts`:

```ts
// estimativa grosseira: ~1 token a cada 4 chars (pt/en); ajustar empiricamente
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}
// num_ctx: prompt + saída esperada, arredondado para potência de 2 usual do Ollama,
// com teto por VRAM.
export function pickNumCtx(promptTokens: number, predictTokens = 1024, capCtx = 8192): number {
	const need = promptTokens + predictTokens;
	const buckets = [2048, 4096, 8192, 16384, 32768];
	const chosen = buckets.find((b) => b >= need) ?? buckets[buckets.length - 1];
	return Math.min(chosen, capCtx);
}
```

Exportar de `packages/core/src/index.ts`.

### C. Core — `num_ctx` adaptativo no Ollama

Em `packages/core/src/adapters/analysis/ollama.ts`, substituir o `num_ctx: 8192`
fixo (`ollama.ts:39`) por valor calculado a partir do prompt montado
(`userPrompt` em `ollama.ts:16` + `systemPrompt` em `ollama.ts:22`):

```ts
import { estimateTokens, pickNumCtx } from "../../utils/sizing.js";
// ...
const promptTokens = estimateTokens(systemPrompt) + estimateTokens(userPrompt);
const numCtx = pickNumCtx(promptTokens, 1024, this.maxCtx); // this.maxCtx = cap de VRAM
const response = await this.client.chat({
	model: this.model,
	messages: [/* ... */],
	options: { num_ctx: numCtx, num_predict: 4096, temperature: 0.3 },
});
```

Adicionar param `maxCtx` no construtor (`ollama.ts:10`, default 8192 para manter
o comportamento atual em GPU de 8 GB) e propagá-lo a partir de um novo
`config.analysis.maxCtx` (campo a adicionar em `analysisConfigSchema`,
`schema.ts:29`).

### D. Core — roteamento por tamanho

**Transcrição** — em `TranscriptionService` (`transcription.service.ts:8`),
injetar opcionalmente um **segundo transcriber local** e a referência do limiter,
e decidir por chunk (ou up-front pela soma de durações):

```ts
constructor(
	private groqTranscriber: TranscriberPort,
	private localTranscriber: TranscriberPort | null,
	private repo: SessionRepository,
	private limiter: SlidingWindowLimiter,
	private routing: { audioSecThreshold: number } = { audioSecThreshold: 1800 },
) {}
// no loop (transcription.service.ts:30): escolher por chunk conforme quota restante
const usage = this.limiter.getUsage();
const audioLeft = usage.audioSecMax - usage.audioSecUsed;
const useLocal = this.localTranscriber && (durationSec > audioLeft || totalAudioSec > this.routing.audioSecThreshold);
const t = useLocal ? this.localTranscriber! : this.groqTranscriber;
```

Alternativa mais simples (MVP): decidir **uma vez** no GUI server antes de montar
o service, somando `getAudioDuration(session.id)` (`apps/gui/server.ts:195`):
se total > limiar OU sem quota Groq suficiente OU sem chave → whisper.cpp; senão
Groq. Isso evita misturar providers num mesmo transcript (mais previsível).

**Análise** — no endpoint `POST /api/sessions/:id/analyze`
(`apps/gui/server.ts:581`), antes de montar primário/fallback
(`server.ts:617-620`), estimar tokens do transcript e rotear:

```ts
const transcriptTokens = estimateTokens(existingTranscript.fullText);
const groqWouldFit = transcriptTokens + 4096 < config.rateLimits.groqTpm; // 4096 = max_tokens (groq-llm.ts:38)
const usage = quota.getUsage();
const groqHasQuota = usage.tpmUsed + transcriptTokens < usage.tpmMax;
const routeToLocal = !groqApiKey || !groqWouldFit || !groqHasQuota;
const ollama = new OllamaAdapter(config.analysis.model, undefined, config.analysis.maxCtx);
const groq = groqApiKey ? new GroqLLMAdapter(groqApiKey, config.analysis.fallback?.model ?? "llama-3.3-70b-versatile") : null;
const analyzer = routeToLocal ? ollama : (groq ?? ollama);
const fallback = routeToLocal ? groq : ollama;
```

Após análise Groq, alimentar o limiter com tokens reais
(`response.usage?.total_tokens`, já disponível em `groq-llm.ts:50`) via
`quota.recordTokens(...)`.

### E. GUI server — endpoint de quota

Adicionar (perto de `GET /api/config`, `server.ts:970`):

```ts
// GET /api/quota — uso atual da Groq (free tier)
if (route === "/api/quota" && req.method === "GET") {
	return json(res, quota.getUsage()); // { rpmUsed, rpmMax, audioSecUsed, audioSecMax, tpmUsed, tpmMax }
}
```

Opcional: incluir um `routingHint` (qual provider o próximo transcribe/analyze
usaria) para a UI explicar a decisão.

### F. Frontend — indicador de quota

- `apps/gui/src/shared/lib/api.ts`: adicionar `getQuota()` →
  `request("/quota")` e tipo `QuotaUsage`.
- Componente novo `QuotaIndicator` (3 barras: RPM, áudio-h, TPM) — mostrar no
  topo da `RecordingPage`/`Dashboard` e na seção Transcription das Settings
  (`apps/gui/src/features/settings/SettingsPage.tsx:154`). Cores: verde < 70%,
  amarelo 70–90%, vermelho > 90% (reusar tokens de cor já usados, ex.: `success`/
  `recording` em `SettingsPage.tsx:118/123`).
- Antes de iniciar uma transcrição grande, exibir aviso: "Esta gravação (~X min)
  excede a quota Groq restante — será transcrita localmente (whisper.cpp)" quando
  o roteamento decidir por local.
- Poll leve de `getQuota()` (ex.: a cada 10 s enquanto na tela de gravação/
  transcrição) ou refetch após cada transcribe/analyze.

## Plano de testes

- Unit (core): `estimateTokens` (faixas conhecidas), `pickNumCtx` (buckets,
  cap de VRAM respeitado), `SlidingWindowLimiter.getUsage`/`recordTokens` (janelas
  de 1 min e 1 h, cleanup correto). Rodar:
  `pnpm --filter @listening-resume/core exec vitest run src/utils`.
- Unit: `OllamaAdapter` calcula `num_ctx` adaptativo (mockar `client.chat`,
  asserir `options.num_ctx` para transcript curto vs. longo, e que respeita
  `maxCtx`).
- Integração: simular limiter "cheio" e confirmar que o analyze roteia para
  Ollama e o transcribe para whisper.cpp; transcript curto + quota livre → Groq.
- Manual/E2E: skill `pipeline-test` com uma gravação longa para forçar roteamento
  local; verificar `GET /api/quota` reflete consumo após uma análise Groq real.
- UI (Playwright MCP em `http://localhost:1420`): `QuotaIndicator` muda de cor
  conforme uso; aviso de roteamento aparece para gravação grande.

## Riscos / decisões em aberto

- **Quota não é a verdade da Groq**: o limiter local é uma aproximação; a Groq
  pode ter contado requests de outras fontes (mesma chave em outro app). Tratar
  429 da Groq como sinal autoritativo e recuar para local mesmo que o indicador
  diga "ok".
- **Estimativa de tokens grosseira**: `chars/4` erra para código/idiomas; pode
  rotear errado perto do limiar. Manter margem de segurança (ex.: usar 90% do TPM
  como teto efetivo) e, se possível, calibrar com `usage.total_tokens` reais.
- **Estado efêmero com `node --watch`**: o singleton de quota zera a cada reload
  do dev server (ver gotcha de `node --watch` no CLAUDE.md). Aceitável em dev; em
  produção o processo é estável. Não persistir em disco no MVP.
- **Misturar providers num mesmo transcript**: roteamento por chunk pode juntar
  segmentos de Groq e whisper.cpp com qualidade/idioma divergentes. MVP recomenda
  decidir o provider **uma vez por sessão** (variante simples no item D).
- **VRAM real desconhecida**: `pickNumCtx` usa um cap configurável, não detecta
  GPU. Expor `config.analysis.maxCtx` e documentar; auto-detecção de VRAM fica
  fora de escopo.
- **num_ctx maior = mais lento/mais memória no Ollama**: subir o ctx para
  transcripts longos pode derrubar para CPU (lento). O cap protege, mas a UX deve
  avisar que análises locais longas demoram.
