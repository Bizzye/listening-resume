# 06 — Export PDF/DOCX/Anki (registry de exporters)
> Status: proposta · Esforço: 🟡 · Impacto: alto · Depende de: nada

## Problema

Hoje só dá pra exportar uma sessão em **Markdown** (sessão completa) ou **texto puro** (só a transcrição). Pra um produto, isso é pouco:

- **PDF** é o formato que a maioria das pessoas espera pra "salvar/imprimir/mandar" um resumo de reunião ou de aula.
- **DOCX** é o que quem trabalha em escritório edita (Word/Google Docs).
- **Anki** é matador pro caso de uso de estudo: os templates de análise já geram seções de pergunta/resposta (o template `videoaula-insana` tem a seção "❓ 9. Banco de Questões para Revisão (estilo flashcard)" com pares `**P:** … **R:** …`), então dá pra transformar a análise direto num deck de flashcards.

Além do formato, o **jeito de escolher o formato está chumbado no endpoint**: o `if (format === "text") … else …` mora dentro do handler HTTP (`apps/gui/server.ts`). Adicionar PDF/DOCX/Anki hoje significa empilhar mais `if`s no servidor, repetir lógica no CLI (`apps/cli/src/cli.ts`) e instanciar `new MarkdownExporter()` em três lugares. Queremos um **registry** (mapa `formato → exporter`) pra adicionar formato em um lugar só, sem tocar no endpoint nem no CLI.

## Como está hoje

**Port** — `packages/core/src/ports/exporter.ts:9-12`: a interface devolve **só `string`**. Isso é o gargalo conceitual — PDF/DOCX/Anki(.apkg) são **binários**, não cabem num `Promise<string>`.

```ts
export interface ExporterPort {
	export(data: ExportData): Promise<string>; // returns formatted content
	readonly format: string;
}
```

`ExportData` (`packages/core/src/ports/exporter.ts:3-7`) carrega `session`, `transcript | null` e `analyses: Analysis[]`.

**Único adapter** — `packages/core/src/adapters/export/markdown.ts:3-41`: `MarkdownExporter` com `readonly format = "markdown"`. A seção de transcrição usa `formatTimestamp` (`markdown.ts:43-51`) e a de análise itera `data.analyses` imprimindo `analysis.templateId` + `analysis.content` (`markdown.ts:30-37`).

**Modelos** — `packages/core/src/domain/models.ts`: `Analysis` (`models.ts:51-59`) tem `templateId`, `content` (markdown cru gerado pelo LLM), `provider`, `model`. `Transcript` (`models.ts:40-49`) tem `segments[]` (`{start,end,text}`) e `fullText`. `Session` (`models.ts:13-22`) tem `title`, `status`, `startedAt`, `audioSource`.

**Export no `index.ts` do core** — `packages/core/src/index.ts:8` exporta só `MarkdownExporter`; `index.ts:35` reexporta o port (`export * from "./ports/exporter.js"`). Nenhum registry existe.

**Endpoints no GUI server** (`apps/gui/server.ts`):
- `GET /api/sessions/:id/export` (`server.ts:1094-1116`): **só markdown**, instancia `new MarkdownExporter()` (`server.ts:1107`), responde `text/markdown` com `Content-Disposition` (`server.ts:1110-1113`).
- `POST /api/sessions/:id/export/save` (`server.ts:1118-1161`): lê `{ format = "markdown" }` do body (`server.ts:1129`), e tem o `if (format === "text") … else …` chumbado (`server.ts:1145-1155`): `text` junta `transcript.segments` com `\n`; o resto cai no `MarkdownExporter` (`server.ts:1152-1153`). Escreve com `fs.writeFileSync(filepath, content, "utf-8")` (`server.ts:1158`) — **sempre como UTF-8 string**, outro ponto que quebra com binário.

**UI — aba Export** (`apps/gui/src/features/sessions/SessionDetailPage.tsx`): a aba é a 3ª (`SessionDetailPage.tsx:68`, render em `:206`). `ExportPanel` (`:615-719`) tem:
- `handleExportMarkdown` (`:626-628`) → `window.open(.../export)`.
- `handleExportText` (`:630-644`) → busca a sessão, monta o `.txt` **no front** e baixa via Blob.
- `handleSaveToDisk(format: "markdown" | "text")` (`:646-663`) → POST `/export/save`.
- Os dois `ExportCard` (`:671-682`) e os dois botões "Save .md / Save .txt" (`:693-708`) estão hardcoded.

