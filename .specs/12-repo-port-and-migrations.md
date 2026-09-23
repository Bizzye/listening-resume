# 12 — Completar o port do repositório + adotar migrations versionadas

> Status: proposta · Esforço: 🟡 · Impacto: repositório realmente trocável (testes com fake in-memory, futuro Postgres/Turso); evolução de schema sem corromper o DB de usuários em produção · Depende de: nada (mas a parte (a) facilita muito os testes da spec 10)

## Problema

### (a) O port do repositório está incompleto — o repo não é trocável

`SQLiteRepository` implementa métodos que **não existem** na interface `SessionRepository`. O GUI server chama esses métodos extras direto no objeto concreto, então qualquer tentativa de injetar outra implementação (um fake de teste, um adapter Postgres) quebra em runtime, e o TypeScript não acusa porque o server tipou `repo` como o concreto. A premissa hexagonal ("adapters são intercambiáveis pela porta") está furada.

Métodos no concreto e ausentes no port:
- Templates: `listTemplates`, `getTemplate`, `createTemplate`, `updateTemplate`, `deleteTemplate`.
- `deleteAnalysis`.

### (b) Schema sem migrations versionadas

O schema é **SQL inline** executado no construtor via `migrate()`, com `CREATE TABLE IF NOT EXISTS`. Isso cobre a criação inicial, mas **não há mecanismo de evolução**: adicionar uma coluna (ex: `sessions.duration_ms`, `transcripts.duration`, ou `analyses.template_snapshot` que a spec 13 vai querer) num DB já existente de usuário não acontece — `IF NOT EXISTS` não altera tabela existente. Mudar schema em produção hoje = corromper ou ignorar silenciosamente o DB do usuário. O projeto já tem `drizzle-orm` e o `schema.ts` Drizzle, mas **não tem Drizzle Kit nem `drizzle.config.ts`** (confirmado: nenhum `drizzle.config.*` no repo, e `drizzle-kit` não está nas devDependencies do core).

## Como está hoje

### Port — `packages/core/src/ports/repository.ts:3-20`

```ts
export interface SessionRepository {
  createSession(session: Session): void;
  updateSession(id: string, data: Partial<Session>): void;
  getSession(id: string): Session | null;
  listSessions(limit?: number): Session[];
  addChunk(chunk: AudioChunk): void;
  updateChunk(id: string, data: Partial<AudioChunk>): void;
  getChunks(sessionId: string): AudioChunk[];
  saveTranscript(transcript: Transcript): void;
  getTranscript(sessionId: string): Transcript | null;
  saveAnalysis(analysis: Analysis): void;
  getAnalyses(sessionId: string): Analysis[];
  deleteSession(id: string): void;
}
```

Faltam `deleteAnalysis` e os 5 de template.

### Concreto — `packages/core/src/adapters/persistence/sqlite.ts`

- `deleteAnalysis(id)`: `sqlite.ts:284-286`.
- `listTemplates()`: `sqlite.ts:297-307`.
- `getTemplate(id)`: `sqlite.ts:309-324` (retorna `AnalysisTemplate | undefined`).
- `createTemplate(data)`: `sqlite.ts:326-342`.
- `updateTemplate(id, data)`: `sqlite.ts:344-360`.
- `deleteTemplate(id)`: `sqlite.ts:362-368` (retorna `boolean`).

Esses tipos vêm de `AnalysisTemplate` em `packages/core/src/ports/analyzer.ts:1-8`.

### Uso no server (prova de que o concreto vaza)

`repo.getTemplate(...)` em `server.ts:592` e `961`; `repo.listTemplates()` em `911`; `repo.createTemplate(...)` em `934`; `repo.updateTemplate(...)` em `953`; `repo.deleteTemplate(...)` em `966`; `repo.deleteAnalysis(...)` em `644`. Tudo isso só compila porque `repo` é `new SQLiteRepository(...)` (`server.ts:67`), tipado como o concreto.

### Migração — `sqlite.ts:22-83`

Construtor abre o DB, seta WAL, chama `migrate()` que faz um `exec()` com os 5 `CREATE TABLE IF NOT EXISTS` e depois `seedBuiltinTemplates()` (`sqlite.ts:85-119`). O Drizzle schema declarativo está em `packages/core/src/adapters/persistence/schema.ts:1-52` — **mas nunca é usado para gerar/aplicar migrations**, só para as queries tipadas.

### Deps — `packages/core/package.json`

