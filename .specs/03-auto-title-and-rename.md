# 03 — Auto-título e renomear sessão
> Status: proposta · Esforço: 🟢 · Impacto: UX (sessões viram itens reconhecíveis em vez de "Session a1b2c3d4") · Depende de: nada (infra de `updateSession` já existe)

## Problema
Toda sessão nasce com `title = null` e nunca é preenchido. Na UI a lista mostra `Session <id8>` (os 8 primeiros chars do UUID), tanto na listagem quanto no detalhe. O usuário não consegue distinguir uma reunião de uma aula sem abrir cada uma. Também não há nenhuma forma de renomear manualmente.

## Como está hoje
- O modelo já tem o campo, mas ninguém escreve nele: `packages/core/src/domain/models.ts:15` (`title: string | null;`).
- Coluna existe na tabela: `packages/core/src/adapters/persistence/schema.ts:5` (`title: text("title")`) e no DDL de migração `packages/core/src/adapters/persistence/sqlite.ts:37`.
- O repositório **já sabe atualizar título** — `updateSession` mapeia `data.title`: `packages/core/src/adapters/persistence/sqlite.ts:137-147` (linha 139: `if (data.title !== undefined) mapped.title = data.title;`).
- **Não existe endpoint** de update de sessão. Os endpoints de sessão no server são apenas: `GET /api/sessions` (`apps/gui/server.ts:328`), `GET /api/sessions/:id` (`apps/gui/server.ts:375`), `POST .../transcribe` (`:528`), `POST .../analyze` (`:580`), `GET .../audio` (`:648`), `.../play` (`:724`/`:870`), `.../export` (`:1094`/`:1118`), `DELETE /api/sessions/:id` (`apps/gui/server.ts:1189-1207`). Não há PUT/PATCH.
- Onde o título é renderizado (fallback hardcoded):
  - Lista: `apps/gui/src/features/sessions/SessionsPage.tsx:44` → `{session.title ?? \`Session ${session.id.slice(0, 8)}\`}`.
  - Detalhe: `apps/gui/src/features/sessions/SessionDetailPage.tsx:86` → mesmo padrão.
- Store (zustand) não tem ação de rename: `apps/gui/src/store/index.ts:43-63` (só `fetchSessions`, `deleteSession`, etc.).
- Client API não tem método de rename: `apps/gui/src/shared/lib/api.ts:65+` (`api.getSessions`, `api.getSession`, ...). `SessionData.title` já é tipado em `:28`.
- Geração automática nunca é disparada. O fluxo de análise termina em `apps/gui/server.ts:636` (`repo.updateSession(session.id, { status: "completed" })`) sem tocar no título. O transcript com `fullText`/`segments` está disponível via `repo.getTranscript(session.id)` (`apps/gui/server.ts:598`).

## O que precisa ser feito
1. Endpoint para atualizar título manualmente.
2. UI de renomear (edição inline no header do detalhe; opcionalmente na lista).
3. Geração automática de título quando a sessão recebe a 1ª transcrição/análise, sem sobrescrever um título já definido pelo usuário.

## Como implementar

### 1. Endpoint — `PATCH /api/sessions/:id`
`updateSession` já existe; só falta expor. Em `apps/gui/server.ts`, adicionar antes do `DELETE /api/sessions/:id` (`:1189`):

