# Feature: Templates de Análise Customizáveis

## Objetivo

Permitir que o usuário crie, edite e selecione templates de análise personalizados. O template define **completamente** o que será pedido ao LLM — não existe estrutura fixa (Visão Geral, Pontos Principais, etc.). O usuário tem controle total do prompt.

## Estado Atual

- 2 templates hardcoded (`meeting-summary`, `action-items`) em `packages/core/src/templates/`
- Registry estático em `templates/index.ts` com `builtinTemplates`
- Config define `defaultTemplate` (string ID)
- Frontend **não** oferece seleção de template na UI — sempre usa o default
- Server já aceita `templateId` no POST `/api/sessions/:id/analyze`

## Arquitetura Proposta

### 1. Modelo de Dados

```typescript
interface AnalysisTemplate {
  id: string; // UUID para user-created, slug para builtins
  name: string; // Nome exibido na UI
  systemPrompt: string; // System prompt do LLM
  userPromptTemplate: string; // User prompt com {{transcript}} placeholder
  builtin: boolean; // true = não pode ser deletado
  createdAt: string; // ISO timestamp
  updatedAt: string; // ISO timestamp
}
```

### 2. Persistência — Nova tabela SQLite

```sql
CREATE TABLE analysis_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  user_prompt_template TEXT NOT NULL,
  builtin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- Na primeira execução (migration), inserir os 2 templates builtin
- Templates builtin podem ser editados (o user customiza), mas não deletados
- Templates do usuário podem ser criados/editados/deletados livremente

### 3. Camadas

#### Core (`packages/core`)

- **Schema Drizzle**: Nova tabela `analysis_templates` em `adapters/persistence/schema.ts`
- **Repository**: Adicionar ao `SessionRepository` (ou criar `TemplateRepository`):
  - `listTemplates(): AnalysisTemplate[]`
  - `getTemplate(id: string): AnalysisTemplate | undefined`
  - `createTemplate(data: Omit<AnalysisTemplate, 'id' | 'createdAt' | 'updatedAt'>): AnalysisTemplate`
  - `updateTemplate(id: string, data: Partial<AnalysisTemplate>): AnalysisTemplate`
  - `deleteTemplate(id: string): void` (rejeita builtins)
- **Migration**: Seed dos templates builtin no DB
- **Remover** `templates/index.ts`, `templates/meeting-summary.ts`, `templates/action-items.ts` (movidos pro DB)

#### Server (`apps/gui/server.ts`)

- `GET /api/templates` → lista todos do DB (já existe, mudar source)
- `POST /api/templates` → cria template customizado
- `PUT /api/templates/:id` → edita template
- `DELETE /api/templates/:id` → deleta (400 se builtin)
- `POST /api/sessions/:id/analyze` → já recebe `templateId`, buscar do DB

#### Frontend (`apps/gui/src`)

- **Seleção de template antes de analisar**:
  - No `SessionDetailPage`, ao clicar "Gerar Análise", abrir modal/dropdown com lista de templates
  - Mostrar preview do prompt (primeiras linhas)
  - Botão "Confirmar" executa análise com template selecionado
- **Página de gerenciamento de templates** (`/settings/templates` ou aba em Settings):
  - Lista de templates (builtin marcados com badge)
  - Criar novo template (form com nome, system prompt, user prompt)
  - Editar template existente
  - Duplicar template (para customizar a partir de um builtin)
  - Deletar template (apenas custom)
  - Preview com placeholder `{{transcript}}` destacado

### 4. Fluxo do Usuário

```
1. Usuário grava/transcreve sessão
2. Clica "Gerar Análise"
3. Modal aparece com lista de templates:
   ┌─────────────────────────────────────┐
   │  Selecione o template de análise    │
   │                                     │
   │  ● Resumo Geral (padrão)          │
   │  ○ Itens de Ação                   │
   │  ○ Meu Template Custom             │
   │                                     │
   │  [+ Criar novo]    [Confirmar]     │
   └─────────────────────────────────────┘
4. Seleciona template → Análise é gerada
5. Resultado exibido na sessão
```

### 5. Variáveis de Template

O `userPromptTemplate` suporta placeholders:

- `{{transcript}}` — transcrição completa (obrigatório)
- `{{duration}}` — duração total formatada (futuro)
- `{{date}}` — data da sessão (futuro)

### 6. Tarefas de Implementação

| #   | Tarefa                                                   | Escopo      |
| --- | -------------------------------------------------------- | ----------- |
| 1   | Criar schema Drizzle para `analysis_templates`           | core        |
| 2   | Adicionar migration/seed dos builtins                    | core        |
| 3   | Implementar `TemplateRepository` no SQLite adapter       | core        |
| 4   | Atualizar exports do core (remover templates estáticos)  | core        |
| 5   | Adicionar endpoints CRUD no server                       | server      |
| 6   | Atualizar endpoint de análise para buscar template do DB | server      |
| 7   | Criar componente de seleção de template (modal)          | frontend    |
| 8   | Criar página de gerenciamento de templates               | frontend    |
| 9   | Atualizar store com ações de template                    | frontend    |
| 10  | Testes unitários para repository e endpoints             | core/server |

### 7. Considerações

- **Backward compatibility**: Se não existir a tabela (primeira vez), rodar migration automática
- **Default template**: Mantido no config (`defaultTemplate`), pré-selecionado no modal
- **Extra prompt**: O campo `extraPrompt` continua existindo — permite ajustar qualquer template on-the-fly sem editá-lo permanentemente
- **Export/Import**: Futuro — permitir compartilhar templates como JSON