`drizzle-orm ^0.45.2` e `better-sqlite3 ^12.10.0` presentes. **Não há `drizzle-kit`.** Sem `scripts` de migration. Sem `drizzle.config.ts`.

## O que precisa ser feito

**(a)** Mover as assinaturas dos 6 métodos para o port `SessionRepository`, retipar `repo` no server para a interface, e (idealmente) extrair um fake in-memory para testes.

**(b)** Introduzir migrations versionadas com Drizzle Kit, fazendo a **primeira migration refletir o schema atual** (sem recriar/destruir dados de usuários existentes), e trocar o `migrate()` inline pelo aplicador de migrations do `drizzle-orm/better-sqlite3`.

## Como implementar

### Parte (a) — completar o port

`packages/core/src/ports/repository.ts` — adicionar (importando `AnalysisTemplate` de `analyzer.js`):

```ts
import type { AnalysisTemplate } from "./analyzer.js";

export interface SessionRepository {
  // ...existentes...
  deleteAnalysis(id: string): void;

  listTemplates(): AnalysisTemplate[];
  getTemplate(id: string): AnalysisTemplate | undefined;
  createTemplate(data: Pick<AnalysisTemplate, "id" | "name" | "userPromptTemplate">): AnalysisTemplate;
  updateTemplate(id: string, data: Partial<Pick<AnalysisTemplate, "name" | "userPromptTemplate">>): AnalysisTemplate | undefined;
  deleteTemplate(id: string): boolean;
}
```

As assinaturas batem 1:1 com o que o concreto já expõe (`sqlite.ts:284-368`) — `SQLiteRepository implements SessionRepository` (`sqlite.ts:18`) continua compilando sem mudança no concreto.

No GUI server, tipar `repo` pela porta para travar o contrato:

```ts
import type { SessionRepository } from "@listening-resume/core";
const repo: SessionRepository = new SQLiteRepository(dbPath);
```

(Se a spec 10 estiver aplicada, isso já vive no `ApiDeps.repo`.)

**Fake in-memory para testes** — `packages/core/src/adapters/persistence/in-memory.ts`:

```ts
export class InMemoryRepository implements SessionRepository {
  private sessions = new Map<string, Session>();
  private chunks: AudioChunk[] = [];
  private transcripts = new Map<string, Transcript>();
  private analyses: Analysis[] = [];
  private templates = new Map<string, AnalysisTemplate>();
  // ...implementa todos os métodos do port com Map/array...
}
```

Isso destrava testar services (spec 10/13) e o router sem tocar SQLite. Exportar no barrel (`index.ts`).

### Parte (b) — migrations com Drizzle Kit

1. Adicionar `drizzle-kit` às devDependencies do core e `drizzle.config.ts` na raiz do pacote `packages/core/`:

```ts
// packages/core/drizzle.config.ts
import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/adapters/persistence/schema.ts",
  out: "./drizzle",
});
```

2. Scripts no `packages/core/package.json`:

```json
"db:generate": "drizzle-kit generate",
"db:check": "drizzle-kit check"
```

3. **Gerar a migration baseline** a partir do `schema.ts` atual: `pnpm --filter @listening-resume/core db:generate`. Isso cria `packages/core/drizzle/0000_*.sql` com os mesmos `CREATE TABLE`. Revisar manualmente para garantir que bate com o SQL inline de `sqlite.ts:34-81` (mesmas colunas/tipos/defaults — ex: `sample_rate INTEGER NOT NULL DEFAULT 16000`, `builtin INTEGER NOT NULL DEFAULT 0`).

4. **Trocar `migrate()` pelo migrator do Drizzle**, preservando compatibilidade com DBs já existentes (que têm as tabelas mas não a tabela de controle `__drizzle_migrations`):

```ts
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
// no construtor, no lugar de this.migrate(this.sqlite):
migrate(this.db, { migrationsFolder: /* caminho para ./drizzle empacotado */ });
this.seedBuiltinTemplates();
```

**Problema de baseline em DB existente**: a primeira migration faria `CREATE TABLE` que falharia porque as tabelas já existem. Duas saídas:
- Manter os `CREATE TABLE IF NOT EXISTS` da baseline (`drizzle-kit` gera sem `IF NOT EXISTS`; editar a 0000 para incluí-lo **apenas na baseline**), de modo que rodar a 0000 num DB antigo é no-op e ela é marcada como aplicada. Migrations futuras (0001+) usam `ALTER TABLE` normal.
- Ou: na primeira boot com o novo código, detectar DB legado (tabela `sessions` existe mas `__drizzle_migrations` não) e inserir o registro da 0000 como "já aplicada" antes de migrar.