```ts
// PATCH /api/sessions/:id — rename / edit metadata
if (route.match(/^\/api\/sessions\/[^/]+$/) && req.method === "PATCH") {
  const id = route.split("/")[3];
  const sessions = repo.listSessions(200);
  const session = sessions.find((s) => s.id.startsWith(id!)); // mantém suporte a id parcial, igual aos outros handlers
  if (!session) return json(res, { error: "Session not found" }, 404);

  const body = await readBody(req);
  const { title } = body ? JSON.parse(body) : {};
  if (typeof title !== "string" || title.trim().length === 0) {
    return json(res, { error: "title is required" }, 400);
  }
  const clean = title.trim().slice(0, 200);
  repo.updateSession(session.id, { title: clean });
  return json(res, { ok: true, title: clean });
}
```
Observações:
- O webview instalado roda em `http://tauri.localhost`; este endpoint não mexe em config sensível, então não precisa do origin-guard que protege `/api/config/groq-key`. Mas se houver um guard genérico de CORS/origin no início do handler, confirmar que `PATCH` está liberado (checar topo de `apps/gui/server.ts`).
- `PATCH` precisa ser aceito pelo proxy do Vite (porta 1420 → 3456); o proxy padrão repassa qualquer método, então sem mudança.

### 2. Geração automática de título
Estratégia em camadas (barata → cara), aplicada **somente se `session.title` for null/vazio** para nunca sobrescrever rename manual:

- (a) Heurística grátis: primeira frase "significativa" do transcript (reusando a lista `silenceArtifacts` que já existe em `apps/gui/server.ts:338-347`), truncada a ~60 chars.
- (b) Opcional/melhor: chamada LLM curta usando o adapter já instanciado no fluxo de análise (`GroqLLMAdapter` em `packages/core/src/adapters/analysis/groq-llm.ts:5`, construtor `(apiKey, model)` em `:10`, método `analyze(options)` em `:15`). Como `analyze` é template-driven, o caminho mais limpo é **não** reusar `analyze` e sim adicionar um helper dedicado.

**Recomendação:** começar por (a) e disparar no fim do `analyze` e/ou no fim do `transcribe`. Ponto de inserção no analyze, logo após `repo.updateSession(session.id, { status: "completed" })` (`apps/gui/server.ts:636`):

```ts
maybeAutoTitle(session.id); // best-effort, não bloqueia a resposta
```

Helper novo em `apps/gui/server.ts` (perto de `getAudioDuration`):

```ts
const SILENCE_ARTIFACTS = ["thank you.", "thanks for watching.", "bye.", "you", "thanks.", "thank you for watching.", "off", "off."];

function deriveTitleFromTranscript(sessionId: string): string | null {
  const t = repo.getTranscript(sessionId);
  if (!t || t.segments.length === 0) return null;
  const first = t.segments
    .map((s) => s.text.trim())
    .find((txt) => txt && !SILENCE_ARTIFACTS.includes(txt.toLowerCase()));
  if (!first) return null;
  // primeira frase ou 60 chars
  const sentence = first.split(/(?<=[.!?])\s/)[0] ?? first;
  return sentence.slice(0, 60).trim();
}

function maybeAutoTitle(sessionId: string): void {
  const s = repo.getSession(sessionId);
  if (!s || (s.title && s.title.trim())) return; // respeita título manual
  const title = deriveTitleFromTranscript(sessionId);
  if (title) repo.updateSession(sessionId, { title });
}
```
Refatorar `SILENCE_ARTIFACTS` para uma constante única reaproveitada pelo `preview` de `GET /api/sessions` (hoje duplicada em `apps/gui/server.ts:338`).

**Variante LLM (b)** — adicionar método ao adapter para não abusar do `analyze`:
- Em `packages/core/src/adapters/analysis/groq-llm.ts`, novo método `async summarizeTitle(text: string): Promise<string>` que manda um system prompt curto ("Gere um título de até 6 palavras, sem aspas, no idioma do texto") + os primeiros ~2000 chars de `text`. Reusar o cliente HTTP/fetch já presente no `analyze`.
- Chamar em `maybeAutoTitle` quando `config.analysis.provider === "groq"` e `groqApiKey` existir (mesma checagem do analyze em `apps/gui/server.ts:608-617`); cair na heurística (a) em qualquer erro. Manter best-effort com try/catch para nunca quebrar o fluxo de análise.

### 3. UI

**Client** — `apps/gui/src/shared/lib/api.ts`, dentro de `export const api = {` (`:65`):
```ts
async renameSession(id: string, title: string): Promise<{ title: string }> {
  return request(`/sessions/${id}`, { method: "PATCH", body: JSON.stringify({ title }) });
},
```

