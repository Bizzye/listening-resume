# 09 — Licenciamento Pro (BYOK, sem backend)
> Status: proposta · Esforço: 🟢 · Impacto: alto (monetização) · Depende de: nada

## Problema

O app é um projeto de hobby sendo transformado em produto (ver `docs/IDEIAS-LANCAMENTO.md`). Falta um caminho de monetização. O modelo desejado é **Freemium**:

- **Grátis (Free):** uso local completo — gravar, transcrever (BYOK Groq), analisar (Ollama/Groq), exportar Markdown.
- **Pro (pago):** features de valor agregado — export PDF/DOCX/Anki (spec 06), busca full-text (spec 04), tags e pastas (spec 05), etc.

O desafio central: **não há backend próprio** (app Tauri 2 desktop com servidor Node embarcado em `localhost:3456`, ver `CLAUDE.md`). Precisamos entregar, ativar e validar uma licença paga **sem manter infraestrutura de servidor**, e bloquear (gate) features Pro de forma confiável o suficiente para um produto indie.

Importante: hoje **não existe nenhum gating de features** no código — tudo é liberado. O BYOK (chave Groq do próprio usuário) já existe e serve de molde para a UX da licença.

## Como está hoje

### BYOK de chave Groq já existe (molde a espelhar)

- Variável de runtime carregada de env ou do `.env` de config:
  - `apps/gui/server.ts:111` — `let groqApiKey = process.env.GROQ_API_KEY || "";`
  - `apps/gui/server.ts:112-119` — define `configDir` (Windows `%APPDATA%\listening-resume`, Linux `~/.config/listening-resume`) e `configEnvPath = {configDir}/.env`.
  - `apps/gui/server.ts:121-135` — fallback: lê `GROQ_API_KEY=` do `.env` se a env não estiver setada (lida com aspas).
  - `apps/gui/server.ts:137-140` — em Unix força permissões restritivas `chmod 0o600` no arquivo e `0o700` no diretório.
- Endpoints de config:
  - `apps/gui/server.ts:971-996` — `GET /api/config`: devolve `hasGroqKey` (booleano) e `maskedGroqKey` (`gsk_********...XXXX`, mascaramento em `:992-994`). **Nunca devolve a chave em claro.**
  - `apps/gui/server.ts:999-1056` — `POST /api/config/groq-key`: guarda de origem para aceitar Vite (`localhost:1420`) e o webview Tauri instalado (`http://tauri.localhost` / `tauri://localhost`) — regex em `:1008-1010`; valida formato `^gsk_[a-zA-Z0-9]{20,}$` (`:1024`); persiste no `.env` com `mode: 0o600` (`:1047-1051`).
  - `apps/gui/server.ts:1058-1077` — `DELETE /api/config/groq-key`: remove a linha do `.env`.

### UI da chave Groq (molde a espelhar)

- `apps/gui/src/features/settings/SettingsPage.tsx:39-43` — estado local `groqKey`, `keySaving`, `keyStatus`.
- `apps/gui/src/features/settings/SettingsPage.tsx:166-271` — seção `<SettingsSection title="Groq API Key" icon={Key}>`: mostra estado configurado/não (`config.hasGroqKey`, `config.maskedGroqKey` em `:169-177`), botão Apagar (chama `api.deleteGroqKey()` `:179`), input + botão Salvar (valida e chama `api.setGroqKey(trimmed)` `:224`), feedback de status `saved`/`invalid`/`error`.
- `apps/gui/src/features/settings/SettingsPage.tsx:370-372` — card de status "Groq API" (`connected`/`disconnected`).

### Cliente de API (molde a espelhar)

- `apps/gui/src/shared/lib/api.ts:214-223` — `api.setGroqKey(key)` (POST) e `api.deleteGroqKey()` (DELETE).

### Schema de config

- `packages/core/src/config/schema.ts:64-72` — `appConfigSchema` agrupa `audio/transcription/analysis/rateLimits/storage`. **Não há seção de licença.** (A licença NÃO precisa entrar aqui necessariamente — ver decisão em aberto; o padrão da chave Groq guarda no `.env`, fora do schema Zod.)

