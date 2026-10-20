# 01 — Expor whisper.cpp na UI + modo "100% local" com um clique

> Status: proposta · Esforço: 🟡 · Impacto: alto · Depende de: nada

## Problema

O adapter de transcrição local já existe (`WhisperCppAdapter`) e é exportado pelo
core, mas **nunca é instanciado**. O endpoint de transcrição do GUI server cria
sempre um `GroqWhisperAdapter` e ainda exige `groqApiKey`, retornando 500 quando
a chave não está configurada. Resultado: o usuário é **forçado ao Groq** (cloud)
para qualquer transcrição, mesmo tendo whisper.cpp instalado. Não há nenhum
toggle de provider nas Settings (a seção "Transcription" é só leitura) nem um
caminho fácil para rodar o app **100% local** (whisper.cpp + Ollama), o que é um
dos diferenciais de privacidade do produto.

## Como está hoje

- `WhisperCppAdapter` existe e implementa `TranscriberPort`, mas o construtor
  recebe `binaryPath`, `modelPath`, `model` sem defaults úteis para o modelPath:
  `packages/core/src/adapters/transcription/whisper-cpp.ts:15`.
- O enum de provider de transcrição já lista `whisper-cpp`, então o schema aceita
  o valor — mas nada o usa: `packages/core/src/config/schema.ts:17` (e o fallback
  default já é `whisper-cpp` em `schema.ts:23`).
- O endpoint `POST /api/sessions/:id/transcribe` **só** monta Groq e exige a
  chave: `apps/gui/server.ts:529` (handler), checagem `if (!groqApiKey)` em
  `apps/gui/server.ts:538`, instanciação `new GroqWhisperAdapter(...)` em
  `apps/gui/server.ts:546`. Ignora `config.transcription.provider`.
- `GET /api/config` expõe `transcription.provider` / `transcription.model`
  (apenas leitura): `apps/gui/server.ts:979`. Não há endpoint para **alterar** o
  provider de transcrição (existe `POST /api/config/mic` em `server.ts:1080` e
  `POST /api/config/export-dir` em `server.ts:1173` como referência de padrão).
- O config em memória (`const config = loadConfig()` em `apps/gui/server.ts:61`)
  é mutado em runtime (ex.: `config.audio.micDevice` em `server.ts:1083`) mas
  **não é persistido em `config.toml`** — só o `.env` da Groq key é gravado
  (`apps/gui/server.ts:1047`). Logo, mudar o provider hoje não sobreviveria a um
  restart.
- As Settings mostram provider/model de transcrição como texto estático:
  `apps/gui/src/features/settings/SettingsPage.tsx:154` (seção "Transcription",
  `SettingRow` em `SettingsPage.tsx:155-159`). O tipo do config no frontend está
  em `apps/gui/src/shared/lib/api.ts:161` (`transcription: { provider, model }`).
- `loadConfig` lê TOML de `~/.config/listening-resume/config.toml`
  (`packages/core/src/config/loader.ts:16`) e converte snake_case→camelCase
  (`loader.ts:50`), mas **não há writer** de config.toml em lugar nenhum.

## O que precisa ser feito

1. Tornar `whisper-cpp` um provider de transcrição realmente selecionável e usado
   pelo endpoint de transcrição (fábrica de transcriber por provider).
2. Resolver binário e modelo do whisper.cpp: caminho do binário (`whisper-cli`/
   `whisper-cpp`) e caminho do modelo `.bin` (ggml), com download assistido ou
   instrução clara quando ausente.
3. Adicionar endpoint para alterar provider/model de transcrição + persistir em
   `config.toml` (caso contrário a escolha se perde no restart).
4. UI: toggle de provider na seção Transcription + botão "Modo 100% local" que
   seta transcrição=whisper-cpp e análise=ollama de uma vez, com checagem de
   disponibilidade (modelo baixado? Ollama no ar?).

## Como implementar

### A. Core — defaults e resolução de caminhos do whisper.cpp

Editar `packages/core/src/config/schema.ts` para guardar binário e modelo do
whisper.cpp (hoje só há `model`):

