# 14 — Onboarding + auto-diagnóstico

> Status: proposta · Esforço: 🟢 · Impacto: alto (reduz abandono e suporte) · Depende de: nada

## Problema

A primeira execução joga o usuário direto no Dashboard sem nenhuma orientação. Para gravar algo útil ele precisa, sozinho:

1. Descobrir qual é o "device de loopback" certo (`Stereo Mix` no Windows, `*.monitor` no Linux) — termos que ninguém fora de áudio conhece.
2. Decidir entre análise local (Ollama) e nuvem (Groq), e — se Groq — ir no `console.groq.com`, criar conta, gerar uma chave `gsk_...` e colar em Settings.
3. Confiar que o áudio está realmente sendo capturado.

O resultado clássico: o usuário escolhe o device errado (ou o microfone em vez do loopback), grava 40 minutos **em silêncio** e só descobre depois de transcrever (que volta vazio ou com "thank you. / you" — os artefatos de silêncio do Whisper já hardcoded em `server.ts:338-347`). Isso gera abandono e tickets de suporte.

Além disso:

- Erros são jogados num **toast genérico** sem ação. Se o Ollama não está rodando, a mensagem é literalmente `Ollama analysis failed: fetch failed` — o usuário não sabe que precisa instalar/subir o Ollama.
- A lista de devices pode ficar **travada em "Loading devices..."** sem nenhum botão de retry visível no Dashboard.

## Como está hoje

**(a) Não existe onboarding.** O app abre no Dashboard (`apps/gui/src/store/index.ts:107` `view: "dashboard"`). `init()` (`store/index.ts:386-419`) só busca status/devices/sessions/config/templates. Não há nenhuma flag de "primeira execução" nem wizard. A escolha de modo local-vs-Groq nem existe como conceito na UI: o provider de análise é só exibido como texto read-only em Settings (`SettingsPage.tsx:273-275`, `config.analysisProvider`).

**Escolha de device:** só dentro de Settings (`SettingsPage.tsx:85-102`), com um `<select>` que mostra `Loading devices...` enquanto `devices.length === 0` (`SettingsPage.tsx:99-101`). O default automático é escolhido em `store/index.ts:183-186` (prefere `isDefault && type === "monitor"`).

**Chave Groq:** entrada só em Settings (`SettingsPage.tsx:166-270`); validação de formato `^gsk_[a-zA-Z0-9]{20,}$` no cliente (`SettingsPage.tsx:219`) e no servidor (`server.ts:1024`). Persistida via `POST /api/config/groq-key` (`server.ts:998-1056`).

**(b) Aviso de áudio silencioso: não existe.** O nível de áudio nunca é medido. O endpoint `GET /api/recording/levels` (`server.ts:507-526`) tem nome enganoso — só devolve **estado de mute**, com `volume` hardcoded em `1` (`server.ts:510-518`); nunca lê o WAV. Na UI, `RecordingPage.tsx:43-57` faz poll desse endpoint só para os botões de mute. A `AudioWaveform` (`RecordingPage.tsx:92`) é puramente decorativa (`isActive={!systemMuted}` — barras animadas, não reflete áudio real). Duração é calculada lendo o header WAV em `getAudioDuration` (`server.ts:195-248`), mas amplitude/RMS nunca é tocada.

**(c) Erros viram toast genérico.** Toda action do store faz `set({ error: err.message })` (ex.: `analyzeSession` em `store/index.ts:277-282`, `transcribeSession` em `:264-269`, `startRecording` em `:142-146`). O App renderiza um único toast burro com o texto cru e um X (`App.tsx:43-53`). Mensagens cruas atuais:

- Ollama down → `Ollama analysis failed: <fetch error>` (`packages/core/src/adapters/analysis/ollama.ts:51-53`).
- Sem chave Groq na transcrição → `GROQ_API_KEY not set. Configure in Settings.` (`server.ts:538-543`).
- Sem transcript ao analisar → `No transcript found for session. Transcribe first.` (`server.ts:599-605`).
- Falha no test sound → `Failed to play test sound` (`server.ts:315`).

Nenhuma traz botão/link de ação.

**(d) Refresh de devices.** Há auto-retry (8× a cada 800ms em `store/index.ts:177-194`; e Settings re-fetcha ao abrir se vazio em `SettingsPage.tsx:31-34`), mas **não há botão manual** em lugar nenhum. Se os 8 retries falham, o select fica preso em "Loading devices..." e a única saída é reiniciar o app.

## O que precisa ser feito

