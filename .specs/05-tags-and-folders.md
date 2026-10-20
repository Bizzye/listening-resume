# 05 — Tags e pastas/categorias para organizar sessões
> Status: proposta · Esforço: 🟡 · Impacto: organização (filtrar/agrupar dezenas de sessões por contexto — trabalho, faculdade, podcast) · Depende de: nada obrigatório; combina com #03 (auto-título) e #04 (busca). Auto-tag por template depende de existir o vínculo template→sessão.

## Problema
Não existe nenhum metadado de organização. Conforme o volume de sessões cresce, a única dimensão é a ordem cronológica. Não dá para agrupar "reuniões do projeto X", separar "aulas" de "podcasts", nem filtrar por contexto.

## Como está hoje
- O schema só tem as 5 tabelas de pipeline (`sessions`, `audio_chunks`, `transcripts`, `analyses`, `analysis_templates`): `packages/core/src/adapters/persistence/schema.ts:3-52`. **Nenhuma** coluna/tabela de tag, pasta, categoria ou cor.
- `Session` no domínio não tem nada de organização: `packages/core/src/domain/models.ts:13-22`.
- `listSessions` faz um `SELECT * ... LIMIT` simples, sem joins nem filtro: `packages/core/src/adapters/persistence/sqlite.ts:164-176`.
- A listagem da API enriquece com chunks/duration/preview e ordena por data, mas não tem dimensão de organização: `apps/gui/server.ts:328-372` (note `repo.listSessions(limit)` em `:330`).
- `deleteSession` apaga em cascata manual (analyses → transcripts → chunks → session): `packages/core/src/adapters/persistence/sqlite.ts:288-293`. Qualquer tabela nova de join precisa ser limpa aqui também.
- UI: o filtro da SessionsPage é só title/id (`apps/gui/src/features/sessions/SessionsPage.tsx:11-16`); o Sidebar tem navegação fixa por View, sem seção de pastas/tags: `apps/gui/src/features/navigation/Sidebar.tsx:12-17` e render `:45-61`.
- A relação template→sessão **não é persistida na sessão**: a análise guarda `templateId` (`schema.ts:38`, `models.ts:54`), então auto-tag por template é viável lendo `repo.getAnalyses(sessionId)` (`sqlite.ts:267`).

## O que precisa ser feito
1. Modelo de dados para **tags** (M:N) e, opcionalmente, **pasta/categoria** (1:N, exclusiva).
2. CRUD de tags + atribuição/remoção em sessão; endpoints REST.
3. Filtro por tag/pasta na UI + navegação no Sidebar.
4. (Fase 2) auto-tag por template usado ou por conteúdo.

## Modelagem — decisão
**Tags (M:N)** como recurso principal: flexível, uma sessão pode ter várias ("trabalho", "projeto-x", "urgente"). **Pasta** seria 1:N exclusiva; dá para emular com uma tag especial, então o MVP entrega só tags e deixa "pasta" como açúcar opcional depois. Esta spec implementa **tags**.

## Como implementar

### 1. Schema / migration
Adicionar em `packages/core/src/adapters/persistence/schema.ts`:
```ts
export const tags = sqliteTable("tags", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),       // único (case-insensitive) — ver índice abaixo
  color: text("color"),               // ex. "#7c3aed" p/ o Badge
  createdAt: text("created_at").notNull(),
});

export const sessionTags = sqliteTable("session_tags", {
  sessionId: text("session_id").notNull(),
  tagId: text("tag_id").notNull(),
}); // PK composta criada no DDL
```
E no DDL idempotente de `SQLiteRepository.migrate` (`packages/core/src/adapters/persistence/sqlite.ts:33`, mesmo `sqlite.exec`):
```sql
CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_name ON tags(lower(name));
CREATE TABLE IF NOT EXISTS session_tags (
  session_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  PRIMARY KEY (session_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_session_tags_tag ON session_tags(tag_id);
```
Sem versionamento de schema — segue o padrão `IF NOT EXISTS` já usado em todo o `migrate` (`sqlite.ts:35-80`). Banco legado ganha as tabelas vazias automaticamente.

### 2. Domínio + porta + repositório
**Domínio** — `packages/core/src/domain/models.ts`:
```ts
export interface Tag { id: string; name: string; color: string | null; createdAt: string; }
```
Opcional: estender `Session` com `tags?: Tag[]` quando enriquecido (manter o `Session` cru sem isso para não quebrar os mappers existentes em `sqlite.ts:152-161`/`:166-175`).