### Features que serão "Pro" (sem gating hoje)

- Export está aberto a todos: `apps/gui/server.ts:1094-1160` (`GET /api/sessions/:id/export` e `/export/save`, usam `MarkdownExporter`). Specs futuras 04 (busca FTS5), 05 (tags/pastas) e 06 (export PDF/DOCX/Anki) introduzirão mais features Pro.

**Conclusão:** não existe `isPro()` nem qualquer verificação de licença em lugar nenhum. Tudo precisa ser criado do zero, reusando o padrão de persistência/UI do BYOK Groq.

## O que precisa ser feito

1. Escolher um mecanismo de licença **sem servidor próprio** (recomendação abaixo).
2. Criar um **módulo central de licença + feature flags** (`isPro()`, `assertPro()`) no core, consumido por server e (espelhado) no frontend.
3. Persistir a licença com o mesmo cuidado do BYOK Groq (arquivo dedicado, permissões restritas, mascaramento na API).
4. Endpoints `GET/POST/DELETE /api/config/license` espelhando `/api/config/groq-key`.
5. Seção "Licença Pro" em `SettingsPage.tsx`.
6. Gatear (gate) as features Pro existentes/futuras via `assertPro()` no server e `isPro` no frontend (esconder/badge).

## Como implementar

### (a) Entrega e validação da licença SEM backend — trade-offs e recomendação

Duas abordagens viáveis para um app desktop offline-first:

**Opção A — License API da plataforma de venda (Lemon Squeezy ou Gumroad)**
- Fluxo: usuário compra → recebe uma *license key* (string) por e-mail → cola na UI → app faz **1 chamada online** ao endpoint público da plataforma para **ativar** (`activate`) e validar; resposta inclui status, e (Lemon Squeezy) um `instance_id`. O app **cacheia** o resultado localmente (com timestamp) e passa a operar **offline**, revalidando só esporadicamente (ex.: a cada N dias, com tolerância/grace period se a rede falhar).
  - Lemon Squeezy: `POST https://api.lemonsqueezy.com/v1/licenses/activate` (e `/validate`, `/deactivate`). Não exige a Secret API key no cliente — a license key basta para ativar.
  - Gumroad: `POST https://api.gumroad.com/v2/licenses/verify` com `product_id` + `license_key` (e `increment_uses_count=false` para só verificar).
- Prós: revogação possível (refund/chargeback → desativa), limite de ativações por máquina embutido, dashboard de vendas pronto, zero infra. A "chamada online" é só na ativação/revalidação, não no uso diário.
- Contras: depende de um serviço externo estar no ar para **ativar** (não para usar, graças ao cache); precisa lidar com modo offline na primeira ativação (impossível ativar 100% offline); `product_id`/store id ficam embutidos no binário (não são segredo).

**Opção B — Licença assinada criptograficamente (chave pública embutida)**
- Fluxo: ao vender, um pequeno script seu (rodado **manualmente** ou via webhook num runner gratuito tipo GitHub Actions/Cloudflare Worker) assina um payload (`{email, plan, exp?}`) com uma **chave privada Ed25519**. O usuário recebe o token (payload + assinatura, ex.: base64). O app embute a **chave pública** e verifica a assinatura **100% offline** com `crypto.verify`/`tweetnacl`. Sem nenhuma chamada de rede.
- Prós: verificação totalmente offline, sem dependência de terceiros no runtime, rápido.
- Contras: **revogação é difícil** (precisa de exp curto + reemissão, ou lista de revogação distribuída — o que reintroduz rede); emissão exige um passo extra no fluxo de venda (Gumroad/LS não geram tokens assinados nativamente — precisaria de webhook); risco de vazamento de um token compartilhado entre usuários (mitigável amarrando ao e-mail, mas validar e-mail offline é fraco).

