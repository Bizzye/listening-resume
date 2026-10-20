# Listening Resume — Brainstorm de Lançamento

> Documento de ideias para transformar um projeto pessoal em produto.
> Cobre: posicionamento, monetização, redução de custo, features, UX/design,
> patterns de arquitetura e roadmap. Cada item tem **impacto** e **esforço**
> estimados (🟢 baixo / 🟡 médio / 🔴 alto) para ajudar a priorizar.

---

## 1. Posicionamento — que produto é esse?

Hoje o app faz: **captura áudio do sistema → transcreve (Groq Whisper) → gera notas com IA (templates)**. Roda local (Tauri), dados ficam na máquina.

O grande diferencial: **captura o áudio de QUALQUER fonte do sistema** (não só microfone) e é **privado por padrão** (pode rodar 100% local). Isso abre 3 nichos com dores reais:

| Nicho | Dor | Por que esse app encaixa |
|---|---|---|
| **Estudantes** (videoaulas, cursos) | Reassistir aula pra revisar é lento | Template "Extração Total" vira caderno de estudo |
| **Profissionais** (reuniões) | Notas de reunião manuais, Otter/Fireflies são caros e sobem tudo pra nuvem | Resumo de reunião + privacidade local |
| **Criadores/Pesquisadores** (podcasts, entrevistas, lives) | Transcrever conteúdo longo é caro | Transcrição + análise barata/local |

**Escolha de wedge (cunha de entrada):** recomendo focar **estudantes/videoaulas** primeiro — é onde já tem template forte, o público é grande, paga por ferramentas de estudo, e "privacidade" importa menos que "barato e bom". Depois expande pra reuniões (onde privacidade vira o argumento de venda premium).

**Tagline candidata:** *"Grave, transcreva e entenda qualquer áudio do seu computador — sem mandar nada pra nuvem."*

---

## 2. Monetização

A arquitetura local cria um modelo raro e atraente: **o usuário pode trazer a própria chave (BYOK) ou usar tudo local de graça** — então o que se vende é **conveniência, qualidade e features**, não o compute cru.

### 2.1 Modelos possíveis (do mais simples ao mais ambicioso)

**A) Freemium desktop com licença (🟢 simples, bom pra começar)**
- **Grátis:** local-only (whisper.cpp + Ollama), templates builtin, export markdown.
- **Pro (licença paga, ex. R$ 39/mês ou R$ 290 vitalício):**
  - Templates ilimitados + biblioteca de templates premium
  - Export PDF/DOCX/Notion/Anki
  - Busca full-text em todas as sessões
  - Tags, pastas, renomear sessões
  - Transcrição em lote
- Implementação: licença via [Gumroad](https://gumroad.com)/[Lemon Squeezy](https://lemonsqueezy.com) + checagem de chave offline (assinatura). **Não precisa de backend.**

**B) BYOK + camada de conveniência (🟡)**
- Usuário pluga a própria chave Groq/OpenAI (já suportado).
- Você cobra pela **camada acima**: templates premium, sync entre dispositivos, biblioteca de notas.
- Vantagem: custo de IA é do usuário; sua margem é quase 100%.

**C) Managed/SaaS com créditos (🔴 precisa backend)**
- Você hospeda a transcrição/análise; usuário compra créditos (ex. R$ 0,10/min).
- Margem em cima do custo Groq (Groq é barato → margem boa).
- Mais trabalho (backend, billing, abuso), mas menor fricção pro usuário não-técnico.

**D) Marketplace de templates (🟡, complementar)**
- Usuários criam e vendem templates especializados (ex. "Resumo de aula de Medicina", "Ata jurídica", "Code review de tech talk").
- Você fica com % da venda. Cria efeito de rede e conteúdo sem você produzir.

### 2.2 Recomendação de monetização
Começar com **(A) Freemium + licença Pro**, BYOK embutido. Sem backend = lançamento rápido, custo operacional ~zero. Evoluir pra **(C) créditos** só quando houver demanda de usuários não-técnicos que não querem configurar chave.

### 2.3 Sinais de precificação
- Otter.ai: US$ 17/mês. Fireflies: US$ 18/mês. Ambos sobem áudio pra nuvem.
- Seu ângulo: **mais barato + privado + um pagamento vitalício como opção** (estudante adora "compra uma vez").

---

## 3. Redução de custo (técnica)

Boas notícias: dá pra chegar a **custo de IA = zero** porque os adapters locais já existem — só não estão expostos. Em ordem de retorno:

### 3.1 Quick wins (custo já no código, só falta plugar)
- **Expor whisper.cpp na UI 🟢🔥** — o adapter `packages/core/src/adapters/transcription/whisper-cpp.ts` já funciona, mas não está no schema/Settings. Adicionar `whisper-cpp` ao enum de provider + toggle nas Settings **elimina o limite de 7000s/h do Groq** e o custo de transcrição. Maior retorno por esforço de todo o doc.
- **Modo "100% local" com um clique 🟢** — botão nas Settings: usa whisper.cpp + Ollama, nada sai da máquina. Ótimo argumento de marketing e zera custo.
- **Cache de análise 🟢** — hoje re-analisar = nova chamada paga. Guardar `hash(template+transcript) → resultado` na tabela `analyses` e retornar cache. Zero custo em re-análises.

### 3.2 Resolver o teto de contexto (o problema das aulas longas)
- **Chunking map-reduce pra análise 🟡🔥** — hoje a transcrição inteira vai numa chamada só → estoura 12k TPM do Groq free e trunca no Ollama (`num_ctx 8192`). Implementar: dividir transcrição em blocos (~4k tokens), resumir cada um, depois "resumo dos resumos". Permite aula de 1h+ sem upgrade pago e sem truncar. (Já discutido na sessão; é o próximo grande passo de qualidade.)
- **Roteamento por tamanho 🟢** — se transcrição > X tokens, usar Ollama local (sem limite de TPM) em vez de Groq; se curta, Groq (rápido). Decisão automática.
- **num_ctx adaptativo no Ollama 🟢** — dimensionar `num_ctx` ao tamanho real do texto (cap pela VRAM), em vez de fixo. Curto = rápido; longo = cabe.

### 3.3 Reduzir tamanho do app (distribuição mais barata/rápida)
- **ffmpeg é ~150MB do instalador.** Opções: usar build mínimo do ffmpeg (só os codecs usados) ou baixar sob demanda no primeiro uso. 🟡
- **Download de modelos sob demanda** (whisper.cpp/Ollama) em vez de embutir. 🟢

---

## 4. Features / Funcionalidades

### 4.1 P0 — quick wins de alto impacto (🟢, semanas)
- **Renomear sessão + título automático** 🟢 — hoje título é sempre `null`. Gerar título a partir da 1ª análise ("Aula sobre Observabilidade") e permitir editar. Melhora MUITO a navegação.
- **Busca full-text nas transcrições** 🟡 — hoje só filtra por título/ID. Indexar transcrições (SQLite FTS5) e buscar em tudo. Feature que retém usuário.
- **Tags / pastas** 🟡 — organizar por matéria/projeto/cliente.
- **Export PDF e DOCX** 🟡 — markdown não basta pra entregar nota/ata. PDF é o formato que estudante/profissional quer.
- **Export Anki / flashcards** 🟢🔥 — o template já gera Q&A; exportar como deck Anki (.apkg ou CSV) é matador pro nicho estudante.
- **Indicador de quota/uso Groq** 🟢 — avisar antes de estourar o rate limit, não depois.

### 4.2 P1 — diferenciais (🟡)
- **Transcrição ao vivo (streaming)** 🔴 — mostrar texto enquanto grava. É o "uau" que vende, mas é trabalhoso.
- **Pausar/retomar gravação** 🟡 — hoje é só liga/desliga; interrupção obriga nova sessão.
- **Diarização (quem falou o quê)** 🔴 — separar falantes ("Professor:", "Aluno:"). Enorme valor pra reuniões/entrevistas. Pode usar modelos locais (pyannote) ou serviço.
- **Chat com a transcrição** 🟡🔥 — "pergunte qualquer coisa sobre essa aula". RAG simples sobre a transcrição. Muito desejável e reaproveita a infra de análise.
- **Detecção de capítulos/timestamps de tópicos** 🟡 — navegar a gravação por assunto.
- **Tradução** 🟢 — traduzir transcrição/resumo (o Whisper já entrega texto; só pedir tradução ao LLM).

### 4.3 P2 — ambicioso / plataforma (🔴)
- **Sync entre dispositivos** (opcional, criptografado) — desktop + futuro mobile/web.
- **Importar arquivos de áudio/vídeo existentes** 🟢🔥 — não só gravar do sistema: arrastar um `.mp4`/`.mp3` e processar. Expande o público instantaneamente (gente com aulas já baixadas). **Provavelmente devia ser P0/P1 — esforço baixo, mercado grande.**
- **Integração calendário** — detectar reunião e oferecer gravar.
- **Extensão de navegador** — capturar áudio de aba (YouTube, Meet) sem áudio do sistema todo.

