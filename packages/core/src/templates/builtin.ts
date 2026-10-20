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

export const BUILTIN_TEMPLATES: readonly AnalysisTemplate[] = [
	videoaula,
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