```ts
export const transcriptionConfigSchema = z.object({
	provider: z.enum(["groq", "whisper-cpp", "openai"]).default("groq"),
	model: z.string().default("whisper-large-v3-turbo"),
	language: z.string().default("auto"),
	prompt: z.string().default(""),
	// novos campos para o modo local
	whisperCppBinary: z.string().default("whisper-cli"),
	whisperCppModelPath: z.string().default(""), // vazio => resolver default por plataforma
	whisperCppModel: z.string().default("ggml-small"),
	fallback: z
		.object({
			provider: z.enum(["groq", "whisper-cpp", "openai"]).default("whisper-cpp"),
			model: z.string().default("small"),
		})
		.optional(),
});
```

Criar um helper de resolução de modelo em
`packages/core/src/adapters/transcription/whisper-cpp.ts` (ou um util novo
`whisper-model.ts`) que, dado o dataDir, devolve o caminho default
`{dataDir}/models/whisper/{whisperCppModel}.bin` e expõe um `modelExists()`:

```ts
import fs from "node:fs";
import path from "node:path";

export function resolveWhisperModelPath(dataDir: string, model: string, override?: string) {
	if (override) return override;
	return path.join(dataDir, "models", "whisper", `${model}.bin`);
}
export function whisperModelExists(p: string) {
	return !!p && fs.existsSync(p);
}
```

Exportar do barrel `packages/core/src/index.ts` (já exporta
`WhisperCppAdapter` em `index.ts:12`; adicionar os helpers).

### B. Core — writer de config.toml (persistência)

Não existe writer hoje. Criar `packages/core/src/config/writer.ts` que faz
merge parcial e grava em `~/.config/listening-resume/config.toml` (mesmo
`CONFIG_DIR`/`CONFIG_FILE` de `loader.ts:9`). Usar `smol-toml` (já dependência,
ver `loader.ts:5`) com a função `stringify`, convertendo camelCase→snake_case
(inverso de `mapConfig` em `loader.ts:50`):

```ts
import fs from "node:fs";
import { stringify as stringifyToml } from "smol-toml";
import { CONFIG_DIR, CONFIG_FILE } from "./loader.js"; // exportar essas consts

export function writeConfigPatch(patch: Record<string, unknown>) {
	const current = fs.existsSync(CONFIG_FILE)
		? (parseToml(fs.readFileSync(CONFIG_FILE, "utf-8")) as Record<string, unknown>)
		: {};
	const merged = deepMerge(current, toSnake(patch));
	fs.mkdirSync(CONFIG_DIR, { recursive: true });
	fs.writeFileSync(CONFIG_FILE, stringifyToml(merged), "utf-8");
}
```

Exportar `CONFIG_DIR`/`CONFIG_FILE` de `loader.ts` e `writeConfigPatch` de
`index.ts`.

### C. GUI server — fábrica de transcriber por provider

Em `apps/gui/server.ts`, importar `WhisperCppAdapter` e os helpers do core
(adicionar ao import de `@listening-resume/core` em `server.ts:5-20`).

Substituir o trecho `apps/gui/server.ts:538-549` (checagem de groqApiKey +
`new GroqWhisperAdapter`) por uma seleção baseada em `config.transcription.provider`:

```ts
const provider = config.transcription.provider;
let transcriber;
if (provider === "whisper-cpp") {
	const modelPath = resolveWhisperModelPath(
		dataDir,
		config.transcription.whisperCppModel,
		config.transcription.whisperCppModelPath || undefined,
	);
	if (!whisperModelExists(modelPath)) {
		return json(res, {
			error: "Modelo whisper.cpp não encontrado. Baixe em Settings → Modo local.",
			code: "WHISPER_MODEL_MISSING",
		}, 400);
	}
	transcriber = new WhisperCppAdapter(
		config.transcription.whisperCppBinary,
		modelPath,
		config.transcription.whisperCppModel,
	);
} else {
	if (!groqApiKey) {
		return json(res, { error: "GROQ_API_KEY not set. Configure in Settings." }, 500);
	}
	transcriber = new GroqWhisperAdapter(groqApiKey, config.transcription.model);
}
```

