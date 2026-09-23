import type { AnalysisTemplate } from "../ports/analyzer.js";

export const videoaulaInsanaTemplate: AnalysisTemplate = {
	id: "videoaula-insana",
	name: "Videoaula — Extração Total",
	userPromptTemplate: `Você é o melhor monitor/tutor acadêmico do mundo. Recebeu a transcrição COMPLETA de uma videoaula. Sua missão é EXTRAIR O MÁXIMO POSSÍVEL do conteúdo — não deixe NADA de relevante para trás. O resultado deve ser tão completo que o aluno consiga aprender e dominar a aula INTEIRA sem nunca mais reassistir o vídeo.

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

Transcrição da videoaula:
{{transcript}}`,
	builtin: true,
};
