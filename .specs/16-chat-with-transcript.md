# 16 — Chat com a transcrição (RAG simples)
> Status: proposta · Esforço: 🟡 · Impacto: Alto (transforma a transcrição passiva em algo interrogável; diferencial de produto) · Depende de: spec 07 (chunking de transcript longo) — opcional para a v1, obrigatório para aulas longas

## Problema
Hoje o usuário só consegue duas coisas com a transcrição: ler na aba **Transcript** e gerar um resumo fixo via template na aba **Analysis**. Não dá para fazer uma pergunta livre ("qual prazo foi combinado?", "explique o conceito X que o professor falou"). Cada pergunta nova exige criar um template ou reanalisar tudo. Falta uma conversa multi-turno ancorada no conteúdo da sessão.

## Como está hoje
- Análise é one-shot, sem histórico de mensagens. `AnalysisService.analyzeSession` monta `system + user` e descarta tudo depois (`packages/core/src/application/analysis.service.ts:33-49`).
- O contrato do analyzer é mono-turno: `analyze(options)` recebe `{ template, transcript, extraPrompt, metadata }` e devolve `{ content, model, provider, tokensUsed }` (`packages/core/src/ports/analyzer.ts:13-32`). Não há conceito de `messages[]`.
- Os adapters já falam o protocolo de chat por baixo, mas escondem isso: Groq usa `client.chat.completions.create` com `messages: [system, user]` (`packages/core/src/adapters/analysis/groq-llm.ts:27-39`); Ollama usa `client.chat` igual (`packages/core/src/adapters/analysis/ollama.ts:27-43`). Ambos usam `num_ctx`/`max_tokens` limitados (Ollama `num_ctx: 8192`, `ollama.ts:39`; Groq `max_tokens: 4096`, `groq-llm.ts:38`).
- O transcript inteiro vai cru no prompt (`{{transcript}}` substituído em `groq-llm.ts:16-19` e `ollama.ts:16-19`). Para aulas longas isso já estoura contexto — daí a spec 07.
- Persistência: tabelas `transcripts` e `analyses` existem (`packages/core/src/adapters/persistence/schema.ts:24-43`); **não há tabela de conversa**. O repo expõe `getTranscript(sessionId)` (`packages/core/src/adapters/persistence/sqlite.ts:233-250`).
- Server: endpoints de transcrição/análise são `POST /api/sessions/:id/transcribe` (`apps/gui/server.ts:528-578`) e `POST /api/sessions/:id/analyze` (`apps/gui/server.ts:580-639`). Constrói Ollama/Groq por request (`server.ts:607-620`). **Não há rota de chat.**
- UI: `SessionDetailPage.tsx` tem exatamente 3 abas — `const tabs = ["Transcript", "Analysis", "Export"]` (`apps/gui/src/features/sessions/SessionDetailPage.tsx:68`). A aba ativa vem do store (`activeAnalysisTab` / `setActiveAnalysisTab`, store em `apps/gui/src/store/index.ts:254-255`).

## O que precisa ser feito
1. Estender o port de análise (ou criar um port irmão) para suportar conversa multi-turno com mensagens.
2. Montar contexto da pergunta a partir do transcript da sessão (v1: transcript inteiro se couber; v2: recuperação por trechos — RAG real, cruza com spec 07).
3. Persistir a conversa (mensagens user/assistant) por sessão numa tabela nova.
4. Endpoint `POST /api/sessions/:id/chat` (mensagem + histórico) e `GET` para carregar a conversa.
5. Nova aba **Chat** na UI de detalhe da sessão.

## Como implementar

### 1. Port — método de chat
Adicionar ao `AnalyzerPort` (`packages/core/src/ports/analyzer.ts`) um método opcional, para não quebrar implementações existentes:

```ts
export interface ChatMessage {
	role: "user" | "assistant";
	content: string;
}

export interface ChatOptions {
	transcript: string;        // contexto bruto (ou trechos recuperados na v2)
	messages: ChatMessage[];   // histórico + a nova pergunta no fim
}

export interface AnalyzerPort {
	analyze(options: AnalyzeOptions): Promise<AnalyzeResult>;
	chat?(options: ChatOptions): Promise<AnalyzeResult>; // opcional p/ compatibilidade
	isAvailable(): Promise<boolean>;
	readonly provider: string;
	readonly model: string;
}
```