**CLI** (`apps/cli/src/cli.ts`): comando `export <sessionId>` (`cli.ts:344-374`) com `--output`. Instancia `new MarkdownExporter()` (`cli.ts:365`), e **só** markdown — importa `MarkdownExporter` direto (`cli.ts:13`).

**Templates / Q&A** — `packages/core/src/templates/videoaula-insana.ts:62-66` define o formato dos flashcards que o Anki vai consumir:
```
## ❓ 9. Banco de Questões para Revisão (estilo flashcard)
- **P**: [pergunta]
  **R**: [resposta completa baseada na aula]
```
`getTemplate`/`listTemplates` (`packages/core/src/templates/index.ts:17-27`) estão `@deprecated` (templates moram no banco agora), então o parser de Q&A **não pode** depender do id do template — tem que ser por regex no `analysis.content`.

## O que precisa ser feito

1. **Mudar o contrato do port** pra suportar binário (PDF/DOCX/.apkg) além de texto.
2. **Criar um `ExporterRegistry`** (mapa `formato → exporter`) no core e exportá-lo no `index.ts`.
3. **Implementar 3 exporters novos**: PDF, DOCX, Anki (CSV importável como baseline; .apkg como upgrade opcional).
4. **Trocar os 2 endpoints** pra resolver o exporter via registry pelo param `format` (em vez de `if/else`).
5. **Atualizar a UI** pra listar os formatos do registry e baixar binário corretamente.
6. **Atualizar o CLI** (`export --format`).
7. **Parser de Q&A** reaproveitável (core) pra alimentar o exporter de Anki.

## Como implementar

### 1. Novo contrato do port — `packages/core/src/ports/exporter.ts`

Trocar `Promise<string>` por um resultado que descreve mime/extensão/binário. Isso elimina o `Content-Type`/`Content-Disposition` chumbado no server e o `writeFileSync(...,"utf-8")` que quebra binário.

```ts
import type { Analysis, Session, Transcript } from "../domain/models.js";

export interface ExportData {
	session: Session;
	transcript: Transcript | null;
	analyses: Analysis[];
}

export interface ExportResult {
	/** Conteúdo: string p/ texto, Buffer p/ binário (pdf/docx/apkg). */
	content: string | Buffer;
	/** ex: "text/markdown; charset=utf-8", "application/pdf" */
	mimeType: string;
	/** sem ponto: "md", "txt", "pdf", "docx", "csv", "apkg" */
	extension: string;
}

export interface ExporterPort {
	export(data: ExportData): Promise<ExportResult>;
	/** chave do registry: "markdown" | "text" | "pdf" | "docx" | "anki" */
	readonly format: string;
	/** rótulo p/ UI/CLI */
	readonly label: string;
}
```

`MarkdownExporter` (`adapters/export/markdown.ts`) passa a retornar `{ content: <a string atual>, mimeType: "text/markdown; charset=utf-8", extension: "md" }` e ganha `readonly label = "Markdown"`. A lógica de montagem do markdown (linhas 7-39) fica intacta.

### 2. Registry — novo `packages/core/src/adapters/export/registry.ts`

```ts
import type { ExporterPort } from "../../ports/exporter.js";
import { MarkdownExporter } from "./markdown.js";
import { PlainTextExporter } from "./plain-text.js";
import { PdfExporter } from "./pdf.js";
import { DocxExporter } from "./docx.js";
import { AnkiExporter } from "./anki.js";

export class ExporterRegistry {
	private map = new Map<string, ExporterPort>();

	constructor(exporters: ExporterPort[]) {
		for (const e of exporters) this.map.set(e.format, e);
	}

	get(format: string): ExporterPort | undefined {
		return this.map.get(format);
	}

	list(): { format: string; label: string; extension: string }[] {
		return [...this.map.values()].map((e) => ({
			format: e.format,
			label: e.label,
			extension: e.extension ?? "",
		}));
	}

	static default(): ExporterRegistry {
		return new ExporterRegistry([
			new MarkdownExporter(),
			new PlainTextExporter(),
			new PdfExporter(),
			new DocxExporter(),
			new AnkiExporter(),
		]);
	}
}
```

> `extension` é fixo por exporter — promover de `ExportResult` pra `readonly extension` no `ExporterPort` (deixa o `list()` mais simples). `mimeType` continua só no resultado (igual pra todos os formatos do mesmo exporter).

Mover o **texto puro** pra um `PlainTextExporter` (`adapters/export/plain-text.ts`, `format = "text"`, `extension = "txt"`) — hoje essa lógica está espalhada entre o front (`SessionDetailPage.tsx:634-636`) e o server (`server.ts:1146-1148`). Centralizar mata a duplicação.