**Store** — `apps/gui/src/store/index.ts`. Adicionar à interface (`AppState`, perto de `:63`) `renameSession: (id: string, title: string) => Promise<void>;` e a implementação (perto de `deleteSession` em `:296`):
```ts
renameSession: async (id, title) => {
  await api.renameSession(id, title);
  // otimista: atualiza lista em memória sem refetch completo
  set((st) => ({
    sessions: st.sessions.map((s) => (s.id === id ? { ...s, title } : s)),
  }));
  if (get().selectedSessionId === id) await get().fetchSessionDetail(id);
},
```

**SessionDetailPage** — `apps/gui/src/features/sessions/SessionDetailPage.tsx:83-94`. Trocar o `<h1>` por um título editável: clique (ou um ícone de lápis `Pencil` de `lucide-react`, já usado o `Trash2` em `:13`) ativa um `<input>` controlado; `Enter`/blur chama `renameSession(session.id, value)`, `Esc` cancela. Estado local `const [editingTitle, setEditingTitle] = useState(false)`. Manter o fallback `Session <id8>` como placeholder do input quando vazio. Adicionar `data-testid="session-title-input"` e `aria-label="Renomear sessão"` (convenção de testids do projeto, ver CLAUDE.md).

**SessionsPage (opcional)** — `apps/gui/src/features/sessions/SessionsPage.tsx:44`. Renomear inline na lista é redundante com o detalhe; deixar fora do MVP. O filtro de busca em `:11-16` já casa por `title`, então títulos automáticos passam a melhorar a busca de graça.

### Mudanças de schema/migration
Nenhuma. Coluna `title` já existe (`schema.ts:5`, DDL `sqlite.ts:37`). Sem migração nova.

## Plano de testes
- **Unit (core)** `packages/core`: teste de `SQLiteRepository.updateSession({ title })` persistindo e lendo de volta via `getSession` (DB em memória/tmp). Se implementar `summarizeTitle`, testar parsing/trim do retorno com fetch mockado.
- **Integração endpoint**: `PATCH /api/sessions/:id` → 200 + título persistido; título vazio → 400; id inexistente → 404; id parcial resolve a sessão certa.
- **Auto-título**: criar sessão + transcript fixture, rodar `maybeAutoTitle`, esperar título derivado da 1ª frase significativa (ignorando artefatos de silêncio); rodar 2x não deve sobrescrever título manual previamente setado.
- **UI (Playwright MCP, http://localhost:1420)**: abrir detalhe, editar via `session-title-input`, salvar, voltar e confirmar que o `session-card` mostra o novo título. Usar os testids já existentes (`session-card`, `session-back-button`).

## Riscos / decisões em aberto
- **Qualidade do título heurístico**: a 1ª frase de uma transcrição costuma ser ruído ("ok, então...", "alô, tá me ouvindo?"). A variante LLM dá títulos melhores mas custa quota Groq (rate-limit em `utils/rate-limiter`). Decisão: heurística como default, LLM como opção de config.
- **Quando disparar o auto-título**: no transcribe (mais cedo, sem custo LLM) ou no analyze (texto completo). Proposta: disparar no analyze; opcionalmente também ao final do transcribe se ainda null.
- **Concorrência**: `maybeAutoTitle` é best-effort fire-and-forget; se rodar logo após `status=completed`, a resposta do analyze pode chegar à UI antes do título. O refetch no `renameSession`/`fetchSessions` resolve, mas o título auto pode aparecer só no próximo `fetchSessions`. Aceitável; alternativa é aguardar o auto-título antes de responder o analyze (custa latência).
- **Idioma**: o prompt LLM precisa pedir o título no idioma do conteúdo (sessões podem ser PT/EN) — `session.language` pode ser `"auto"`, então melhor instruir "no mesmo idioma do texto".