System prompt dedicado (separado de `ANALYSIS_SYSTEM_PROMPT`, que é de resumo — `analyzer.ts:11`):

```ts
export const CHAT_SYSTEM_PROMPT = `Você é um assistente que responde perguntas SOMENTE com base na transcrição fornecida de um áudio (aula, reunião, podcast). Se a resposta não estiver na transcrição, diga claramente que não foi mencionado. Cite trechos quando útil. Responda em português brasileiro.`;
```

### 2. Adapters
Em `groq-llm.ts` e `ollama.ts`, implementar `chat()` reaproveitando o client de chat já existente. Esqueleto Groq (`adapters/analysis/groq-llm.ts`):

```ts
async chat(options: ChatOptions): Promise<AnalyzeResult> {
	const { CHAT_SYSTEM_PROMPT } = await import("../../ports/analyzer.js");
	const context = `Transcrição da sessão:\n\n${options.transcript}`;
	const response = await this.client.chat.completions.create({
		model: this.model,
		messages: [
			{ role: "system", content: CHAT_SYSTEM_PROMPT },
			{ role: "system", content: context },
			...options.messages,
		],
		temperature: 0.3,
		max_tokens: 1024, // respostas de chat são curtas; protege o TPM (ver comentário em groq-llm.ts:33-36)
	});
	const content = response.choices[0]?.message?.content;
	if (!content) throw new AnalysisError("Groq returned empty response");
	return { content, model: this.model, provider: this.provider, tokensUsed: response.usage?.total_tokens };
}
```

Ollama análogo via `client.chat` com `options: { num_ctx: 8192, num_predict: 1024, temperature: 0.3 }`.

**Trade-off do contexto**: enviar o transcript inteiro a cada turno é caro e estoura janela em aulas longas (mesmo motivo do `max_tokens: 4096` em `groq-llm.ts:33-36`). v1: aceitar transcript inteiro com guard de tamanho; se `transcript.length` exceder um limite (ex.: ~40k chars ≈ 12k tokens) recortar por janela ou exigir a spec 07. v2: indexar segmentos (`TranscriptSegment[]`, `domain/models.ts:34-38`) e fazer retrieval (embeddings locais via Ollama `nomic-embed-text`, ou busca lexical BM25/keyword — mais simples e sem dependência nova). Para a primeira versão, **busca lexical sobre segmentos** (ranqueia segmentos por overlap de termos da pergunta, pega top-N + vizinhos) já entrega RAG "bom o suficiente" sem infra de vetores.

### 3. Persistência — nova tabela
Em `schema.ts` (`packages/core/src/adapters/persistence/schema.ts`):

```ts
export const chatMessages = sqliteTable("chat_messages", {
	id: text("id").primaryKey(),
	sessionId: text("session_id").notNull(),
	role: text("role").notNull(),        // "user" | "assistant"
	content: text("content").notNull(),
	provider: text("provider"),          // null p/ mensagens do usuário
	model: text("model"),
	createdAt: text("created_at").notNull(),
});
```

Migração no método `migrate()` (`sqlite.ts:33-81`) — adicionar o `CREATE TABLE IF NOT EXISTS chat_messages (...)` ao bloco `sqlite.exec`. Métodos novos no `SQLiteRepository` (e no `SessionRepository` port, `packages/core/src/ports/repository.ts`):

```ts
addChatMessage(msg: ChatMessage & { id; sessionId; createdAt; provider?; model? }): void
getChatMessages(sessionId: string): ChatMessageRow[]
clearChatMessages(sessionId: string): void
```

Lembrar de apagar a conversa em `deleteSession` (`sqlite.ts:288-293`) junto com analyses/transcripts/chunks.

### 4. Endpoints (server)
Em `apps/gui/server.ts`, espelhando o bloco de `analyze` (`server.ts:580-639`):