**Porta** — `packages/core/src/ports/repository.ts:3` (`SessionRepository`), adicionar:
```ts
listTags(): Tag[];
createTag(data: { id: string; name: string; color?: string | null }): Tag;
deleteTag(id: string): void;
getSessionTags(sessionId: string): Tag[];
setSessionTags(sessionId: string, tagIds: string[]): void; // substitui o conjunto
listSessionsByTag(tagId: string, limit?: number): Session[];
```

**Implementação** — `packages/core/src/adapters/persistence/sqlite.ts` (junto dos demais; reusar `this.db` Drizzle e `eq`/`and`/`inArray` de `drizzle-orm`):
```ts
listTags(): Tag[] {
  return this.db.select().from(schema.tags).all().map((r) => ({
    id: r.id, name: r.name, color: r.color, createdAt: r.createdAt,
  }));
}
createTag(data) {
  const now = new Date().toISOString();
  this.db.insert(schema.tags).values({ id: data.id, name: data.name, color: data.color ?? null, createdAt: now }).run();
  return { id: data.id, name: data.name, color: data.color ?? null, createdAt: now };
}
deleteTag(id) {
  this.db.delete(schema.sessionTags).where(eq(schema.sessionTags.tagId, id)).run();
  this.db.delete(schema.tags).where(eq(schema.tags.id, id)).run();
}
getSessionTags(sessionId) {
  // join session_tags -> tags
  const rows = this.db.select(...).from(schema.sessionTags)
    .innerJoin(schema.tags, eq(schema.sessionTags.tagId, schema.tags.id))
    .where(eq(schema.sessionTags.sessionId, sessionId)).all();
  return rows.map(...);
}
setSessionTags(sessionId, tagIds) {
  this.db.delete(schema.sessionTags).where(eq(schema.sessionTags.sessionId, sessionId)).run();
  for (const tagId of tagIds)
    this.db.insert(schema.sessionTags).values({ sessionId, tagId }).run();
}
listSessionsByTag(tagId, limit = 50) {
  const ids = this.db.select({ id: schema.sessionTags.sessionId })
    .from(schema.sessionTags).where(eq(schema.sessionTags.tagId, tagId)).all().map((r) => r.id);
  if (ids.length === 0) return [];
  const rows = this.db.select().from(schema.sessions)
    .where(inArray(schema.sessions.id, ids)).limit(limit).all();
  return rows.map(/* mesmo mapper de listSessions, sqlite.ts:166-175 */);
}
```
**Importante:** atualizar `deleteSession` (`sqlite.ts:288-293`) para também limpar o join:
```ts
this.db.delete(schema.sessionTags).where(eq(schema.sessionTags.sessionId, id)).run();
```
(adicionar antes do delete de `sessions` na linha `:292`).

### 3. Endpoints — `apps/gui/server.ts`
Adicionar perto dos handlers de sessão (após `GET /api/sessions`, `:372`):

| Método | Rota | Ação |
|--------|------|------|
| GET | `/api/tags` | `repo.listTags()` |
| POST | `/api/tags` | body `{ name, color? }` → `repo.createTag({ id: uuid(), name, color })`; 409 se nome duplicado (capturar erro do índice único) |
| DELETE | `/api/tags/:id` | `repo.deleteTag(id)` |
| GET | `/api/sessions/:id/tags` | `repo.getSessionTags(id)` |
| PUT | `/api/sessions/:id/tags` | body `{ tagIds: string[] }` → `repo.setSessionTags(id, tagIds)` |

Esboço do POST (uuid já é dep do core; no server importar/gerar id):
```ts
if (route === "/api/tags" && req.method === "POST") {
  const body = await readBody(req);
  const { name, color } = body ? JSON.parse(body) : {};
  if (typeof name !== "string" || !name.trim()) return json(res, { error: "name required" }, 400);
  try {
    const tag = repo.createTag({ id: randomUUID(), name: name.trim(), color: color ?? null });
    return json(res, { tag });
  } catch {
    return json(res, { error: "Tag already exists" }, 409);
  }
}
```
PUT de tags de sessão usa o mesmo padrão de resolução por id parcial dos outros handlers (`sessions.find((s) => s.id.startsWith(id))`, ver `apps/gui/server.ts:385`/`:587`).

Enriquecer a listagem: em `GET /api/sessions` (`apps/gui/server.ts:332-364`), adicionar `tags: repo.getSessionTags(s.id)` ao objeto enriquecido (linha `:358-363`). Aceitar `?tag=<id>` para filtrar via `repo.listSessionsByTag` (ou filtrar o enriquecido em memória se o volume for pequeno).