**Recomendação: Opção A (Lemon Squeezy License API).**
Para um indie com Gumroad/Lemon Squeezy já no fluxo de venda, a License API dá **revogação real** (essencial contra refunds/chargebacks) e **limite de ativações por máquina** sem nenhuma infra própria — exatamente o objetivo. O custo é uma única chamada online na ativação, plenamente aceitável (o app já depende de rede para transcrever via Groq). Lemon Squeezy é preferível ao Gumroad pela API de licenças mais rica (`activate`/`validate`/`deactivate` + `instance_id` por máquina). Mantemos **cache offline com grace period** para que o uso diário nunca dependa da rede.

> Decisão de arquitetura para deixar a porta aberta: encapsular tudo atrás de uma interface `LicenseVerifierPort`, com `RemoteLicenseVerifier` (Opção A) como impl default. Se mais tarde quisermos a Opção B, é só outra impl — sem tocar no gating.

### Modelo de cache da licença (Opção A)

Arquivo dedicado (NÃO o `.env` da Groq, para não misturar segredo do usuário com dado de licença), no mesmo `configDir` já usado em `apps/gui/server.ts:112-119`:

```
{configDir}/license.json   (mode 0o600, dir 0o700 — mesmo padrão de server.ts:137-140)
```

Conteúdo cacheado:

```jsonc
{
  "key": "LS-XXXX-....",          // a license key colada pelo usuário
  "instanceId": "ulid-da-maquina", // devolvido pelo activate (LS)
  "status": "active",              // active | inactive | expired | disabled
  "plan": "pro",
  "activatedAt": 1718500000000,
  "lastValidatedAt": 1718500000000,
  "validUntil": null               // se a venda for assinatura
}
```

### (b) Módulo central de feature flags (core)

Novo arquivo `packages/core/src/licensing/license.ts` (no core, para ser reusável por CLI e server):

```ts
export type Plan = "free" | "pro";
export interface LicenseState {
  plan: Plan;
  status: "active" | "inactive" | "expired" | "disabled" | "none";
  key?: string;
  validatedAt?: number;
}

// Lista canônica de capabilities Pro — referenciada pelas specs 04/05/06.
export const PRO_FEATURES = [
  "export-pdf",
  "export-docx",
  "export-anki",
  "fulltext-search",
  "tags-folders",
] as const;
export type ProFeature = (typeof PRO_FEATURES)[number];

export function isPro(state: LicenseState): boolean {
  return state.plan === "pro" && state.status === "active";
}

export function canUse(state: LicenseState, feature: ProFeature): boolean {
  // Hoje todas as features Pro são all-or-nothing; mantém assinatura
  // pronta para tiers futuros.
  return isPro(state);
}

export class FeatureLockedError extends Error {
  constructor(public feature: ProFeature) {
    super(`Feature "${feature}" requires a Pro license.`);
    this.name = "FeatureLockedError";
  }
}
export function assertPro(state: LicenseState, feature: ProFeature): void {
  if (!canUse(state, feature)) throw new FeatureLockedError(feature);
}
```

Verificador remoto `packages/core/src/licensing/remote-verifier.ts` (Opção A):

```ts
export interface LicenseVerifierPort {
  activate(key: string): Promise<LicenseState & { instanceId?: string }>;
  validate(key: string, instanceId?: string): Promise<LicenseState>;
}

// Lemon Squeezy. STORE_PRODUCT_ID embutido (não é segredo).
export class LemonSqueezyVerifier implements LicenseVerifierPort {
  async activate(key: string) {
    const r = await fetch("https://api.lemonsqueezy.com/v1/licenses/activate", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ license_key: key, instance_name: hostname() }),
    });
    const data = await r.json();
    return mapLsResponse(data); // -> LicenseState + instanceId
  }
  async validate(key: string, instanceId?: string) { /* /v1/licenses/validate */ }
}
```

### Estado de licença no server

Espelhar exatamente o padrão da chave Groq em `apps/gui/server.ts:111-140`:

```ts
// junto de groqApiKey (server.ts:111)
let licenseState: LicenseState = { plan: "free", status: "none" };
const licensePath = path.join(configDir, "license.json"); // configDir: server.ts:112

// no boot, carregar cache (espelha :121-135) e, se houver rede, revalidar
// em background respeitando grace period; permissões via chmod (espelha :137-140)
function loadLicenseCache() { /* fs.readFileSync(licensePath) -> licenseState */ }
```

> Importante: a verificação de gate roda **no server** (autoritativa) — o frontend só esconde/mostra UI. Como o server roda em `localhost` no mesmo host do usuário, isto não é uma barreira criptográfica forte (usuário avançado pode contornar). Para um produto indie isso é aceitável: o gate honesto + a fricção da ativação cobrem 95% dos casos. (Ver Riscos.)

### Endpoints de licença (espelham /api/config/groq-key)

Adicionar em `apps/gui/server.ts` logo após o bloco da Groq key (`:1077`), com a **mesma guarda de origem** de `:1005-1013`:

```ts
// GET — expõe estado, NUNCA a key em claro (espelha o masking de :992-994)
// route === "/api/config/license" && GET
json(res, {
  plan: licenseState.plan,
  status: licenseState.status,
  isPro: isPro(licenseState),
  maskedKey: licenseState.key
    ? `${licenseState.key.slice(0, 4)}…${licenseState.key.slice(-4)}`
    : null,
  validatedAt: licenseState.validatedAt ?? null,
});

// POST { key } — ativa via verifier, persiste cache (espelha :1032-1055)
//   valida origem; valida key não-vazia; chama verifier.activate(key);
//   se status !== "active" -> 400 com mensagem clara; senão grava license.json 0o600.

// DELETE — "desconectar" licença: chama verifier.deactivate (LS) e apaga cache
//   (espelha :1058-1077). Volta licenseState para { plan:"free", status:"none" }.
```

Também estender `GET /api/config` (`apps/gui/server.ts:971-996`) para incluir `isPro: isPro(licenseState)` e `plan`, já que o frontend lê config no boot.

### Gatear as features Pro existentes

Export é a primeira feature a gatear. Em `apps/gui/server.ts:1094-1118` (`/export`) e `:1120-1160` (`/export/save`): Markdown permanece **grátis**; quando spec 06 introduzir `?format=pdf|docx|anki`, inserir antes de exportar:

```ts
try {
  assertPro(licenseState, "export-pdf"); // feature conforme o format pedido
} catch (e) {
  if (e instanceof FeatureLockedError)
    return json(res, { error: "Pro license required", feature: e.feature }, 402);
  throw e;
}
```

(HTTP **402 Payment Required** comunica claramente "feature paga" ao frontend.) Specs 04 (busca) e 05 (tags) chamam o mesmo `assertPro(...)` em seus endpoints.

### (c) UI nas Settings (espelha a seção Groq key)

Em `apps/gui/src/features/settings/SettingsPage.tsx`, adicionar uma `<SettingsSection title="Licença Pro" icon={...}>` clonando a estrutura de `:166-271`:

- Estado local espelhando `:39-43`: `const [license, setLicense] = useState(""); const [licSaving, setLicSaving] = useState(false); const [licStatus, setLicStatus] = useState<"idle"|"saved"|"invalid"|"error">("idle");`
- Se Pro ativo (`config.isPro`): mostrar `config.maskedKey`, badge "Pro ✓", botão "Desativar nesta máquina" → `api.deleteLicense()` (espelha o botão Apagar de `:177-191`).
- Se Free: input para colar a license key + botão "Ativar" → `api.activateLicense(key)` (espelha Salvar de `:212-238`), com feedback `saved`/`invalid`/`error` (espelha `:240-256`). Mensagem de erro deve distinguir "chave inválida/revogada" de "sem internet para ativar".
- Link "Comprar Pro" → URL do checkout Lemon Squeezy (espelha o link `console.groq.com/keys` em `:258-266`).

Cliente em `apps/gui/src/shared/lib/api.ts` (espelha `:214-223`):

```ts
async activateLicense(key: string) {
  return request("/config/license", { method: "POST", body: JSON.stringify({ key }) });
},
async deleteLicense() {
  return request("/config/license", { method: "DELETE" });
},
async getLicense() { return request("/config/license"); },
```

