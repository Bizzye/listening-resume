import type { AnalysisTemplate } from "../ports/analyzer.js";

export const actionItemsTemplate: AnalysisTemplate = {
	id: "action-items",
	name: "Notas de Videoaula",
	userPromptTemplate: `Você recebeu a transcrição de uma videoaula ou conteúdo educacional. Seu objetivo é transformar isso em notas de estudo de altíssima qualidade que permitam revisão rápida sem precisar reassistir o vídeo.

## 1. Visão Geral
- **Tema**: [Assunto principal da aula]
- **Nível**: [Iniciante / Intermediário / Avançado — infira pelo conteúdo]
- **Pré-requisitos**: [Conhecimentos que o instrutor assume que o aluno já tem]

## 2. Conceitos-Chave
Para cada conceito importante ensinado, estruture:

### [Nome do Conceito]
- **O que é**: Explicação concisa em 1-3 frases
- **Por que importa**: Relevância prática
- **Como usar**: Aplicação ou exemplo dado pelo instrutor

## 3. Passo a Passo / Tutorial
Se a aula inclui demonstração prática, codificação ou processo passo-a-passo, documente na ordem exata:
1. [Passo] — [detalhe relevante]
2. [Passo] — [detalhe relevante]
...

Inclua comandos, código, configurações ou valores específicos mencionados.

## 4. Ferramentas e Tecnologias
| Ferramenta | Uso no contexto | Observação |
|---|---|---|
| [nome] | [para que foi usada] | [versão, alternativa, etc.] |

## 5. Dicas e Boas Práticas
- Dicas explícitas do instrutor
- Armadilhas ou erros comuns mencionados
- Atalhos ou truques compartilhados

## 6. Perguntas para Revisão
Gere 3-5 perguntas que testam a compreensão do conteúdo (estilo flashcard):
- **P**: [Pergunta]
- **R**: [Resposta esperada baseada no conteúdo]

## 7. Referências e Links
- URLs, livros, documentações ou materiais recomendados pelo instrutor
- Termos técnicos para pesquisar depois

---
**Regras:**
- Priorize precisão técnica — preserve nomes exatos de funções, bibliotecas, comandos
- Use formatação rica (negrito, código inline \`assim\`, blocos de código quando aplicável)
- Se o instrutor corrigiu algo durante a aula, registre apenas a versão correta
- Não inclua divagações, piadas ou conteúdo off-topic do instrutor
- Se algo ficou incompleto ou inaudível, marque com [?]

Transcrição da videoaula:
{{transcript}}`,
	builtin: true,
};