### 3. Os três exporters novos + libs sugeridas

Tudo roda no **Node embarcado no Tauri** → a regra de ouro é **evitar deps pesadas/nativas**. Puppeteer (Chromium ~150-300 MB + binário que casa com a versão do node empacotado) **está fora** — bagunçaria o `build-server.mjs`/`download-deps-win.ps1` (que já copiam módulos nativos por match de versão no pnpm store, ver CLAUDE.md "Packaging").

**PDF — `adapters/export/pdf.ts`** (`format="pdf"`, mime `application/pdf`):
- **Recomendado: `pdfkit`** (~puro JS, sem Chromium, sem binário nativo). Geração programática: título, metadados da sessão, transcrição com timestamps, e cada `analysis.content`. Trade-off: markdown não renderiza "de graça" — precisa de um render simples (negrito/listas/headings via parse leve) ou aceitar texto plano com hierarquia por fonte/tamanho. Para tabelas do template videoaula, fazer render básico (pode ficar como texto monoespaçado no v1).
- **Alternativa: `md-to-pdf`** (usa puppeteer por baixo) → **descartar** pelo peso.
- **Alternativa intermediária: markdown→HTML (`marked`) → `html-pdf-node`/`@react-pdf/renderer`.** `@react-pdf/renderer` é JS puro e fiel, mas exige reescrever o layout em componentes (mais trabalho). Decisão sugerida v1: **pdfkit + render markdown mínimo**; reavaliar `@react-pdf/renderer` se o visual não for suficiente.

**DOCX — `adapters/export/docx.ts`** (`format="docx"`, mime `application/vnd.openxmlformats-officedocument.wordprocessingml.document`):
- **Recomendado: lib `docx`** (npm `docx`, JS puro, gera Buffer via `Packer.toBuffer(doc)`). Constrói `Paragraph`/`HeadingLevel`/`Table` programaticamente. Trade-off igual ao PDF: o `analysis.content` é markdown → precisa de um parser markdown→AST→elementos docx (dá pra usar `marked` lexer e mapear tokens heading/list/table/code pra elementos `docx`). v1 pode tratar markdown como parágrafos simples e evoluir.
- **Alternativa: `html-to-docx`** (markdown→HTML→docx) — menos controle de estilo, mas bem menos código. Boa opção pra v1 se a fidelidade não for crítica.

**Anki — `adapters/export/anki.ts`** (duas táticas):
- **v1 (recomendado): CSV importável** (`format="anki"`, extension `csv`, mime `text/csv; charset=utf-8`). Anki importa CSV nativamente (Frente,Verso). Zero dependências, zero binário. Conteúdo: uma linha por par P/R extraído das análises.
- **v2 (upgrade): `.apkg` real** via lib `genanki-js`/`anki-apkg-export`. Trade-off: `.apkg` é um SQLite zipado → puxa `sql.js` (WASM) ou better-sqlite3 (já temos no projeto, mas o schema do Anki é chato). Mais "plug-and-play" pro usuário (importa com 2 cliques, sem mapear colunas), porém mais dependência/risco no empacotamento. Decisão: **começar com CSV**, marcar `.apkg` como follow-up.

### 4. Parser de Q&A reaproveitável — novo `packages/core/src/utils/qa-parser.ts`

Não dá pra olhar o id do template (deprecado, `templates/index.ts:14-16`). Parsear o `analysis.content` por regex, casando o formato de `videoaula-insana.ts:64-66`:

```ts
export interface QAPair { front: string; back: string; }

/** Extrai pares P/R de um markdown de análise.
 *  Casa "**P**: ...", "**P:** ...", "P:", "Q:" seguido de "**R**:"/"R:"/"A:". */
export function extractQAPairs(markdown: string): QAPair[] {
	const pairs: QAPair[] = [];
	// regex multiline tolerante a variações de bold/dois-pontos e quebras
	const re =
		/(?:^|\n)\s*[-*]?\s*\**\s*(?:P|Q|Pergunta)\**\s*:?\**\s*(.+?)\s*\n\s*\**\s*(?:R|A|Resposta)\**\s*:?\**\s*([\s\S]+?)(?=\n\s*[-*]?\s*\**\s*(?:P|Q|Pergunta)\**\s*:|\n\s*#|\n\s*---|\s*$)/gi;
	for (const m of markdown.matchAll(re)) {
		pairs.push({ front: m[1].trim(), back: m[2].trim() });
	}
	return pairs;
}
```

