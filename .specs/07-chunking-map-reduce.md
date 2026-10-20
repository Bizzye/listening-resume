# 07 — Análise de aulas longas via chunking (Map-Reduce)
> Status: proposta · Esforço: 🟡 · Impacto: Alto (destrava aulas/reuniões longas que hoje falham ou são truncadas) · Depende de: nada (o cache do item 08 é complementar e roda por cima)

## Problema

Hoje a transcrição **inteira** é injetada numa **única chamada** ao LLM. Isso quebra de duas formas em conteúdo longo (aula de 1h+):

- **Groq (free tier)**: o prompt (system + template + transcrição) somado ao `max_tokens` é contado contra o limite de **12k TPM**. Transcrições médias/longas estouram e o Groq devolve **413 "Request too large"**. Há até comentário no código confirmando isso (`groq-llm.ts:34-36`).
- **Ollama**: o contexto está fixado em `num_ctx: 8192` (`ollama.ts:39`). Tudo que passa disso é **silenciosamente truncado** — o modelo "vê" só os primeiros minutos da aula e o resumo sai incompleto. O próprio comentário admite que 8192 cabe só "~40min de aula" (`ollama.ts:34-38`).

Resultado: justamente o caso de uso mais valioso (a "Videoaula — Extração Total", `templates/videoaula-insana.ts`) é o que mais sofre, porque é exaustivo e roda sobre aulas longas.

## Como está hoje

- Monta o prompt e chama o analyzer **uma vez** com a transcrição completa:
  - `packages/core/src/application/analysis.service.ts:20` — pega `transcript.fullText`.
  - `packages/core/src/application/analysis.service.ts:33-37` — `analyzer.analyze({ template, transcript: transcript.fullText, extraPrompt })`.
  - `packages/core/src/application/analysis.service.ts:44-48` — mesma chamada no fallback.
- Os adapters fazem `template.userPromptTemplate.replace("{{transcript}}", options.transcript)` e disparam **uma** request:
  - Ollama: `packages/core/src/adapters/analysis/ollama.ts:16-43` (com `num_ctx: 8192`, `num_predict: 4096` em `:39-40`).
  - Groq: `packages/core/src/adapters/analysis/groq-llm.ts:16-39` (com `max_tokens: 4096` em `:38`).
- Contrato do port: `packages/core/src/ports/analyzer.ts:13-32` (`AnalyzeOptions`, `AnalyzeResult`, `AnalyzerPort.analyze`).
- Endpoint que dispara tudo: `apps/gui/server.ts:580-639` (instancia `OllamaAdapter`/`GroqLLMAdapter`, monta `AnalysisService`, chama `analyzeSession`).
- Não existe **nenhuma** noção de tokens, chunking ou número de blocos no código atual.

## O que precisa ser feito

Introduzir um pipeline **Map-Reduce** dentro do `AnalysisService`, transparente para os adapters e para o endpoint:

1. **Estimar tokens** da transcrição completa.
2. Se couber numa chamada → caminho atual (uma chamada só). **Sem regressão para conteúdo curto.**
3. Se não couber → **dividir** a transcrição em blocos (com overlap), rodar **MAP** (extração parcial por bloco), depois **REDUCE** (combinar parciais num documento final coeso que respeite a estrutura do template escolhido).
4. Tudo precisa preservar o **formato do template** (ex.: as 12 seções da `videoaula-insana`).

## Como implementar

### 1. Estimativa de tokens (novo util)

Criar `packages/core/src/utils/token-estimate.ts`. Não vale a pena puxar um tokenizer real (tiktoken/llama) — uma heurística por caracteres é suficiente para **dimensionar blocos com margem**. Português ≈ 4 chars/token; usamos 3.5 para sermos conservadores.

```ts
// packages/core/src/utils/token-estimate.ts
export function estimateTokens(text: string): number {
	// Heurística conservadora p/ pt-BR (~3.5 chars/token).
	return Math.ceil(text.length / 3.5);
}
```

### 2. Declarar limites por adapter (estender o port)

O `AnalysisService` precisa saber **quanto de transcrição** cabe num MAP para cada provider. Adicionar campos opcionais no `AnalyzerPort` (`packages/core/src/ports/analyzer.ts:27-32`):

```ts
export interface AnalyzerPort {
	analyze(options: AnalyzeOptions): Promise<AnalyzeResult>;
	isAvailable(): Promise<boolean>;
	readonly provider: string;
	readonly model: string;
	/** Teto de tokens de transcrição por chamada (input budget já descontando system+template+resposta). */
	readonly maxInputTokens: number;
}
```