### Gating no frontend (esconder UI Pro)

Expor `isPro` no store (`apps/gui/src/store.ts`, junto do `config`) lido de `GET /api/config`. Componente helper `<ProGate feature="export-pdf">` que renderiza um cadeado/badge "Pro" e CTA de compra quando `!isPro`, em vez do controle. Botões de export PDF/DOCX (spec 06), busca (spec 04) e tags (spec 05) ficam embrulhados por ele.

### (d) Onde guardar a licença

`{configDir}/license.json` (Windows `%APPDATA%\listening-resume\license.json`; Linux `~/.config/listening-resume/license.json`) — mesmo `configDir` de `apps/gui/server.ts:112-119`, com `mode 0o600` no arquivo e `0o700` no diretório (mesmo `chmod` de `:137-140`, Unix-only). Separado do `.env` da Groq de propósito: a license key é dado de billing, a Groq key é segredo do usuário; manter arquivos distintos simplifica o `DELETE` de cada um e evita reescrever o `.env` do usuário.

## Plano de testes

Unit (Vitest, core):
- `isPro`/`canUse`/`assertPro`: free→false, pro+active→true, pro+expired/disabled→false; `assertPro` lança `FeatureLockedError` com a `feature` correta.
- `LemonSqueezyVerifier`: mapear respostas mockadas (active / invalid / disabled / refunded) para `LicenseState`; tratar timeout/erro de rede sem derrubar (retorna estado a partir do cache).

Integração (server):
- `POST /api/config/license` com verifier mockado: key válida → grava `license.json` (mode `0o600`), `GET /api/config/license` devolve `isPro:true` e `maskedKey` (nunca a key em claro).
- key inválida/revogada → 400 com mensagem; cache não é gravado.
- `DELETE` → remove arquivo, `isPro:false`.
- Guarda de origem: requisição de origem não-local → 403 (mesma regex de `:1008-1010`); origem `http://tauri.localhost` → aceita.
- Gate: `/export?format=pdf` sem Pro → 402; com Pro → 200. Markdown sempre 200.
- Boot com `license.json` válido em cache e **sem rede** → continua Pro (grace period).

E2E (Playwright MCP em `localhost:1420`):
- Settings: colar key, ativar, ver badge Pro; desativar volta para Free; botão Comprar abre o checkout.
- Botão de export PDF mostra `ProGate` quando Free e fica habilitado quando Pro.

## Riscos / decisões em aberto

- **Gate é client-side/local, não inviolável.** O server roda na máquina do usuário; um usuário avançado pode patchear o binário ou forjar `license.json`. Aceitável para indie (a fricção + revogação cobrem o grosso); criptografia anti-pirataria forte é fora de escopo.
- **Primeira ativação exige internet** (Opção A). Sem rede não dá para ativar — comunicar isso na UI. (A Opção B resolveria, mas perde revogação.)
- **Grace period / revalidação:** definir N dias offline tolerados e cadência de revalidação. Muito curto irrita usuários offline; muito longo enfraquece a revogação. Sugestão inicial: revalidar a cada 7 dias, tolerar até 30 dias sem rede.
- **Lemon Squeezy vs Gumroad:** recomendado LS pela License API mais completa; reconfirmar conforme a plataforma de venda escolhida em `docs/IDEIAS-LANCAMENTO.md`.
- **`product_id`/store id embutidos** no binário não são segredo (OK), mas não embutir nenhuma *Secret API key* da plataforma no cliente.
- **Migração/refund:** ao detectar `status: disabled` (refund/chargeback) numa revalidação, rebaixar para Free de forma graciosa (não apagar dados do usuário, só travar features Pro).
- **Decisão em aberto:** colocar `license` no `appConfigSchema` (`packages/core/src/config/schema.ts:64-72`) ou mantê-la totalmente fora do schema Zod (como a Groq key já está). Recomendação: fora do schema, em `license.json` dedicado, espelhando o tratamento do `.env`.