`AnkiExporter.export` itera `data.analyses`, roda `extractQAPairs(a.content)`, escapa CSV (aspas duplas, quebras de linha viram `<br>` p/ Anki) e gera o CSV. Se zero pares forem encontrados em todas as análises, retorna CSV com cabeçalho e (opcional) um warning no header.

### 5. Endpoints — `apps/gui/server.ts`

Instanciar **uma vez** o registry perto do boot (junto com `repo`/`config`): `const exporters = ExporterRegistry.default();` e importá-lo de `@listening-resume/core`.

`GET /api/sessions/:id/export` (`server.ts:1094-1116`) — aceitar `?format=` (default `markdown`):

```ts
const format = new URL(req.url!, "http://x").searchParams.get("format") ?? "markdown";
const exporter = exporters.get(format);
if (!exporter) return json(res, { error: `Unknown format: ${format}` }, 400);
const result = await exporter.export({ session, transcript, analyses });
res.writeHead(200, {
	"Content-Type": result.mimeType,
	"Content-Disposition": `attachment; filename="session-${session.id.slice(0, 8)}.${result.extension}"`,
});
res.end(result.content); // Buffer OU string — res.end aceita os dois
```

`POST /api/sessions/:id/export/save` (`server.ts:1118-1161`) — remover o `if (format==="text") … else …` (`server.ts:1145-1155`):

```ts
const exporter = exporters.get(format);
if (!exporter) return json(res, { error: `Unknown format: ${format}` }, 400);
const result = await exporter.export({ session, transcript, analyses });
const filename = `${dateStr}_${safeTitle}.${result.extension}`;
const filepath = path.join(exportDir, filename);
fs.writeFileSync(filepath, result.content); // Buffer p/ binário, string p/ texto — sem "utf-8" forçado
return json(res, { ok: true, path: filepath });
```

Novo endpoint p/ a UI descobrir formatos: `GET /api/export/formats` → `json(res, { formats: exporters.list() })`.

### 6. UI — `apps/gui/src/features/sessions/SessionDetailPage.tsx`

No `ExportPanel` (`:615-719`):
- Buscar `GET /api/export/formats` no mount e renderizar **um `ExportCard` por formato** (substitui os dois cards hardcoded de `:671-682`).
- `handleExportMarkdown` (`:626-628`) vira genérico: `window.open(.../export?format=${fmt})` (o browser baixa o binário via `Content-Disposition` — funciona pra pdf/docx/csv também).
- `handleExportText` (`:630-644`): **remover a montagem do .txt no front** — agora `?format=text` faz isso no servidor.
- `handleSaveToDisk` (`:646-663`): a assinatura `format: "markdown" | "text"` (`:646`) vira `format: string` e o body `{ format }` (`:652`) passa o formato escolhido.
- Botões "Save .md/.txt" (`:693-708`) viram um botão por formato (ou um `<select>` + um botão "Save").

### 7. CLI — `apps/cli/src/cli.ts`

Comando `export` (`cli.ts:344-374`):
- Importar `ExporterRegistry` de `@listening-resume/core` (trocar o import de `MarkdownExporter`, `cli.ts:13`).
- Add `.option("-f, --format <fmt>", "Export format (markdown|text|pdf|docx|anki)", "markdown")`.
- Resolver `const exporter = ExporterRegistry.default().get(opts.format)`; se `undefined`, erro listando `registry.list()`.
- `const result = await exporter.export({ session, transcript, analyses })`; se `--output`, `fs.writeFileSync(opts.output, result.content)` (sem `"utf-8"`); senão, imprimir só se `typeof result.content === "string"` (binário não vai pro stdout — avisar pra usar `--output`).

### 8. Exports do core — `packages/core/src/index.ts`

Adicionar perto de `index.ts:8`:
```ts
export { MarkdownExporter } from "./adapters/export/markdown.js";
export { PlainTextExporter } from "./adapters/export/plain-text.js";
export { PdfExporter } from "./adapters/export/pdf.js";
export { DocxExporter } from "./adapters/export/docx.js";
export { AnkiExporter } from "./adapters/export/anki.js";
export { ExporterRegistry } from "./adapters/export/registry.js";
export { extractQAPairs } from "./utils/qa-parser.js";
```
O port já é reexportado (`index.ts:35`) e agora carrega `ExportResult`.

### Empacotamento (CLAUDE.md "Packaging")

