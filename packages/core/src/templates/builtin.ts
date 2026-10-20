import type { AnalysisTemplate } from "../domain/models.js";

/** The template whose output is `pergunta;resposta` lines (rendered as flip cards). */
export const FLASHCARDS_TEMPLATE_ID = "flashcards-anki";

/** Common footer of every built-in prompt: where the variables go. */
const INPUT_BLOCK = `Título da sessão: {titulo}

Transcrição:
"""
{transcricao}
"""`;

const videoaula: AnalysisTemplate = {
	id: "videoaula-extracao",
	name: "Videoaula — Extração Total",
	description:
		"Conceitos, fórmulas, passo a passo dos exercícios, flashcards e glossário — o caderno completo da aula.",
	builtin: true,
	sections: 5,
	language: "pt-BR",
	prompt: `Você é um assistente de estudos. A partir da transcrição de uma aula, produza o caderno completo da aula, permitindo revisar o conteúdo sem reassistir a gravação.

Use exatamente estas seções, nesta ordem:

## Conceitos-chave
Um item por conceito ensinado: "- **Nome do conceito** — definição curta (1 a 2 frases), com a intuição dada pelo professor".

## Fórmulas
Todas as fórmulas citadas, em notação clara entre crases, seguidas do significado: "- \`ΔS = Q_rev / T\` — o que a fórmula calcula e o que significa cada símbolo". Se não houver fórmulas, escreva "Nenhuma fórmula apresentada.".

## Passo a passo dos exercícios
Para cada exercício ou exemplo resolvido, um subtítulo "### Exercício — <enunciado resumido>" seguido de uma lista numerada com cada etapa do raciocínio e o resultado final em negrito. Se nenhum exercício foi resolvido, escreva "Nenhum exercício resolvido na aula.".

## Flashcards
De 5 a 10 flashcards cobrindo os pontos mais cobráveis, um por linha, no formato exato "pergunta;resposta" (sem marcadores, sem numeração e sem usar ";" dentro da pergunta ou da resposta).

## Glossário
Termos técnicos em ordem alfabética: "- **Termo** — definição em uma frase".

Se o professor passou tarefas, leituras, datas de prova ou avisos, acrescente ao final a seção "## Tarefas e avisos" com um item por aviso.

Regras: preserve nomes, números e unidades exatamente como ditos; quando o professor se corrigir, registre só a versão correta; ignore conversas fora do tema.

${INPUT_BLOCK}`,
};

const ataReuniao: AnalysisTemplate = {
	id: "ata-reuniao",
	name: "Ata de Reunião",
	description: "Decisões, encaminhamentos com responsáveis e prazos, pendências e riscos.",
	builtin: true,
	sections: 4,
	language: "pt-BR",
	prompt: `A partir da transcrição de uma reunião, redija uma ata objetiva, pronta para ser enviada aos participantes.

Use exatamente estas seções, nesta ordem:

## Decisões tomadas
Uma decisão por item, de forma afirmativa ("- Fica definido que…"), incluindo o motivo quando ele foi dito.

## Encaminhamentos
Tabela Markdown com as colunas | Responsável | Ação | Prazo |. Use "A definir" quando o responsável ou o prazo não foram mencionados.

## Pendências
Assuntos discutidos sem conclusão, dúvidas em aberto e itens adiados para outra reunião.

## Riscos
Bloqueios, dependências entre pessoas ou times e riscos levantados, cada um com o impacto mencionado.

Se uma seção não tiver conteúdo, escreva "Nada registrado.". Use os nomes das pessoas exatamente como aparecem na transcrição; não atribua falas ou tarefas a quem não foi citado.

${INPUT_BLOCK}`,
};

const resumoExecutivo: AnalysisTemplate = {
	id: "resumo-executivo",
	name: "Resumo Executivo",
	description: "Um parágrafo de contexto + os 5 pontos que realmente importam.",
	builtin: true,
	sections: 2,
	language: "pt-BR",
	prompt: `Resuma a transcrição para alguém que não tem tempo de ouvi-la. Seja direto.

Use exatamente estas seções:

## Contexto
Um único parágrafo (3 a 5 frases) dizendo do que se trata, quem fala (se identificável) e qual é a conclusão principal.

## Pontos principais
No máximo 5 itens, do mais para o menos importante. Cada item é uma frase completa e autoexplicativa, com números, nomes e prazos quando houver. Destaque em **negrito** a ideia central de cada item.

${INPUT_BLOCK}`,
};