- **`POST /api/sessions/:id/chat`** — body `{ message: string }`. Passos: resolver sessão por prefixo (`server.ts:585-588`), checar `groqApiKey` se Groq for primário (`server.ts:538-544`), exigir transcript (`server.ts:598-605`), carregar `getChatMessages`, persistir a msg do usuário, montar `messages[]`, escolher analyzer/fallback igual ao analyze (`server.ts:607-620`), chamar `analyzer.chat?.(...)` (com fallback para `analyze` se `chat` indefinido), persistir a resposta, devolver `{ reply, messages }`.
- **`GET /api/sessions/:id/chat`** — devolve `getChatMessages(sessionId)`.
- **`DELETE /api/sessions/:id/chat`** — `clearChatMessages`.

A escolha de provider já existe e deve ser reusada (não duplicar): `const groqPrimary = config.analysis.provider === "groq" && groq !== null` (`server.ts:617`).

### 5. UI
- Adicionar `"Chat"` a `const tabs` (`SessionDetailPage.tsx:68`) → `["Transcript", "Analysis", "Chat", "Export"]`. Atenção: a regra de "abas desabilitadas sem transcript" usa o índice (`i > 0 && (!meaningfulTranscript ...)`, `SessionDetailPage.tsx:121-123`) — Chat também deve exigir transcript, então a regra atual já cobre.
- Render do novo `index` no bloco de conteúdo (`SessionDetailPage.tsx:147-207`): novo componente `<ChatPanel sessionId={session.id} />`.
- `ChatPanel`: lista de mensagens (reusar `ReactMarkdown` já importado, `SessionDetailPage.tsx:15`, para respostas do assistant), input + botão enviar, estado de "pensando". Chamadas via `apps/gui/src/shared/lib/api.ts` (novo `api.chat(id, message)` / `api.getChat(id)` seguindo o padrão de `request<T>` em `api.ts:6-17`).
- Store (`apps/gui/src/store/index.ts`): novo state `chatMessages` + actions `sendChatMessage(id, msg)` / `fetchChat(id)`, no mesmo padrão de `analyzeSession`/`deleteAnalysis` (`store/index.ts:271-289`). Carregar a conversa em `fetchSessionDetail`.

## Plano de testes
- **Unit (core)**: `groq-llm.chat` e `ollama.chat` montam `messages[]` na ordem certa (system, contexto, histórico, pergunta); fallback para `analyze` quando `chat` indefinido. `SQLiteRepository`: add/get/clear de `chat_messages`, e `deleteSession` apaga a conversa. Rodar: `pnpm --filter @listening-resume/core exec vitest run src/adapters/analysis/`.
- **Integração (server)**: `POST /api/sessions/:id/chat` sem transcript → 400; com transcript → 200 e persiste 2 mensagens; `GET` retorna histórico; sem GROQ key com Groq primário → 500 com mensagem clara.
- **E2E/manual**: gravar→transcrever→abrir aba Chat→perguntar algo presente no áudio (resposta correta) e algo ausente (modelo diz "não mencionado"). Usar a skill `pipeline-test` até a transcrição, depois exercitar o chat. UI via Playwright MCP em `http://localhost:1420` (adicionar `data-testid="chat-input"` / `chat-send`).

## Riscos / decisões em aberto
- **Tamanho de contexto**: sem a spec 07 (chunking/retrieval), aulas longas estouram a janela ou ficam caras. Decisão: v1 com busca lexical simples sobre segmentos vs. transcript inteiro com guard. Recomendo lexical desde já — barato e sem dependência.
- **Custo/rate limit**: cada turno reenvia contexto → consome TPM Groq (mesma dor de `groq-llm.ts:33-36`). Mitigar com `max_tokens` baixo no chat e retrieval em vez de transcript inteiro.
- **Fidelidade**: modelo pode alucinar fora do transcript; system prompt restritivo ajuda mas não garante. Avaliar citar timestamps dos segmentos recuperados.
- **Privacidade**: chat via Groq manda conteúdo pra nuvem; manter Ollama como caminho 100% local (já é o default, `config/schema.ts:30`).
- **Reuso vs. port novo**: decidir entre estender `AnalyzerPort` (método opcional) ou criar `ChatPort` dedicado. Método opcional é menos código e reaproveita a seleção primário/fallback do server — recomendado.
