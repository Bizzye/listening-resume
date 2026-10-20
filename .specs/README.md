# Specs — Roadmap de Lançamento

Planos de implementação detalhados para cada item do brainstorm em
[`docs/IDEIAS-LANCAMENTO.md`](../docs/IDEIAS-LANCAMENTO.md).

Cada spec segue o formato: **Problema → Como está hoje (com file:line) → O que
precisa ser feito → Como implementar → Plano de testes → Riscos/decisões**.

Legenda: esforço 🟢 baixo · 🟡 médio · 🔴 alto.

## Índice

### Fase 0 — Pronto pra mostrar
- [01 — whisper.cpp + modo 100% local](01-whisper-cpp-local-mode.md) 🟢
- [02 — Importar arquivo de áudio/vídeo](02-import-audio-video-file.md) 🟢
- [03 — Auto-título + renomear sessões](03-auto-title-and-rename.md) 🟢
- [14 — Onboarding + auto-diagnóstico](14-ux-onboarding-and-diagnostics.md) 🟢

### Fase 1 — Vale pagar
- [04 — Busca full-text (SQLite FTS5)](04-fulltext-search.md) 🟡
- [05 — Tags e pastas](05-tags-and-folders.md) 🟡
- [06 — Export PDF/DOCX/Anki (registry de exporters)](06-export-formats-registry.md) 🟡
- [07 — Chunking map-reduce (aulas longas)](07-chunking-map-reduce.md) 🟡
- [08 — Cache de análise](08-analysis-cache.md) 🟢
- [09 — Licenciamento Pro (BYOK, sem backend)](09-pro-licensing-byok.md) 🟢
- [15 — Controles de custo + roteamento por tamanho](15-cost-controls-and-routing.md) 🟢

### Fase 2 — Diferencial
- [16 — Chat com a transcrição (RAG)](16-chat-with-transcript.md) 🟡
- [17 — Diarização (quem falou o quê)](17-diarization.md) 🔴
- [18 — Transcrição ao vivo (streaming)](18-live-transcription.md) 🔴
- [19 — i18n (pt-BR / en)](19-i18n.md) 🟡
- [20 — Idioma por sessão + tradução](20-language-and-translation.md) 🟢

### Trilho técnico — Saúde do código (contínuo)
- [10 — Quebrar server.ts em handlers + testes](10-refactor-server-handlers.md) 🟡
- [11 — WavParser único (eliminar duplicação)](11-wav-parser-unification.md) 🟢
- [12 — Completar repository port + migrations](12-repo-port-and-migrations.md) 🟡
- [13 — Registries de provider/exporter + event bus + ImportPort](13-extensibility-registries-eventbus.md) 🟡
