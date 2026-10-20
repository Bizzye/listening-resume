import type { Template } from "../../shared/api/types";
import { plural } from "../../shared/lib/format";
import { ClickableCard } from "../../shared/ui/Clickable";
import { useStore } from "../../store";

export function templateMeta(t: Template): string {
	return `${plural(t.sections, "seção", "seções")} · ${t.language}`;
}

export function TemplatesPage() {
	const templates = useStore((s) => s.templates);
	const open = useStore((s) => s.openTemplateEditor);
	return (
		<div className="pg" data-screen-label="Templates">
			<div>
				<h1 className="h1">Templates</h1>
				<p className="sub">
					Como a IA deve ler suas gravações — cada template vira um tipo de nota.
				</p>
			</div>
			<div className="grid2" style={{ marginTop: 22 }}>
				{templates.map((t) => (
					<ClickableCard
						key={t.id}
						className="card tpl"
						label={t.name}
						testId="template-card"
						onActivate={() => open({ mode: "edit", id: t.id })}
					>
						<div className="fx jb ac gap10">
							<span className="fw6 fs14">{t.name}</span>
							<span className={t.builtin ? "bdg st-n" : "bdg st-ac"}>
								{t.builtin ? "builtin" : "custom"}
							</span>
						</div>
						<p className="m0 fs13" style={{ color: "var(--tx2)", lineHeight: 1.55 }}>
							{t.description}
						</p>
						<div className="tpl-p">{t.prompt}</div>
						<div className="fx jb ac" style={{ marginTop: 2 }}>
							<span className="hint mono">{templateMeta(t)}</span>
							<span className="fs12 fw6" style={{ color: "var(--ac)" }}>
								Editar
							</span>
						</div>
					</ClickableCard>
				))}
				<button
					type="button"
					className="newt"
					data-testid="new-template-button"
					onClick={() => open({ mode: "new" })}
				>
					+ Novo template
				</button>
			</div>
		</div>
	);
}