const flashcards: AnalysisTemplate = {
	id: FLASHCARDS_TEMPLATE_ID,
	name: "Flashcards (Anki)",
	description: "Pares pergunta/resposta prontos para importar no Anki.",
	builtin: true,
	sections: 1,
	language: "pt-BR",
	prompt: `Extraia da transcrição de 8 a 15 flashcards cobrindo os conceitos centrais, prontos para importar no Anki.

Formato obrigatório da resposta:
- uma linha por flashcard, no formato exato: pergunta;resposta
- nada além dessas linhas: sem título, sem numeração, sem marcadores, sem Markdown e sem texto antes ou depois
- não use ";" dentro da pergunta nem da resposta

Boas práticas: uma ideia por cartão; perguntas específicas que tenham uma única resposta correta; respostas curtas (até 20 palavras); priorize definições, relações de causa e efeito, fórmulas e dados numéricos citados.

Exemplo de linha:
O que a 2ª Lei da Termodinâmica afirma para sistemas isolados?;A entropia nunca diminui: ΔS ≥ 0

${INPUT_BLOCK}`,
};

const podcastArtigo: AnalysisTemplate = {
	id: "podcast-artigo",
	name: "Podcast → Artigo",
	description: "Transforma o episódio em artigo estruturado com citações.",
	builtin: true,
	sections: 3,
	language: "pt-BR",
	prompt: `Transforme a transcrição de um episódio de podcast (ou palestra) em um artigo bem escrito, em prosa fluida, que possa ser publicado em um blog.

Estrutura:
- Primeira linha: "# " seguido de um título atraente para o artigo.

## Introdução
Um ou dois parágrafos apresentando o tema, os participantes (se identificáveis) e por que o assunto importa.

## Seções temáticas
Organize o conteúdo por tema, não pela ordem cronológica da conversa: um subtítulo "### <tema>" para cada assunto relevante (de 3 a 6), com parágrafos que expliquem as ideias. Inclua citações diretas dos trechos mais fortes como blockquote ("> trecho exato — Nome de quem falou"), copiando as palavras exatamente como estão na transcrição.

## Conclusão
Um parágrafo com as principais lições e, se houver, as recomendações feitas no episódio.

Remova vícios de linguagem, repetições e trechos fora do tema; não invente citações nem dados.

${INPUT_BLOCK}`,
};