Recomendação: **baseline idempotente** (`IF NOT EXISTS` na 0000) — mais simples e seguro para o parque instalado.

5. **Empacotamento**: os `.sql` em `packages/core/drizzle/` precisam ir para o bundle. Hoje o core é buildado por tsup; arquivos `.sql` não são JS. Opções:
   - Embutir o SQL como string no código gerado (um passo de build que lê os `.sql` e gera um `migrations.ts`), evitando depender de arquivos soltos no `server-bundle.mjs` (que é um único arquivo — ver `build-server.mjs:18-21`).
   - Ou copiar a pasta `drizzle/` para os resources do Tauri (como o `build-server.mjs` já copia native modules — `build-server.mjs:44-54`) e apontar `migrationsFolder` para o caminho empacotado.

   Recomendação: **embutir como string** (`drizzle-orm` aceita migrations em memória via journal? não diretamente — então gerar um módulo `migrations.generated.ts` com `[{ tag, sql }]` e aplicar manualmente numa pequena função `applyMigrations(sqlite)` que cria `__drizzle_migrations` e roda cada SQL pendente). Isso mantém o bundle como um único arquivo e não mexe no `build-server.mjs`.

### Ordem de migração segura

1. Parte (a) primeiro (só tipos + fake): adicionar métodos ao port, retipar `repo`, criar `InMemoryRepository`, exportar. `pnpm build` + `pnpm test`. Risco quase zero.
2. Parte (b) em ambiente de dev com um DB de teste **antes** de qualquer release:
   a. Add `drizzle-kit` + config + `db:generate` baseline.
   b. Tornar a 0000 idempotente.
   c. Implementar `applyMigrations` + `migrations.generated.ts`, atrás de testes contra: (i) DB vazio, (ii) DB legado pré-existente.
   d. Substituir `this.migrate()` por `applyMigrations()` em `sqlite.ts:26`.
3. Validar com `pnpm --filter gui smoke:server` e abrindo um DB real de sessão antigo (copiar `~/.local/share/listening-resume/listening-resume.db` para um tmp e bootar contra ele).

## Plano de testes

- **Port (a)**: teste que `InMemoryRepository` e `SQLiteRepository` (em DB `:memory:`) passam **a mesma suíte de contrato** — CRUD de session/chunk/transcript/analysis, `deleteAnalysis`, e o ciclo de templates (`createTemplate` → `getTemplate` → `updateTemplate` → `deleteTemplate` retorna `false` para builtin).
- **Migrations (b)**:
  - Aplicar migrations num DB `:memory:` vazio → todas as tabelas existem, `seedBuiltinTemplates` popula os 3 builtins (`sqlite.ts:87`).
  - Aplicar num DB que já tem as tabelas (simulando usuário legado) → não lança, marca 0000 como aplicada, dados preservados.
  - Adicionar uma migration 0001 fictícia (`ALTER TABLE sessions ADD COLUMN test_col`) e provar que ela roda no DB legado já migrado.
- **Regressão**: `pnpm --filter gui smoke:server` (build gate) passa com o novo aplicador de migrations.

## Riscos / decisões em aberto

- **Parque instalado**: o maior risco é quebrar o DB de quem já usa o app. A baseline idempotente + testes contra DB legado mitigam. Fazer backup do `.db` antes de migrar (copiar para `.db.bak` na primeira execução do novo código) é uma salvaguarda barata.
- **`seedBuiltinTemplates` faz UPDATE de builtins a cada boot** (`sqlite.ts:106-117`) — isso sobrescreve edições? Builtins têm `builtin=1` e a UI bloqueia editar builtin (`server.ts:963-965`), então ok; manter esse comportamento após a troca de migrator.
- **Empacotamento das migrations**: a escolha "embutir como string" evita mexer no `build-server.mjs`, mas exige um passo de codegen no build do core. Alternativa (copiar pasta) é mais simples no core mas adiciona um item à lista de coisas que o `build-server.mjs` precisa copiar (e que "aborta o build se faltar" — `build-server.mjs:50-54`). Decidir conforme apetite.
- **`drizzle-kit` como devDependency**: não vai para runtime/bundle (só gera SQL em dev), então não afeta o tamanho do `server-bundle.mjs` nem o ABI do `better-sqlite3`.
- **Escopo**: esta spec NÃO adiciona colunas novas — só estabelece o mecanismo. As specs 13 (snapshot de template/provider na análise) e futuras de schema dependem deste mecanismo existir.