### 4. UI
**Client** — `apps/gui/src/shared/lib/api.ts` (`api`, `:65`): `getTags`, `createTag`, `deleteTag`, `getSessionTags`, `setSessionTags`. Adicionar `tags: TagData[]` a `SessionData` (`:26-38`).

**Store** — `apps/gui/src/store/index.ts`: estado `tags: TagData[]`, `activeTagFilter: string | null`; ações `fetchTags`, `createTag`, `deleteTag`, `setSessionTags`, `setTagFilter`. Padrão idêntico ao já existente para templates (`fetchTemplates`/`createTemplate`/`deleteTemplate`, `apps/gui/src/store/index.ts:65-73`).

**SessionsPage** — `apps/gui/src/features/sessions/SessionsPage.tsx`:
- Barra de chips de tags acima da lista; clicar num chip ativa `activeTagFilter`. Estender o `filtered` (`:11-16`) para também filtrar por `s.tags?.some((t) => t.id === activeTagFilter)` (ou trocar para a lista filtrada vinda do servidor via `?tag=`).
- Em cada `Card` (`:34-59`), renderizar os `Badge`/chips das tags da sessão ao lado do status (`Badge` já é importado, `:2`; usar a `color` da tag para o fundo).

**SessionDetailPage** — `apps/gui/src/features/sessions/SessionDetailPage.tsx:83-94` (header): adicionar um seletor de tags (multi-select / popover com checkbox por tag + campo "nova tag"). Salvar via `setSessionTags(session.id, ids)`. Reusar o padrão de modal já presente (`ConfirmModal`, `:104`).

**Sidebar** — `apps/gui/src/features/navigation/Sidebar.tsx`: o Sidebar atual é uma coluna estreita de ícones (`:23` `w-16`). Fase 1: nada. Fase 2: ao clicar em "Sessions", abrir uma sub-lista de tags como atalhos de filtro (exige repensar o layout estreito — fora do MVP).

### Fase 2 — auto-tag
- **Por template**: ao finalizar o analyze (`apps/gui/server.ts:636`), mapear `template.id`/`template.name` → tag (ex. template "meeting-summary" → tag "reunião"). Criar a tag se não existir e atribuir via `setSessionTags` (mesclar com as existentes).
- **Por conteúdo**: prompt LLM curto (reusando `GroqLLMAdapter`, ver spec #03) sugerindo 1-3 tags a partir do `fullText`; usuário confirma. Mais caro; deixar opt-in.

## Plano de testes
- **Unit (core)**: CRUD de tags (criar, listar, nome duplicado falha pelo índice único, deletar remove vínculos); `setSessionTags` substitui o conjunto; `listSessionsByTag` retorna só as sessões certas; `deleteSession` remove linhas de `session_tags` (sem órfãos); `deleteTag` desvincula de todas as sessões.
- **Migração**: abrir DB legado (sem `tags`/`session_tags`), construir o repo, confirmar tabelas criadas e operáveis.
- **Integração endpoints**: matriz dos 5 endpoints — criar tag, atribuir a sessão, listar sessões com `?tag=`, remover tag (some das sessões), nome duplicado → 409.
- **UI (Playwright MCP, http://localhost:1420)**: criar tag no detalhe, atribuir, voltar e filtrar por chip na SessionsPage; confirmar que o `session-card` exibe a tag. Adicionar testids (`tag-chip`, `tag-filter`, `session-tags-select`) seguindo a convenção do projeto.

## Riscos / decisões em aberto
- **Tags vs pastas**: esta spec faz tags (M:N). Se o usuário quiser hierarquia/exclusividade real (uma pasta por sessão), precisa de coluna `folder_id` em `sessions` (1:N) — decisão adiada; tags cobrem 90% do caso.
- **Sem versionamento de schema** (igual #04): tabelas novas via `IF NOT EXISTS` no construtor; reconciliar se migrar para migrations gerenciadas.
- **Sidebar estreito**: o layout de ícones (`w-16`, `Sidebar.tsx:23`) não comporta uma árvore de tags sem redesenho. Filtro por chips na SessionsPage é o caminho de menor atrito no MVP.
- **Cascade**: SQLite aqui não usa FK constraints (deletes são manuais em `deleteSession`). É obrigatório lembrar de limpar `session_tags` em `deleteSession` e `deleteTag`, senão ficam vínculos órfãos. Coberto no plano de testes.
- **Cor/UX das tags**: definir paleta fixa vs cor livre. Sugestão: paleta pré-definida (consistência visual com o `Badge` existente).
- **Normalização de nome**: índice `lower(name)` evita "Trabalho"/"trabalho" duplicados; o POST deve devolver 409 amigável (já previsto).