/** Exhaustive 12-section study document (originally the "videoaula-insana" custom built-in). */
const videoaulaCompleta: AnalysisTemplate = {
	id: "videoaula-insana",
	name: "Videoaula — Estudo Completo",
	description:
		"Documento de estudo exaustivo em 12 seções: mapa da aula, conteúdo detalhado, cola rápida, banco de questões, resumo de véspera e glossário.",
	builtin: true,
	sections: 12,
	language: "pt-BR",
	prompt: `Você é o melhor monitor/tutor acadêmico do mundo. Recebeu a transcrição COMPLETA de uma videoaula. Sua missão é EXTRAIR O MÁXIMO POSSÍVEL do conteúdo — não deixe NADA de relevante para trás. O resultado deve ser tão completo que o aluno consiga aprender e dominar a aula INTEIRA sem nunca mais reassistir o vídeo.

Trabalhe a transcrição do início ao fim, de forma exaustiva. Produza um documento de estudo definitivo com a estrutura abaixo. Não pule seções — se uma seção não se aplicar, escreva "—".

## 📌 1. Identificação da Aula
- **Tema central**: [assunto principal]
- **Subtemas abordados**: [lista]
- **Disciplina/Área**: [infira]
- **Nível**: [Iniciante / Intermediário / Avançado]
- **Pré-requisitos assumidos**: [o que o professor espera que você já saiba]
- **Objetivos de aprendizagem**: o que você deve ser capaz de fazer ao final

## 🗺️ 2. Mapa da Aula (Sumário Cronológico)
Liste, na ORDEM em que apareceram, todos os tópicos e a progressão lógica do raciocínio do professor. Isto é o esqueleto da aula:
1. [Tópico] → [como conecta ao próximo]
2. ...

## 📖 3. Conteúdo Detalhado (a parte mais importante)
Percorra a aula seção por seção e desenvolva CADA tópico com profundidade. Para cada um:

### [Nome do Tópico]
- **Explicação completa**: desenvolva a ideia com TODOS os detalhes ditos pelo professor — não resuma demais, capture o raciocínio inteiro
- **Definições formais**: termos técnicos com a definição exata dada
- **Por que importa / intuição**: a explicação intuitiva ou analogia que o professor usou
- **Exemplos dados**: TODOS os exemplos, com seus números/dados/contexto
- **Fórmulas / equações**: transcreva exatamente (use notação clara), explique cada variável
- **Demonstrações / deduções**: o passo a passo do raciocínio, se houve
- **Código / comandos**: transcreva em bloco de código tudo que foi mostrado

Repita para todos os tópicos. Seja generoso — é melhor sobrar detalhe do que faltar.

## 🧮 4. Fórmulas, Definições e Fatos-Chave (Cola Rápida)
Tabela com tudo que precisa ser memorizado:
| Conceito | Definição / Fórmula | Quando usar |
|---|---|---|

## 👣 5. Passo a Passo / Procedimentos
Se houve qualquer demonstração prática, resolução de exercício, tutorial ou processo, documente na ordem exata, sem pular etapas:
1. [Passo] — [detalhe, valor, comando]
2. ...

## 🧰 6. Ferramentas, Tecnologias e Materiais
| Item | Para que serve | Observação (versão, link, alternativa) |
|---|---|---|

## ⚠️ 7. Pontos de Atenção do Professor
- **"Isso cai na prova" / ênfases**: tudo que o professor destacou como importante, sublinhou ou repetiu
- **Erros comuns / pegadinhas**: armadilhas que ele alertou
- **Dicas e macetes**: atalhos, regras práticas, mnemônicos
- **Correções**: se ele se corrigiu, registre APENAS a versão correta (mas avise que houve correção)

## 🔗 8. Conexões e Contexto
- Como este conteúdo se liga a aulas/assuntos anteriores ou futuros mencionados
- Aplicações no mundo real citadas
- Comparações e contrastes feitos ("X é diferente de Y porque...")

## ❓ 9. Banco de Questões para Revisão (estilo flashcard)
Gere de 8 a 15 perguntas que cubram TODO o conteúdo, das mais simples às mais profundas:
- **P**: [pergunta]
  **R**: [resposta completa baseada na aula]

## 🧠 10. Resumo de 1 Página (Revisão Véspera de Prova)
Síntese ultra-densa de tudo que importa, em tópicos curtos. Se você só pudesse ler isto 10 min antes da prova, teria o essencial.

## 📚 11. Glossário
Todos os termos técnicos, siglas e jargões usados, com definição de uma linha.

## 🔎 12. Referências e Para Aprofundar
- Livros, papers, sites, documentações, vídeos citados pelo professor
- Termos/assuntos que valem pesquisar depois para completar lacunas

---
**REGRAS DE OURO:**
- EXAUSTIVIDADE > brevidade. O objetivo é capturar o MÁXIMO da aula. Não corte conteúdo relevante para "economizar".
- PRESERVE com exatidão: nomes próprios, números, datas, fórmulas, nomes de funções/bibliotecas/comandos, valores.
- Use formatação rica: **negrito**, \`código inline\`, blocos de código, tabelas, listas, e LaTeX/notação clara para matemática.
- NÃO invente. Se algo não estava na aula, não adicione. Se ficou inaudível/ambíguo, marque com [inaudível] ou [?].
- Ignore divagações 100% off-topic (piadas soltas, "peraí deixa eu tomar água"), MAS mantenha qualquer comentário que tenha valor pedagógico.
- Escreva em português brasileiro claro e didático.

${INPUT_BLOCK}`,
};

export const BUILTIN_TEMPLATES: readonly AnalysisTemplate[] = [
	videoaula,
	videoaulaCompleta,
	ataReuniao,
	resumoExecutivo,
	flashcards,
	podcastArtigo,
];

/** Ids of templates from earlier versions → current built-in id. */
export const LEGACY_TEMPLATE_IDS: Readonly<Record<string, string>> = {
	"meeting-summary": "ata-reuniao",
	"action-items": "ata-reuniao",
};

export const DEFAULT_TEMPLATE_ID = "resumo-executivo";