1. **Wizard de onboarding (1ª execução)** com 3 passos: (1) escolher modo Local grátis vs Groq rápido; (2) configurar/testar device de captura medindo nível real; (3) opcional chave Groq. Persistir um flag `onboardingDone`.
2. **Medição de nível de áudio real** no backend (peak/RMS em dB lendo o WAV) + sinal na UI de gravação quando ~silêncio (≈ −90 dB), tanto durante o wizard ("Test Capture") quanto ao vivo na `RecordingPage`.
3. **Erros acionáveis**: mapear códigos de erro no backend e renderizar toasts com botão/link de ação no frontend.
4. **Botão de refresh manual** de devices em Settings e no estado vazio do wizard.

## Como implementar

### Arquivos tocados

- `apps/gui/server.ts` — novos endpoints `GET /api/audio/level`, `GET /api/services/status`; campo `code` nos erros existentes.
- `apps/gui/src/store/index.ts` — flag de onboarding, `refreshDevices`, `pickMode`.
- `apps/gui/src/features/onboarding/OnboardingWizard.tsx` — **novo**.
- `apps/gui/src/features/recording/RecordingPage.tsx` — badge de silêncio ao vivo.
- `apps/gui/src/features/settings/SettingsPage.tsx` — botão refresh.
- `apps/gui/src/shared/lib/api.ts` — `getAudioLevel`, `getServicesStatus`, tipo de erro com `code`.
- `apps/gui/src/App.tsx` — montar wizard + toast acionável.
- (reaproveitar a lógica de leitura de WAV/dB já existente na skill `audio-diag` para o medidor do backend).

### (b) Backend — medir nível de áudio (a parte central)

Adicionar um helper ao lado de `getAudioDuration` (`server.ts:195`) que lê amostras PCM (não só o header) e devolve peak/RMS em dBFS. Reusa o mesmo *walk* de chunks RIFF já validado em `getAudioDuration` (pula `LIST`/`fact`, acha `data`). Para "ao vivo" lê **a cauda do chunk mais recente** (últimos ~N KB), barato e sem ffmpeg:

```ts
// server.ts — perto de getAudioDuration (~195)
const SILENCE_DBFS = -80; // abaixo disso = "praticamente mudo"

function measureChunkLevel(filePath: string, tailBytes = 256 * 1024) {
	const fd = fs.openSync(filePath, "r");
	try {
		const head = Buffer.alloc(4096);
		const read = fs.readSync(fd, head, 0, 4096, 0);
		const stat = fs.statSync(filePath);
		// walk idêntico ao de getAudioDuration p/ achar fmt + offset do data
		let channels = 0, bits = 0, dataOffset = 44;
		let pos = 12;
		while (pos + 8 <= read) {
			const id = head.toString("ascii", pos, pos + 4);
			const size = head.readUInt32LE(pos + 4);
			if (id === "fmt ") { channels = head.readUInt16LE(pos + 10); bits = head.readUInt16LE(pos + 22); }
			else if (id === "data") { dataOffset = pos + 8; break; }
			pos += 8 + size + (size & 1);
		}
		if (bits !== 16) return { peakDb: -Infinity, rmsDb: -Infinity, samples: 0 };
		// só a cauda: nível "agora"
		const start = Math.max(dataOffset, stat.size - tailBytes);
		const len = stat.size - start;
		if (len <= 0) return { peakDb: -Infinity, rmsDb: -Infinity, samples: 0 };
		const buf = Buffer.alloc(len);
		fs.readSync(fd, buf, 0, len, start);
		let peak = 0, sumSq = 0, n = 0;
		for (let i = 0; i + 1 < buf.length; i += 2) {
			const s = buf.readInt16LE(i) / 32768;
			const a = Math.abs(s);
			if (a > peak) peak = a;
			sumSq += s * s; n++;
		}
		const rms = n ? Math.sqrt(sumSq / n) : 0;
		const db = (x: number) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
		return { peakDb: db(peak), rmsDb: db(rms), samples: n };
	} finally {
		fs.closeSync(fd);
	}
}
```

Endpoint novo (perto de `/api/recording/levels`, `server.ts:507`):

```ts
// GET /api/audio/level — nível REAL do áudio (peak/RMS dBFS) do chunk mais recente
if (route === "/api/audio/level" && req.method === "GET") {
	if (!activeSessionId) return json(res, { active: false });
	const audioDir = path.join(dataDir, "sessions", activeSessionId, "audio");
	const wavs = fs.existsSync(audioDir)
		? fs.readdirSync(audioDir).filter((f) => f.endsWith(".wav")).sort()
		: [];
	if (wavs.length === 0) return json(res, { active: true, ready: false });
	const last = path.join(audioDir, wavs[wavs.length - 1]!);
	const lvl = measureChunkLevel(last);
	return json(res, {
		active: true, ready: true,
		peakDb: lvl.peakDb, rmsDb: lvl.rmsDb,
		silent: lvl.peakDb < SILENCE_DBFS,
	});
}
```