`pdfkit`/`docx` são JS puro → o esbuild bundle (`scripts/build-server.mjs` → `resources/server-bundle.mjs`) deve empacotá-los sem precisar do tratamento de "módulo nativo". **Verificar**: pdfkit embute fontes `.afm` (assets) que o esbuild pode não copiar — pode ser preciso marcá-las como externas e copiar, ou usar uma fonte standard (Helvetica vem embutida no PDF, sem arquivo). Se a fonte virar um asset solto, adicionar ao copiador do `build-server.mjs`. **Rodar `pnpm smoke:server`** (build gate) depois — ele só checa `/api/devices`, então adicionar um smoke manual de `/api/export/formats`.

## Plano de testes

**Unit (vitest, core)** — `packages/core/src/adapters/export/*.test.ts`:
- `qa-parser.test.ts`: extrai pares do bloco real de `videoaula-insana` (seção 9); tolera `**P**:` vs `**P:**` vs `P:`; ignora `#`/`---` como fronteira; retorna `[]` quando não há Q&A.
- `markdown.test.ts`: garantir que o refactor mantém o output (snapshot do conteúdo atual de `markdown.ts:7-39`) e agora devolve `{mimeType:"text/markdown…", extension:"md"}`.
- `pdf.test.ts` / `docx.test.ts`: `result.content` é `Buffer`, começa com a assinatura mágica (`%PDF-` para pdf; `PK\x03\x04` — zip — para docx); `mimeType`/`extension` corretos. (Não validar layout, só que abre.)
- `anki.test.ts`: CSV com N linhas == N pares; campos com vírgula/aspas/quebra escapados; header presente.
- `registry.test.ts`: `get("pdf")` resolve; `get("xpto")` → undefined; `list()` traz os 5 formatos.

**Integração (server)** — bootar com sessão fixture (transcript + analysis com Q&A):
- `GET /export?format=pdf|docx|anki|markdown|text` → 200, `Content-Type` certo, body não-vazio (binário p/ pdf/docx).
- `GET /export?format=xpto` → 400.
- `POST /export/save {format:"docx"}` → arquivo `.docx` no disco abre como zip válido.
- `GET /api/export/formats` → 5 formatos.

**E2E (CLI)** — `listen export <id> --format docx -o /tmp/x.docx` gera arquivo válido; `--format anki -o /tmp/x.csv` gera CSV.

**Manual (Playwright MCP, `http://localhost:1420`)** — aba Export lista os 5 cards; clicar PDF baixa um `.pdf` abrível; "Save" em docx grava na pasta de export.

## Riscos / decisões em aberto

- **Quebra do contrato `ExporterPort`** (`Promise<string>` → `Promise<ExportResult>`): muda o port e os 3 call-sites (`server.ts:1107`+`:1152`, `cli.ts:365`). É um refactor mecânico, mas qualquer consumidor externo do core quebra. Mitigação: fazer tudo num PR só.
- **Fidelidade markdown → PDF/DOCX**: o `analysis.content` é markdown rico (tabelas, código, LaTeX no template videoaula — `videoaula-insana.ts:38-49,81`). pdfkit/`docx` não renderizam markdown nativamente. Decisão em aberto: render mínimo (headings/bold/listas) no v1 vs. investir num parser markdown→AST completo. LaTeX/matemática provavelmente fica como texto cru no v1.
- **PDF lib**: pdfkit (programático, sem render md fácil) vs `@react-pdf/renderer` (mais fiel, mais código) — **decidir antes de codar**. Puppeteer/`md-to-pdf` descartados pelo peso no Tauri.
- **Anki CSV vs .apkg**: CSV (v1, zero deps, usuário mapeia colunas no import) vs .apkg (UX melhor, +deps/risco de empacotamento). Sugestão: CSV agora, .apkg como follow-up.
- **Extração de Q&A frágil por regex**: depende do LLM seguir o formato `P:/R:` do template. Outros templates (`meeting-summary`, `action-items`) podem não ter Q&A → Anki gera CSV vazio. Decisão: na UI, **só mostrar/habilitar o card Anki** quando `extractQAPairs` achar pares (precisa de um endpoint/flag de "tem Q&A?") ou avisar "nenhum flashcard encontrado nesta sessão".
- **Empacotamento de assets** (fontes do pdfkit) no `build-server.mjs`/esbuild — risco de o bundle subir mas o PDF crashar em runtime por fonte faltando. Mitigar usando fonte embutida (Helvetica) e validando no `smoke:server`.
- **Tamanho do bundle**: cada lib nova engorda `resources/server-bundle.mjs`; `docx` + `pdfkit` somam alguns MB — aceitável, mas monitorar.