> 💡 **Destaque:** "Importar arquivo existente" é provavelmente a feature de maior ROI não-óbvio — transforma o app de "gravador" em "processador de qualquer áudio/vídeo" com pouco código (o pipeline transcribe→analyze já existe; só falta uma entrada de arquivo em vez de chunks de gravação).

---

## 5. Ajustes de funcionalidade e design (UX)

### Funcionalidade
- **Onboarding na 1ª execução** 🟢 — hoje o usuário precisa achar device certo, chave Groq, etc. Um wizard ("Escolha: local grátis ou Groq rápido" → testa áudio → pronto") reduz abandono. Esta sessão mostrou que achar o device certo e o "zerado" confundem.
- **Estado vazio com call-to-action** 🟢 — dashboard vazio devia guiar pra 1ª gravação/importação.
- **Feedback de erro acionável** 🟢 — hoje erros viram toast genérico. Ex.: "Ollama não está rodando → [Como iniciar]"; "Áudio mudo? Confira o dispositivo".
- **Aviso de áudio silencioso** 🟢 — detectar gravação em -90dB (silêncio) e avisar na hora ("não detectei áudio — dispositivo certo?"). Evita exatamente o bug "zerado" desta sessão.
- **Refresh manual da lista de devices** 🟢 — hoje se falha fica "Loading devices..." pra sempre.
- **Seleção de idioma por sessão** 🟢 — hoje só no config global.

### Design
- **i18n (pt-BR / en)** 🟡 — UI é só português. Pra lançar internacional (e o mercado é global), extrair strings. Decidir cedo evita retrabalho.
- **Tema claro/escuro** 🟢 — provavelmente já tem base no Tailwind; expor toggle.
- **Visual de progresso dos estágios** 🟢 — mostrar a esteira `gravando → transcrevendo → analisando` como stepper, não só badge.
- **Player de áudio mais robusto** 🟡 — a posição é estimada no cliente e pode driftar; seek no Windows tem fallback ruim. Melhorar dá sensação de produto polido.

---

## 6. Patterns de arquitetura (pra facilitar features futuras)

A base hexagonal (ports/adapters) é boa, mas há atritos que vão doer conforme crescer. Resolver agora é barato; depois é caro.

### 6.1 Atritos prioritários
- **Quebrar o `server.ts` (1238 linhas, "god file") 🟡🔥** — extrair handlers por domínio (`handlers/recording.ts`, `handlers/analysis.ts`, ...) e um `createApiRouter()` testável. Hoje qualquer feature toca esse arquivo gigante e nada dele é testado.
- **Eliminar duplicação de parsing de WAV 🟢** — `getAudioDuration` (server.ts) e `RecordingService` têm lógicas diferentes de ler header WAV (a do server, corrigida nesta sessão, é a robusta). Extrair um `WavParser` único em `core` e os dois usarem. (CLAUDE.md já aponta essa dívida.)
- **Completar o port do repositório 🟢** — métodos de template (`getTemplate`, `createTemplate`, ...) existem no `SQLiteRepository` mas não no port `SessionRepositoryPort`. O repositório não é realmente "trocável" enquanto isso. Renomear pra `SessionStore` e completar a interface.
- **Unificar carregamento de env/config 🟢** — hoje há 3 caminhos diferentes lendo `.env` (loader.ts + 2x server.ts). Centralizar num `ConfigManager`.

### 6.2 Abstrações que destravam features inteiras
- **`ImportPort` / fonte de áudio genérica 🟡** — generalizar "de onde vem o áudio" (gravação do sistema **ou** arquivo importado **ou** aba do navegador). Destrava a feature de importar arquivo (seção 4.3) e a extensão.
- **`ExporterPort` como registry 🟢** — hoje só markdown. Um registry de exporters (`markdown`, `pdf`, `docx`, `anki`, `json`) com seleção por formato deixa adicionar formato sem mexer no endpoint.
- **Registro de providers via factory 🟡** — provider de transcrição/análise é enum hardcoded. Um registry (`registerTranscriber('assemblyai', factory)`) permite plugar Claude, OpenAI, AssemblyAI etc. sem editar schema + instanciação em vários lugares.
- **Event bus / hooks no pipeline 🟡** — services escrevem direto no repo. Um emissor de eventos (`onTranscribed`, `onAnalyzed`) destrava: auto-título, notificações, webhooks, plugins, telemetria — sem acoplar tudo.
- **Camada de DTO/ViewModel 🟢** — a "enriquecimento" de sessão (duração, preview, contagem) está inline no server. Um `SessionView` desacopla o modelo de domínio do contrato da API (importante quando vier mobile/web).
- **Sistema de migrations 🟡** — schema SQLite é SQL inline no construtor, sem migrations. Adotar Drizzle Kit antes de mudar schema em produção (senão quebra DB de usuário em update).

### 6.3 Qualidade / confiança
- **Testar o `server.ts` e os adapters** 🟡 — hoje 0 testes no server (1238 linhas) e nos adapters (áudio/transcrição/análise). Depois de extrair handlers, dá pra testar com mocks. Crítico antes de cobrar dos usuários.
- **Fixtures de áudio reais** 🟢 — o teste de integração usa mock; um WAV real pega regressões de parsing/duração (como o bug desta sessão).
- **Telemetria opt-in** 🟢 — saber quais features/templates são usados guia o roadmap (respeitando a promessa de privacidade: opt-in e anônimo).

---

## 7. Go-to-market / distribuição

- **Landing simples** com vídeo de 60s mostrando: grava aula → vira caderno. (Pode até ser gerado pelo próprio app como prova.)
- **Conteúdo de nicho:** posts/Reels "como estudar 2x mais rápido com IA" → leva pro app. O template "Extração Total" é o gancho.
- **Distribuição:** GitHub Releases (já tem build .deb/.exe), depois lojas (Microsoft Store, Snap/Flatpak). [itch.io](https://itch.io) funciona surpreendentemente bem pra apps desktop indie.
- **Open core:** manter core open-source (credibilidade + contribuições) e features Pro fechadas. Casa com a tese de privacidade.
- **Comunidade:** Discord pra compartilhar templates → alimenta o marketplace (seção 2.1.D).

---

## 8. Riscos e cuidados (ler antes de lançar)

- **Legalidade de gravar áudio ⚠️** — gravar reuniões/chamadas tem regras de consentimento que variam por país/estado (one-party vs all-party consent). Incluir aviso e deixar claro que é responsabilidade do usuário. Importante pro nicho reuniões.
- **Termos do Groq / dados na nuvem** — no modo Groq, áudio e transcrição saem da máquina. Ser transparente na UI (já há indicador) e na política. O modo local é o porto seguro.
- **Chave de API em texto plano** — `.env` com 0o600 no Unix; no Windows não há ACL aplicada. Pra Pro, considerar guardar via keychain/credential manager do SO.
- **Prompt injection em templates custom** — template é texto livre do usuário; ok pra uso próprio, mas se houver marketplace, validar/sandbox.
- **Custo de suporte** — app que mexe com áudio do SO gera tickets ("não gravou", "device errado"). Onboarding + auto-diagnóstico (seção 5) reduzem isso drasticamente.

---

## 9. Roadmap sugerido (faseado)

**Fase 0 — "Pronto pra mostrar" (1–2 semanas)**
- Auto-título + renomear sessão · Aviso de áudio silencioso · Onboarding mínimo · Expor whisper.cpp + modo 100% local · Importar arquivo de áudio/vídeo.
- _Resultado: app deixa de ser "projeto pessoal" e vira algo demonstrável e barato de rodar._

**Fase 1 — "Vale pagar" (3–5 semanas)**
- Busca full-text · Tags · Export PDF/DOCX/Anki · Chunking map-reduce (aulas longas) · Cache de análise · Licenciamento Pro (Gumroad/Lemon Squeezy).
- _Resultado: tem o que cobrar no Pro; custo de IA controlado._

**Fase 2 — "Diferencial" (6+ semanas)**
- Chat com a transcrição · Diarização · Transcrição ao vivo · i18n · Marketplace de templates.
- _Resultado: features que os concorrentes caros têm, com preço/privacidade melhores._

**Trilho paralelo — Saúde técnica (contínuo)**
- Quebrar `server.ts` · `WavParser` único · Completar repo port · Registry de exporters/providers · Migrations · Testes do server/adapters.
- _Fazer junto com as features acima, não depois — cada uma dessas reduz o custo das próximas._

---

## 10. TL;DR — top 7 ações com melhor retorno

1. **Expor whisper.cpp + modo 100% local** 🟢 — zera custo de transcrição, vira argumento de venda. _(código já existe)_
2. **Importar arquivo de áudio/vídeo** 🟢🔥 — multiplica o público com pouco esforço.
3. **Auto-título + busca + tags** 🟢🟡 — torna o app usável com muitas sessões (retenção).
4. **Export PDF/DOCX/Anki** 🟡 — o formato que o usuário realmente entrega/estuda.
5. **Chunking map-reduce** 🟡 — resolve aulas longas sem custo pago.
6. **Licença Pro via Gumroad (BYOK)** 🟢 — monetiza sem backend, lançamento rápido.
7. **Quebrar `server.ts` + WavParser único + testes** 🟡 — paga juros de toda feature futura.