Decisão sobre **onde medir**: a cauda do chunk mais recente é a opção mais barata e não exige tocar no `wasapi_capture.rs` (Windows) nem no `ffmpeg-pulse.ts` (Linux). O primeiro chunk leva até `config.audio.chunkSeconds` (120s default) para existir — para feedback rápido durante a gravação isso é tarde demais. **Mitigação**: usar o "Test Capture" do wizard (grava 3s e mede — ver abaixo) para o feedback imediato, e o poll ao vivo só como rede de segurança contínua. (Opção futura: reduzir `chunkSeconds` ou expor um nível incremental via stdin do binário nativo — fora do escopo deste item.)

### (a) Wizard de onboarding

Persistência do flag em `localStorage` (mesma convenção já usada para device em `store/index.ts:201`):

```ts
// store/index.ts — adicionar ao estado
onboardingDone: localStorage.getItem("listening-resume:onboarded") === "1",
finishOnboarding: () => {
	localStorage.setItem("listening-resume:onboarded", "1");
	set({ onboardingDone: true, view: "dashboard" });
},
pickMode: (mode: "local" | "groq") => set({ analysisMode: mode }),
refreshDevices: async () => { set({ devices: [] }); await get().fetchDevices(); },
```

Montagem em `App.tsx` (antes do `<Sidebar/main>`):

```tsx
const { onboardingDone } = useStore();
if (!onboardingDone) return <OnboardingWizard />;
```

`OnboardingWizard.tsx` — 3 passos com estado local `step`:

- **Passo 1 — Modo de análise.** Dois cards: "Local (grátis, privado — usa Ollama)" e "Rápido (nuvem — usa Groq)". Selecionar grava `analysisMode`. Texto deixa claro: Local não precisa de chave mas exige Ollama instalado; Groq exige chave. (A transcrição Whisper hoje sempre é Groq — `server.ts:546`; deixar nota: "transcrição usa Groq; modo Local cobre só a análise" para não prometer 100% offline.)
- **Passo 2 — Device de captura.** Reusa o `<select>` filtrado por `type !== "microphone"` (igual `SettingsPage.tsx:92-98`) + botão **"Testar captação"** que:
  1. chama `api.startRecording(device, null)`,
  2. espera ~3s (`setTimeout`),
  3. chama `api.stopRecording()`,
  4. lê o último chunk via `GET /api/audio/level` (ou um `?sessionId=` variante já que a sessão acabou — alternativamente medir antes do stop),
  5. mostra resultado: `peakDb >= -80` → verde "Áudio detectado (pico {peakDb} dB)"; senão vermelho com **detecção de silêncio** (mensagem acionável, ver (c)). Se `devices.length === 0`, mostrar botão **Atualizar lista**.
- **Passo 3 — Chave Groq (condicional).** Só se `analysisMode === "groq"` (ou sempre, já que transcrição usa Groq — recomendado mostrar sempre, marcado "opcional, mas necessário para transcrição"). Reusa input + validação `^gsk_[a-zA-Z0-9]{20,}$` e `api.setGroqKey` (igual `SettingsPage.tsx:204-239`). Link para `console.groq.com/keys` (já existe em `SettingsPage.tsx:259-266`).

Botão final "Concluir" → `finishOnboarding()`.

### (c) Erros acionáveis

Adicionar campo `code` nas respostas de erro do backend e mapear no frontend. Ex. no analyze (`server.ts:629-635`), distinguir Ollama-down:

```ts
} catch (err) {
	repo.updateSession(session.id, { status: prevStatus === "completed" ? "completed" : "transcribed" });
	const msg = err instanceof Error ? err.message : String(err);
	const code = /ollama/i.test(msg) && /fetch failed|ECONNREFUSED|11434/i.test(msg)
		? "OLLAMA_DOWN" : "ANALYSIS_FAILED";
	return json(res, { error: msg, code }, 500);
}
```

(Hoje esse `catch` faz `throw err`, que cai no handler genérico — precisa virar `json(...)` com `code`.)

Mapa de códigos → toast acionável no frontend. `request()` em `api.ts:11-15` deve propagar `code`:

```ts
if (!res.ok) {
	const err = await res.json().catch(() => ({ error: res.statusText }));
	const e = new Error(err.error ?? `Request failed: ${res.status}`) as Error & { code?: string };
	e.code = err.code;
	throw e;
}
```

E o store guarda `{ message, code }` em vez de string solta (`error` vira objeto). Toast em `App.tsx:43-53` ganha ação por código:

| code | mensagem | ação |
|------|----------|------|
| `OLLAMA_DOWN` | "Ollama não está rodando." | botão "Como iniciar" → abre doc/`ollama serve`; ou "Usar Groq" → muda provider |
| `GROQ_KEY_MISSING` (de `server.ts:538`) | "Chave Groq não configurada." | botão "Abrir Settings" → `setView("settings")` |
| `NO_TRANSCRIPT` (de `server.ts:599`) | "Sem transcrição ainda." | botão "Transcrever" → `transcribeSession(id)` |
| `AUDIO_SILENT` (novo, do poll de nível) | "Não detectei áudio — dispositivo certo?" | botão "Trocar dispositivo" → Settings |
| `TEST_SOUND_FAILED` (de `server.ts:315`) | "Não consegui tocar o som de teste." | — |

### (b) UI — sinal de silêncio ao vivo na RecordingPage

Adicionar um poll de nível ao lado do poll de mute (`RecordingPage.tsx:43-57`):

```tsx
const [silent, setSilent] = useState(false);
useEffect(() => {
	if (!isRecording) return;
	const tick = async () => {
		try {
			const l = await api.getAudioLevel();
			if (l.active && l.ready) setSilent(!!l.silent);
		} catch { /* ignore */ }
	};
	const id = setInterval(tick, 3000);
	return () => clearInterval(id);
}, [isRecording]);
```

Renderizar um banner persistente acima do tempo (`RecordingPage.tsx:96`) quando `silent`: fundo `bg-recording/10`, texto "Não detectei áudio — confira o dispositivo de captação" + botão para Settings. `data-testid="silent-audio-warning"` para Playwright.

### (d) Refresh manual de devices

Em `SettingsPage.tsx`, ao lado do `<select>` de Recording Device (`:85-102`), adicionar botão (ícone `RefreshCw` do lucide) com `onClick={refreshDevices}` e `data-testid="refresh-devices-button"`; estado de loading quando `devices.length === 0`. Mesmo botão no estado vazio do Passo 2 do wizard. `refreshDevices` (acima) zera a lista e re-dispara `fetchDevices` (que já tem o retry de `store/index.ts:177-194`).

## Plano de testes

- **Unit (vitest, core/server helper):** `measureChunkLevel` — WAV de silêncio puro → `peakDb === -Infinity` (silent true); WAV com tom 0 dBFS → `peakDb ≈ 0`; WAV com `LIST`/`fact` antes de `data` → ainda acha o offset certo (mesmo risco já coberto por `getAudioDuration`).
- **Integração (skill `audio-diag` / `pipeline-test`):** gravar 3s com device de loopback real → `GET /api/audio/level` retorna `silent:false`; gravar com device errado (mic sem som) → `silent:true`. Comparar peak/RMS com o que a skill `audio-diag` mede no mesmo WAV (devem bater dentro de ~1 dB).
- **E2E UI (Playwright MCP em `localhost:1420`):**
  - 1ª execução (localStorage limpo) → wizard aparece; concluir → não reaparece no reload.
  - Passo 2 "Testar captação" sem áudio → `silent-audio-warning` visível.
  - Forçar `/api/devices` a falhar → "Loading devices..." + botão `refresh-devices-button` funciona.
  - Disparar analyze com Ollama parado → toast com botão de ação (`OLLAMA_DOWN`).
- **Regressão:** garantir que `getAudioDuration` não foi alterado e durações de sessões existentes continuam corretas.

## Riscos / decisões em aberto

- **Latência do nível ao vivo:** com `chunkSeconds=120` (default), o primeiro chunk demora 2min — o aviso de silêncio ao vivo só dispara depois disso. O "Test Capture" de 3s no wizard cobre o caso da 1ª execução; para gravações longas considerar reduzir `chunkSeconds` ou expor nível incremental via stdin do `wasapi_capture.rs` (escopo futuro).
- **Custo de I/O do poll:** ler 256 KB da cauda a cada 3s é barato, mas em chunk sendo escrito (`wasapi`/ffmpeg ainda gravando) pode haver leitura parcial — tratar `len<=0`/buffer ímpar com guardas (já no código acima).
- **Threshold de silêncio:** −80 dBFS é um chute razoável; ruído de fundo real pode ficar em −60/−70. Validar com a skill `audio-diag` antes de fixar; talvez expor como constante configurável.
- **"Local 100% offline" é falso hoje:** a transcrição sempre usa Groq Whisper (`server.ts:546`). O texto do wizard precisa ser honesto ("modo Local = análise privada; transcrição ainda usa Groq") para não gerar expectativa errada — possível item futuro: Whisper.cpp local (já existe `WhisperCppAdapter`).
- **Mudança de shape do `error` no store** (string → `{message, code}`) toca todos os `set({ error })` (vários pontos em `store/index.ts`); fazer de uma vez ou manter retrocompat aceitando ambos no `App.tsx`.
- **Onboarding por máquina, não por usuário:** flag em `localStorage` reseta se o webview limpar storage; aceitável para um app desktop, mas se quiser persistência forte, gravar no `.env`/config dir do backend.