O `TranscriptionService` já roda agnóstico ao provider (rate-limiter só importa
para Groq, mas é inofensivo para local; ver `transcription.service.ts:37`).
Opcional: quando provider for `whisper-cpp`, passar limites "infinitos"
(`requestsPerMinute: Number.MAX_SAFE_INTEGER`) para o `SlidingWindowLimiter`
(`server.ts:550`) — sem isso o limiter não bloqueia local de qualquer forma,
mas deixa explícito.

### D. GUI server — endpoint de provider de transcrição

Adicionar perto dos outros handlers de config (após `server.ts:1092`):

```ts
// POST /api/config/transcription — set transcription provider/model
if (route === "/api/config/transcription" && req.method === "POST") {
	const body = await readBody(req);
	const { provider, model } = body ? JSON.parse(body) : {};
	if (provider && !["groq", "whisper-cpp"].includes(provider)) {
		return json(res, { error: "Invalid provider" }, 400);
	}
	if (provider) config.transcription.provider = provider;
	if (model) config.transcription.model = model;
	writeConfigPatch({ transcription: { provider: config.transcription.provider, model: config.transcription.model } });
	return json(res, { ok: true, transcription: config.transcription });
}
```

Endpoint para o "Modo 100% local" (seta transcrição + análise de uma vez):

```ts
// POST /api/config/local-mode — switch everything to local providers
if (route === "/api/config/local-mode" && req.method === "POST") {
	config.transcription.provider = "whisper-cpp";
	config.analysis.provider = "ollama";
	writeConfigPatch({
		transcription: { provider: "whisper-cpp" },
		analysis: { provider: "ollama" },
	});
	const ollamaUp = await new OllamaAdapter(config.analysis.model).isAvailable();
	const modelPath = resolveWhisperModelPath(dataDir, config.transcription.whisperCppModel, config.transcription.whisperCppModelPath || undefined);
	return json(res, { ok: true, ollamaUp, whisperModelReady: whisperModelExists(modelPath) });
}
```

Endpoint de status/download do modelo whisper (download streaming de GGUF da
Hugging Face, ex.: `ggml-org/whisper.cpp`):

```ts
// GET /api/config/whisper-model — status do modelo local
// POST /api/config/whisper-model/download — baixa {model} para {dataDir}/models/whisper
```

Implementar o download com `https.get` + `fs.createWriteStream`, validando
tamanho final; reportar progresso via SSE ou polling de um arquivo `.part`.
Decisão em aberto (ver Riscos) sobre empacotar um modelo no instalador vs.
baixar sob demanda.

Atualizar também o payload de `GET /api/config` (`server.ts:979-982`) para
incluir o estado local:

```ts
transcription: {
	provider: config.transcription.provider,
	model: config.transcription.model,
	whisperModelReady: whisperModelExists(resolveWhisperModelPath(dataDir, config.transcription.whisperCppModel, config.transcription.whisperCppModelPath || undefined)),
},
```

### E. Frontend — tipos e API client

Em `apps/gui/src/shared/lib/api.ts`:

- Estender o retorno de `getConfig` (`api.ts:161`) com `whisperModelReady?: boolean`.
- Adicionar métodos:

```ts
async setTranscriptionProvider(provider: string, model?: string) {
	return request("/config/transcription", { method: "POST", body: JSON.stringify({ provider, model }) });
},
async enableLocalMode() {
	return request("/config/local-mode", { method: "POST" });
},
async downloadWhisperModel() {
	return request("/config/whisper-model/download", { method: "POST" });
},
```

### F. Frontend — UI nas Settings

Em `apps/gui/src/features/settings/SettingsPage.tsx`, na seção "Transcription"
(`SettingsPage.tsx:154`), trocar o `SettingRow` de Provider por um `<select>`
(seguir o padrão visual do device select em `SettingsPage.tsx:85-102`):

```tsx
<select
	value={config.transcriptionProvider}
	onChange={async (e) => { await api.setTranscriptionProvider(e.target.value); await fetchConfig(); }}
	aria-label="Transcription provider"
	data-testid="transcription-provider-select"
	className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm ..."
>
	<option value="groq">Groq Whisper (cloud, rápido)</option>
	<option value="whisper-cpp">whisper.cpp (local, privado)</option>
</select>
```