Valores reais por adapter:
- **Groq** (`groq-llm.ts`): TPM free = 12k, e `prompt + max_tokens` contam juntos. Com `max_tokens: 4096` (`groq-llm.ts:38`) sobram ~8k para prompt; o template `videoaula-insana` já é grande (~1.5k tokens). Definir `maxInputTokens = 5000` como teto **seguro** de transcrição por bloco.
- **Ollama** (`ollama.ts`): `num_ctx: 8192` precisa caber system+template+transcrição+`num_predict`. Com template grande + `num_predict: 4096`, sobram ~2.5k para transcrição. Definir `maxInputTokens = 2500`.

Adicionar `readonly maxInputTokens = 5000;` em `groq-llm.ts` (junto a `:7-8`) e `readonly maxInputTokens = 2500;` em `ollama.ts` (junto a `:7-8`).

> Decisão: deixar como propriedade do adapter (e não constante no service) porque os tetos são intrinsecamente dependentes do provider/contexto.

### 3. Chunking com overlap

Dividir por **parágrafos/frases**, nunca cortando no meio de uma palavra. Overlap evita perder contexto na fronteira (uma ideia que começa no fim de um bloco e termina no início do próximo).

```ts
// dentro de analysis.service.ts (ou utils/chunk-transcript.ts)
function splitIntoChunks(text: string, maxTokens: number, overlapTokens = 200): string[] {
	if (estimateTokens(text) <= maxTokens) return [text];
	const maxChars = Math.floor(maxTokens * 3.5);
	const overlapChars = Math.floor(overlapTokens * 3.5);
	// Quebra preferindo limites de frase/parágrafo.
	const units = text.split(/(?<=[.!?\n])\s+/);
	const chunks: string[] = [];
	let buf = "";
	for (const u of units) {
		if (buf.length + u.length > maxChars && buf.length > 0) {
			chunks.push(buf.trim());
			buf = buf.slice(Math.max(0, buf.length - overlapChars)); // carrega cauda como contexto
		}
		buf += `${u} `;
	}
	if (buf.trim()) chunks.push(buf.trim());
	return chunks;
}
```

### 4. Fase MAP

Para cada bloco, rodar uma extração **parcial e fiel**, marcando que é uma parte de um todo. Importante: na fase MAP **não** usamos o `userPromptTemplate` final do template (ele exige o documento completo, ex.: "banco de 8-15 questões da aula INTEIRA"). Usamos um prompt de MAP genérico que apenas **extrai cru e fielmente** o conteúdo do trecho, preservando números/fórmulas/nomes/código (mesmo espírito das "REGRAS DE OURO" em `videoaula-insana.ts:78-84`).

```ts
const MAP_PROMPT = `Você recebeu o TRECHO {{i}} de {{n}} de uma transcrição maior, em ordem cronológica.
Extraia de forma FIEL e EXAUSTIVA tudo de relevante SÓ deste trecho: conceitos, definições, exemplos,
números, fórmulas, código, passos, ênfases ("isso cai na prova"), correções. PRESERVE nomes próprios,
valores e notação exatamente. NÃO invente nada que não esteja no trecho. NÃO produza conclusões finais
nem seções de fechamento (isso virá depois). Responda em português brasileiro.

TRECHO {{i}}/{{n}}:
{{transcript}}`;
```

Cada chamada MAP passa por `analyzer.analyze({ template: { ...mapTemplate }, transcript: bloco })`. Como o adapter só faz `replace("{{transcript}}", ...)` (`ollama.ts:16-19`, `groq-llm.ts:16-19`), basta montar um `AnalysisTemplate` sintético com `userPromptTemplate = MAP_PROMPT` (com `{{i}}`/`{{n}}` já substituídos antes). Rodar os MAPs **sequencialmente** (não em paralelo) para respeitar o rate-limit do Groq.

### 5. Fase REDUCE

Concatenar os parciais e rodar **uma** chamada final que aplica o **template original** sobre as extrações (não sobre a transcrição crua). Trocar a frase de cabeçalho para deixar claro que a entrada já são extrações:

```ts
const reduceInput = mapResults
	.map((r, i) => `=== EXTRAÇÃO DO TRECHO ${i + 1} ===\n${r.content}`)
	.join("\n\n");
const reduceTemplate: AnalysisTemplate = {
	...template,
	userPromptTemplate: template.userPromptTemplate.replace(
		"Transcrição da videoaula:",
		"As EXTRAÇÕES PARCIAIS abaixo cobrem a aula INTEIRA em ordem. Consolide-as num único documento coeso, sem repetir, no formato pedido:",
	),
};
result = await analyzer.analyze({ template: reduceTemplate, transcript: reduceInput, extraPrompt });
```

