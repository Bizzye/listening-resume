import { useState } from "react";
import type { Template, TemplateInput } from "../../shared/api/types";
import { Modal } from "../../shared/ui/Modal";
import { useStore } from "../../store";

function Editor({ template, onClose }: { template: Template | null; onClose: () => void }) {
	const { saveTemplate, deleteTemplate, pop } = useStore.getState();
	const builtin = !!template?.builtin;
	const [form, setForm] = useState<TemplateInput>({
		name: template ? (builtin ? `${template.name} (cópia)` : template.name) : "",
		description: template?.description ?? "",
		prompt: template?.prompt ?? "",
	});
	const [saving, setSaving] = useState(false);
	const set = (k: keyof TemplateInput) => (e: { target: { value: string } }) =>
		setForm((f) => ({ ...f, [k]: e.target.value }));

	const save = async () => {
		if (!form.name.trim() || !form.prompt.trim()) return pop("Preencha o nome e o prompt", "err");
		setSaving(true);
		// Built-ins are read-only on the server: saving creates a custom copy.
		const ok = await saveTemplate(builtin || !template ? null : template.id, {
			name: form.name.trim(),
			description: form.description.trim(),
			prompt: form.prompt,
		});
		setSaving(false);
		if (ok) onClose();
	};

	const title = template ? "Editar template" : "Novo template";
	return (
		<Modal
			title={title}
			onClose={onClose}
			testId="template-modal"
			headerAside={
				<button type="button" className="ghost" onClick={onClose}>
					Fechar
				</button>
			}
		>
			{builtin ? (
				<p className="sub" style={{ marginTop: 8 }} data-testid="template-copy-hint">
					Templates padrão são salvos como cópia.
				</p>
			) : null}
			<label className="lbl" htmlFor="tpl-name">
				Nome
			</label>
			<input
				id="tpl-name"
				className="inp w100"
				data-testid="template-name-input"
				value={form.name}
				onChange={set("name")}
			/>
			<label className="lbl" htmlFor="tpl-desc">
				Descrição
			</label>
			<input
				id="tpl-desc"
				className="inp w100"
				data-testid="template-desc-input"
				value={form.description}
				onChange={set("description")}
			/>
			<label className="lbl" htmlFor="tpl-prompt">
				Prompt
			</label>
			<textarea
				id="tpl-prompt"
				className="tta"
				data-testid="template-prompt-input"
				value={form.prompt}
				onChange={set("prompt")}
			/>
			<div className="fx jb ac" style={{ marginTop: 18, gap: 12 }}>
				<span className="hint">
					Variáveis: <span className="mono">{"{transcricao}"}</span> ·{" "}
					<span className="mono">{"{titulo}"}</span>
				</span>
				<div className="fx gap10">
					{template && !builtin ? (
						<button
							type="button"
							className="ghost"
							style={{ color: "var(--red)" }}
							data-testid="template-delete-button"
							onClick={async () => {
								if (await deleteTemplate(template.id)) onClose();
							}}
						>
							Apagar
						</button>
					) : null}
					<button type="button" className="btn2" onClick={onClose}>
						Cancelar
					</button>
					<button
						type="button"
						className="btn"
						data-testid="template-save-button"
						disabled={saving}
						onClick={() => void save()}
					>
						Salvar template
					</button>
				</div>
			</div>
		</Modal>
	);
}

export function TemplateEditorModal() {
	const editor = useStore((s) => s.templateEditor);
	const templates = useStore((s) => s.templates);
	const close = useStore((s) => s.closeTemplateEditor);
	if (!editor) return null;
	const template =
		editor.mode === "edit" ? (templates.find((t) => t.id === editor.id) ?? null) : null;
	return (
		<Editor key={editor.mode === "edit" ? editor.id : "new"} template={template} onClose={close} />
	);
}
