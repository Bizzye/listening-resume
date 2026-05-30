import type { AnalysisTemplate } from "../ports/analyzer.js";

export const meetingSummaryTemplate: AnalysisTemplate = {
  id: "meeting-summary",
  name: "Resumo de Reunião",
  userPromptTemplate: `Você recebeu a transcrição de uma reunião. Analise cuidadosamente e produza um resumo executivo completo seguindo esta estrutura:

## 1. Contexto da Reunião
- Identifique o tipo de reunião (daily, planning, retrospectiva, alinhamento, brainstorm, 1:1, etc.)
- Quem são os participantes (infira pelos nomes/vozes mencionados)
- Qual o objetivo principal da reunião

## 2. Resumo Executivo
Em 3-5 frases, capture a essência completa da reunião — o que foi discutido, o que foi decidido e qual o resultado geral.

## 3. Decisões Tomadas
Liste TODAS as decisões explícitas ou implícitas, no formato:
- **Decisão**: [o que foi decidido]
- **Responsável**: [quem ficou responsável, se mencionado]
- **Prazo**: [deadline, se mencionado]

## 4. Itens de Ação / Próximos Passos
Para cada ação identificada:
- [ ] **[Responsável]**: [Ação específica] — *Prazo: [se mencionado]*

Se não houver responsável claro, marque como "[A definir]".

## 5. Pontos de Atenção e Riscos
- Bloqueios mencionados
- Dependências entre equipes/pessoas
- Riscos levantados ou problemas sem solução
- Divergências de opinião não resolvidas

## 6. Tópicos Adiados / Parking Lot
Assuntos que foram mencionados mas não aprofundados, ou explicitamente deixados para depois.

---
**Regras:**
- Seja objetivo e direto — evite repetições
- Preserve nomes próprios, siglas e termos técnicos exatamente como falados
- Se algo não ficou claro na transcrição, indique com [inaudível] ou [contexto insuficiente]
- Não invente informações que não estejam na transcrição

Transcrição da reunião:
{{transcript}}`,
  builtin: true,
};