> Risco do REDUCE: a soma dos parciais também pode estourar `maxInputTokens`. Tratar com **REDUCE hierárquico** — se `estimateTokens(reduceInput) > maxInputTokens`, agrupar parciais em "super-blocos", reduzir cada grupo, e reduzir os resultados de novo (recursão). Para o MVP, basta limitar `maxInputTokens` do MAP de forma que ~6-8 parciais caibam num único REDUCE (cobre aula de ~2h); a recursão fica como follow-up.

### 6. Orquestração no service

Refatorar `analyzeSession` (`analysis.service.ts:15-65`) para extrair um helper `runAnalysis(analyzer, template, transcript, extraPrompt)` que decide single-shot vs map-reduce, e chamar esse helper tanto no caminho primário (`:33-37`) quanto no fallback (`:44-48`). Pseudo:

```ts
private async runAnalysis(analyzer, template, transcript, extraPrompt) {
	if (estimateTokens(transcript) <= analyzer.maxInputTokens) {
		return analyzer.analyze({ template, transcript, extraPrompt }); // caminho atual
	}
	const chunks = splitIntoChunks(transcript, analyzer.maxInputTokens);
	logger.info(`Transcrição longa: ${chunks.length} blocos (map-reduce) via ${analyzer.provider}`);
	const partials = [];
	for (let i = 0; i < chunks.length; i++) {
		partials.push(await analyzer.analyze({ template: mapTemplate(i, chunks.length), transcript: chunks[i] }));
	}
	return this.reduce(analyzer, template, partials, extraPrompt);
}
```

O retorno continua sendo um `AnalyzeResult` (`analyzer.ts:20-25`), então `saveAnalysis` (`analysis.service.ts:51-61`) e o endpoint (`server.ts:638`) **não mudam**.

### 7. Endpoint

Nenhuma mudança obrigatória em `apps/gui/server.ts:580-639`. Opcional: o map-reduce demora mais (N+1 chamadas), então vale considerar aumentar timeout do client/UI, mas isso é fora do escopo do core.

## Plano de testes

Unit (Vitest, `packages/core`):
- `token-estimate.test.ts`: monotonicidade e ordem de grandeza (texto de 14k chars ≈ 4k tokens).
- `chunk-transcript.test.ts`: (a) texto curto → 1 bloco idêntico; (b) texto longo → N blocos, cada um ≤ `maxChars`; (c) overlap presente entre blocos consecutivos; (d) nunca corta palavra no meio.
- `analysis.service.test.ts` com **AnalyzerPort fake** (registra cada `analyze` recebido):
  - transcrição curta (≤ `maxInputTokens`) → **1** chamada, prompt = template original (sem regressão).
  - transcrição longa → **N MAPs + 1 REDUCE**; REDUCE recebe as extrações e o template original; resultado salvo via `repo.saveAnalysis`.
  - fallback: primário lança no MAP → cai no fallback com o **mesmo** pipeline.
- Garantir que `{{transcript}}` é substituído em MAP e REDUCE (consistente com `ollama.ts:16-19` / `groq-llm.ts:16-19`).

Integração/manual:
- Rodar `pipeline-test` (skill) ou o endpoint `POST /api/sessions/:id/analyze` com uma transcrição real longa e o template `videoaula-insana`, confirmando que: (a) Groq não devolve 413; (b) o doc final contém as seções finais (banco de questões, resumo de 1 página) cobrindo o fim da aula — prova de que não truncou.

## Riscos / decisões em aberto

- **Custo/latência**: passa de 1 para N+1 chamadas. No Groq free, mais chamadas = mais pressão no RPM (18) e TPM. Mitigar com MAPs sequenciais e blocos não pequenos demais. O cache do item 08 reduz re-análises.
- **Perda de coesão no REDUCE**: combinar parciais pode gerar repetição ou inconsistência. Prompt de REDUCE pede explicitamente "sem repetir, coeso". Avaliar qualidade no template real.
- **Heurística de tokens é aproximada**: deixar `maxInputTokens` conservador. Se ainda estourar, baixar os valores (5000/2500) — são o único knob.
- **REDUCE hierárquico**: deixado como follow-up; para aulas > ~2h os parciais podem estourar o REDUCE. Decidir se entra já no MVP.
- **MAP perde o "todo"**: extrações por bloco podem perder conexões cross-bloco (ex.: "como liga à aula anterior"). O overlap mitiga parcialmente; o REDUCE com o template completo recupera as seções de "conexões".
- **Fase MAP ignora `extraPrompt`**: decidir se as instruções extras do usuário valem só no REDUCE (proposta atual) ou também no MAP.
