# 04 — Busca full-text nas transcrições
> Status: proposta · Esforço: 🟡 · Impacto: descoberta (achar "aquela reunião onde falaram de X" entre dezenas de sessões) · Depende de: nada obrigatório (combina muito bem com #03 auto-título)

## Problema
A única busca existente filtra apenas por **título** e **ID** da sessão, em memória, no front. O conteúdo real — a transcrição — fica inerte num blob de texto no banco. Hoje é impossível encontrar uma sessão pelo que foi dito nela.

## Como está hoje
- Filtro client-side, só title/id: `apps/gui/src/features/sessions/SessionsPage.tsx:11-16`:
  ```ts
  const filtered = sessions.filter((s) =>
    !filter ||
    s.title?.toLowerCase().includes(filter.toLowerCase()) ||
    s.id.includes(filter),
  );
  ```
- A transcrição é guardada como JSON dos segmentos **e** texto plano: `packages/core/src/adapters/persistence/schema.ts:24-33` (`segmentsJson` em `:27`, `fullText` em `:28`). DDL equivalente em `packages/core/src/adapters/persistence/sqlite.ts:54-63`.
- Persistência: `saveTranscript` grava `fullText` em `packages/core/src/adapters/persistence/sqlite.ts:217-231` (linha 226: `fullText: transcript.fullText`). Leitura via `getTranscript` (`:233-250`).
- Análises também têm texto pesquisável (`content`): `schema.ts:35-43` (`content` em `:41`), gravado em `saveAnalysis` (`sqlite.ts:252-265`).
- A migração é "code-first": tudo é `CREATE TABLE IF NOT EXISTS` em `SQLiteRepository.migrate` (`sqlite.ts:33-83`), chamado no construtor (`:26`). Não há versionamento de schema nem tabelas FTS.
- Não há endpoint de busca. Rotas existentes listadas em `apps/gui/server.ts` (sessões em `:328`, `:375`; nenhuma `/api/search`).
- `repo` é um `SQLiteRepository` (`apps/gui/server.ts:67`); o handle bruto `better-sqlite3` é privado (`this.sqlite` em `sqlite.ts:20`), então a busca FTS precisa ser exposta como método no repositório, não acessada de fora.

## O que precisa ser feito
1. Tabela virtual **FTS5** indexando `fullText` das transcrições (e, fase 2, `content` das análises), mantida em sincronia.
2. Método de busca no repositório + endpoint `GET /api/search?q=`.
3. UI de busca global com resultados clicáveis e highlight do trecho casado.

## Como implementar

### 1. Schema / migration — FTS5
`better-sqlite3` traz FTS5 compilado por padrão. Adicionar ao DDL de `SQLiteRepository.migrate` (`packages/core/src/adapters/persistence/sqlite.ts:33`, dentro do mesmo `sqlite.exec`):

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS transcripts_fts USING fts5(
  session_id UNINDEXED,
  full_text,
  tokenize = 'unicode61 remove_diacritics 2'  -- casa "reuniao" com "reunião"
);
```
`remove_diacritics 2` é importante para PT-BR (acentuação). `session_id UNINDEXED` para guardar o FK sem indexá-lo como termo.

**Sincronização** — duas opções:

- **(A) Triggers** mantendo o FTS espelhado da tabela `transcripts` (robusto, cobre updates/deletes feitos por qualquer caminho):
  ```sql
  CREATE TRIGGER IF NOT EXISTS transcripts_ai AFTER INSERT ON transcripts BEGIN
    INSERT INTO transcripts_fts(rowid, session_id, full_text) VALUES (new.rowid, new.session_id, new.full_text);
  END;
  CREATE TRIGGER IF NOT EXISTS transcripts_ad AFTER DELETE ON transcripts BEGIN
    INSERT INTO transcripts_fts(transcripts_fts, rowid, session_id, full_text) VALUES('delete', old.rowid, old.session_id, old.full_text);
  END;
  CREATE TRIGGER IF NOT EXISTS transcripts_au AFTER UPDATE ON transcripts BEGIN
    INSERT INTO transcripts_fts(transcripts_fts, rowid, session_id, full_text) VALUES('delete', old.rowid, old.session_id, old.full_text);
    INSERT INTO transcripts_fts(rowid, session_id, full_text) VALUES (new.rowid, new.session_id, new.full_text);
  END;
  ```
- **(B) Escrita explícita** dentro de `saveTranscript` (`sqlite.ts:217`) e `deleteSession` (`sqlite.ts:288-293`). Mais simples de raciocinar, mas tem que lembrar de cada ponto.

**Recomendação: (A) triggers** — cobre `deleteSession` (que dá `DELETE FROM transcripts` em `sqlite.ts:290`) automaticamente.

**Backfill** (banco de usuários existentes já tem transcrições): após criar a virtual table, popular uma vez se vazia. Como não há versionamento, usar uma checagem idempotente no construtor:
```ts
const ftsCount = (this.sqlite.prepare("SELECT count(*) c FROM transcripts_fts").get() as { c: number }).c;
const trCount = (this.sqlite.prepare("SELECT count(*) c FROM transcripts").get() as { c: number }).c;
if (ftsCount === 0 && trCount > 0) {
  this.sqlite.exec(`INSERT INTO transcripts_fts(rowid, session_id, full_text)
    SELECT rowid, session_id, full_text FROM transcripts WHERE full_text IS NOT NULL;`);
}
```
Rodar isso em `migrate` **depois** de criar as tabelas e triggers.

### 2. Método de busca no repositório + porta
**Porta** — `packages/core/src/ports/repository.ts:3` (interface `SessionRepository`). Adicionar:
```ts
searchTranscripts(query: string, limit?: number): SearchHit[];
```
com tipo novo (no mesmo arquivo ou em `domain/models.ts`):
```ts
export interface SearchHit { sessionId: string; snippet: string; rank: number; }
```

**Implementação** em `packages/core/src/adapters/persistence/sqlite.ts` (junto dos outros métodos, ex. depois de `getTranscript` em `:250`):
```ts
searchTranscripts(query: string, limit = 50): SearchHit[] {
  const q = sanitizeFtsQuery(query);
  if (!q) return [];
  const rows = this.sqlite.prepare(`
    SELECT session_id AS sessionId,
           snippet(transcripts_fts, 1, '[', ']', ' … ', 12) AS snippet,
           rank
    FROM transcripts_fts
    WHERE transcripts_fts MATCH ?
    ORDER BY rank
    LIMIT ?`).all(q, limit) as SearchHit[];
  return rows;
}
```
`snippet()` é a função nativa do FTS5 (gera o trecho com marcadores `[`...`]` para highlight). `sanitizeFtsQuery` deve escapar a sintaxe FTS para evitar erro de parse quando o usuário digita aspas/operadores — tratar o input como busca por prefixo das palavras:
```ts
function sanitizeFtsQuery(raw: string): string {
  const terms = raw.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (!terms || terms.length === 0) return "";
  return terms.map((t) => `"${t}"*`).join(" "); // AND implícito + prefixo
}
```

**Endpoint** — `apps/gui/server.ts`, adicionar perto de `GET /api/sessions` (`:327`):
```ts
// GET /api/search?q=...  — full-text nas transcrições
if (route === "/api/search" && req.method === "GET") {
  const q = (url.searchParams.get("q") ?? "").trim();
  if (!q) return json(res, { results: [] });
  const limit = Number(url.searchParams.get("limit") ?? 50);
  const hits = repo.searchTranscripts(q, limit);
  // enriquecer com metadados de sessão p/ a UI (reusa repo.getSession)
  const results = hits
    .map((h) => {
      const s = repo.getSession(h.sessionId);
      if (!s) return null;
      return {
        sessionId: s.id,
        title: s.title,
        status: s.status,
        startedAt: s.startedAt ?? s.createdAt,
        snippet: h.snippet,
      };
    })
    .filter(Boolean);
  return json(res, { results });
}
```

### 3. UI
**Client** — `apps/gui/src/shared/lib/api.ts` (`export const api`, `:65`):
```ts
async search(q: string): Promise<SearchResult[]> {
  const data = await request<{ results: SearchResult[] }>(`/search?q=${encodeURIComponent(q)}`);
  return data.results;
},
```
com `export interface SearchResult { sessionId: string; title: string | null; status: string; startedAt: string | null; snippet: string; }`.

**Store** — `apps/gui/src/store/index.ts`. Há um `searchQuery`/`setSearchQuery` no estado (`:52-53`) hoje **só de UI**; reaproveitar/estender. Adicionar `searchResults: SearchResult[]` e `runSearch: (q: string) => Promise<void>` com debounce no componente.

**SessionsPage** — `apps/gui/src/features/sessions/SessionsPage.tsx`:
- Manter o `<Input>` de busca (`:25-30`), mas quando o termo tiver ≥ 2 chars, disparar `runSearch` (debounce ~250ms).
- Renderizar dois modos: termo vazio → lista normal (`sessions.filter` atual, `:11`); termo preenchido → lista de `searchResults`, cada item um `Card` com título (ou fallback `Session <id8>`, igual `:44`), `Badge` de status e o `snippet`. Clique → `selectSession(r.sessionId)`.
- Highlight: o `snippet` vem com `[`...`]`; renderizar quebrando nesses marcadores e envolvendo em `<mark>` (ou `<span class="bg-accent/30">`). Sanitizar para não injetar HTML (split por marcador, nunca `dangerouslySetInnerHTML`).
- Considerar mover a busca para o Sidebar como "busca global" (`apps/gui/src/features/navigation/Sidebar.tsx`) numa fase 2; MVP fica na SessionsPage.

### Fase 2 (opcional) — incluir análises
Segunda virtual table `analyses_fts` sobre `analyses.content` (`schema.ts:41`) com triggers análogas, e a busca faz `UNION` rotulando a origem (`source: "transcript" | "analysis"`). Útil porque as análises são mais densas/resumidas que a transcrição crua.

## Plano de testes
- **Unit (core)**: `SQLiteRepository.searchTranscripts` em DB tmp — inserir 2-3 transcrições, buscar termo presente (acha, snippet contém marcador), termo ausente (vazio), termo acentuado vs sem acento (`reunião`/`reuniao` casam por `remove_diacritics`), input com aspas/operador FTS não derruba a query (sanitização). `deleteSession` remove do índice (busca depois retorna vazio).
- **Migração/backfill**: abrir DB legado (com transcrições, sem `transcripts_fts`), construir o repo, confirmar que o backfill popula o índice e a busca funciona de primeira.
- **Integração endpoint**: `GET /api/search?q=foo` → 200 com `results`; `q` vazio → `results: []`.
- **UI (Playwright MCP, http://localhost:1420)**: digitar termo no input de busca da SessionsPage, ver resultados com snippet, clicar e cair no detalhe correto (`session-card` / `session-back-button`).

## Riscos / decisões em aberto
- **Sem versionamento de schema**: o projeto usa `CREATE ... IF NOT EXISTS` idempotente (`sqlite.ts:33`). FTS5 + triggers + backfill cabem nesse modelo, mas se um dia migrar para Drizzle migrations isso precisa ser reconciliado. Decisão: manter o padrão atual (idempotente no construtor).
- **Disponibilidade do FTS5**: depende do prebuild de `better-sqlite3` empacotado (CLAUDE.md alerta sobre ABI/prebuild). FTS5 vem ligado nos prebuilds oficiais, mas o `smoke:server` deve passar a exercitar uma query FTS para detectar um build sem FTS5 antes de empacotar (build gate em `build:windows`/`build:linux`).
- **Tamanho do índice**: duplica o `fullText` no arquivo .db. Para horas de transcrição é aceitável; documentar.
- **Idioma do tokenizer**: `unicode61` não faz stemming (buscar "reuniões" não acha "reunião"). Aceitável no MVP; o prefixo `*` na sanitização cobre parte disso. Stemming real exigiria tokenizer custom (fora de escopo).
- **`snippet()` e marcadores `[ ]`**: se a transcrição contiver literalmente `[`/`]`, o highlight pode confundir. Risco baixo; alternativa é usar delimitadores improváveis (ex. ``/``) e trocar por `<mark>` no front.
