import { useState } from "react";
import { useStore } from "../../store";
import { Button } from "../../shared/ui";
import { FileText, Plus, Pencil, Trash2, X, Check } from "lucide-react";

export function TemplatesPage() {
  const { templates, createTemplate, updateTemplate, deleteTemplate } =
    useStore();
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");

  const startCreate = () => {
    setCreating(true);
    setEditing(null);
    setName("");
    setPrompt(
      "Analise a seguinte transcrição e produza um resumo estruturado:\n\n{{transcript}}",
    );
    setError("");
  };

  const startEdit = (t: {
    id: string;
    name: string;
    userPromptTemplate: string;
  }) => {
    setEditing(t.id);
    setCreating(false);
    setName(t.name);
    setPrompt(t.userPromptTemplate);
    setError("");
  };

  const cancel = () => {
    setEditing(null);
    setCreating(false);
    setError("");
  };

  const save = async () => {
    if (!name.trim()) {
      setError("Nome é obrigatório");
      return;
    }
    if (!prompt.includes("{{transcript}}")) {
      setError("O template deve conter {{transcript}}");
      return;
    }
    try {
      if (creating) {
        await createTemplate(name.trim(), prompt);
      } else if (editing) {
        await updateTemplate(editing, {
          name: name.trim(),
          userPromptTemplate: prompt,
        });
      }
      cancel();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Erro ao salvar");
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteTemplate(id);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Erro ao excluir");
    }
  };

  const isEditing = creating || editing !== null;

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-text-primary">
          Templates de Análise
        </h1>
        {!isEditing && (
          <Button size="sm" onClick={startCreate}>
            <Plus className="w-3.5 h-3.5" /> Novo Template
          </Button>
        )}
      </div>

      {isEditing && (
        <div className="bg-surface border border-border rounded-lg p-4 space-y-3">
          <div>
            <label className="text-sm text-text-secondary block mb-1">
              Nome
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-bg-secondary border border-border rounded px-3 py-2 text-sm text-text-primary outline-none focus:border-accent/50"
              placeholder="Ex: Resumo de Reunião"
            />
          </div>
          <div>
            <label className="text-sm text-text-secondary block mb-1">
              Prompt do Usuário
            </label>
            <p className="text-xs text-text-muted mb-2">
              Use{" "}
              <code className="bg-bg-secondary px-1 rounded">
                {"{{transcript}}"}
              </code>{" "}
              onde a transcrição será inserida.
            </p>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={10}
              className="w-full bg-bg-secondary border border-border rounded px-3 py-2 text-sm text-text-primary outline-none focus:border-accent/50 font-mono resize-y"
              placeholder="Analise a seguinte transcrição:\n\n{{transcript}}"
            />
          </div>
          {error && <p className="text-sm text-recording">{error}</p>}
          <div className="flex gap-2">
            <Button size="sm" onClick={save}>
              <Check className="w-3.5 h-3.5" /> Salvar
            </Button>
            <Button size="sm" variant="secondary" onClick={cancel}>
              <X className="w-3.5 h-3.5" /> Cancelar
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {templates.map((t) => (
          <div
            key={t.id}
            className="bg-surface border border-border rounded-lg p-4 flex items-start justify-between gap-4"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-accent shrink-0" />
                <h3 className="text-sm font-medium text-text-primary truncate">
                  {t.name}
                </h3>
                {t.builtin && (
                  <span className="text-xs bg-accent/10 text-accent px-1.5 py-0.5 rounded">
                    builtin
                  </span>
                )}
              </div>
              <p className="text-xs text-text-muted mt-1 line-clamp-2 font-mono">
                {t.userPromptTemplate.slice(0, 120)}
                {t.userPromptTemplate.length > 120 ? "..." : ""}
              </p>
            </div>
            <div className="flex gap-1 shrink-0">
              <button
                onClick={() => startEdit(t)}
                className="p-1.5 rounded hover:bg-surface-hover text-text-muted hover:text-text-primary cursor-pointer"
                title="Editar"
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
              {!t.builtin && (
                <button
                  onClick={() => handleDelete(t.id)}
                  className="p-1.5 rounded hover:bg-surface-hover text-text-muted hover:text-recording cursor-pointer"
                  title="Excluir"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        ))}
        {templates.length === 0 && (
          <p className="text-sm text-text-muted text-center py-8">
            Nenhum template encontrado.
          </p>
        )}
      </div>
    </div>
  );
}