Quando `whisper-cpp` estiver selecionado e `whisperModelReady === false`, mostrar
aviso + botão "Baixar modelo" chamando `api.downloadWhisperModel()` com estado de
progresso (reaproveitar o padrão de `keyStatus`/`keySaving` em
`SettingsPage.tsx:39-43`).

Adicionar um card de destaque "Modo 100% local" (acima de "Groq API Key",
`SettingsPage.tsx:167`):

```tsx
<SettingsSection title="Privacidade" icon={Server}>
	<div className="px-4 py-3">
		<p className="text-sm text-text-secondary mb-2">
			Roda transcrição (whisper.cpp) e análise (Ollama) totalmente no seu
			computador, sem enviar áudio para a nuvem.
		</p>
		<button
			data-testid="local-mode-button"
			onClick={async () => {
				const r = await api.enableLocalMode();
				await fetchConfig();
				// mostrar avisos se !r.ollamaUp ou !r.whisperModelReady
			}}
			className="flex items-center gap-2 px-3 py-2 rounded-lg bg-accent/10 border border-accent/30 text-accent text-sm font-medium ..."
		>
			Ativar Modo 100% local
		</button>
	</div>
</SettingsSection>
```

O `config` do store já é populado por `fetchConfig` (usado em
`SettingsPage.tsx:24` e em vários handlers). Garantir que o store mapeie os novos
campos (`transcriptionProvider`, `whisperModelReady`) — verificar o reducer/store
que monta `config` a partir de `api.getConfig()`.

## Plano de testes

- Unit (core, vitest): `resolveWhisperModelPath` (com/sem override),
  `whisperModelExists`, `writeConfigPatch` (merge parcial não apaga outras seções;
  round-trip camel↔snake). Rodar:
  `pnpm --filter @listening-resume/core exec vitest run src/config`.
- Unit: `WhisperCppAdapter.transcribe` já tem o parser de `--output-json`
  (`whisper-cpp.ts:50`); adicionar teste com um JSON fixture de exemplo.
- Integração/manual server: com provider=groq, fluxo atual inalterado; com
  provider=whisper-cpp e modelo ausente → 400 `WHISPER_MODEL_MISSING`; com modelo
  presente e binário fake → transcreve. Usar a skill `pipeline-test` (record →
  transcribe → analyze → export) contra a API na 3456.
- Persistência: setar provider via `POST /api/config/transcription`, reiniciar o
  server (`pnpm dev:server`), confirmar via `GET /api/config` que persistiu no
  `config.toml`.
- UI (Playwright MCP em `http://localhost:1420`): selecionar provider no
  `transcription-provider-select`, clicar `local-mode-button`, verificar avisos
  de Ollama/modelo. Smoke do bundle: `pnpm smoke:server`.

## Riscos / decisões em aberto

- **Binário whisper.cpp não empacotado**: o instalador Windows/Linux não inclui
  `whisper-cli`. Decidir entre (a) bundlar o binário (aumenta tamanho, precisa
  build por plataforma e ABI), (b) detectar instalação do usuário no PATH e só
  habilitar o modo se existir, ou (c) usar whisper via WASM/addon. MVP sugerido:
  (b) — detectar e exibir instruções; o toggle fica desabilitado se ausente.
- **Tamanho do modelo GGML**: `small` ≈ 466 MB, `medium` ≈ 1.5 GB. Download sob
  demanda evita inchar o instalador, mas exige UX de progresso e tratamento de
  rede. Validar checksum do arquivo baixado.
- **Persistência de config.toml**: hoje o app só persiste o `.env` da Groq.
  Introduzir um writer cria uma nova fonte de verdade — atenção para não conflitar
  com edições manuais do `config.toml` (fazer merge, nunca sobrescrever o arquivo
  inteiro). Confirmar que `smol-toml` expõe `stringify`.
- **Rate-limiter no caminho local**: o `SlidingWindowLimiter`
  (`utils/rate-limiter.ts`) é criado sempre no endpoint de transcribe
  (`server.ts:550`); inofensivo para local, mas ver spec 15 para roteamento mais
  inteligente.
- **Idioma**: `WhisperCppAdapter` passa `-l auto` (`whisper-cpp.ts:30`); confirmar
  que a build do whisper.cpp do usuário suporta autodetect (versões antigas não).
