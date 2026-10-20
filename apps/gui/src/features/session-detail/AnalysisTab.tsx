import type { SessionDetail, SessionSummary } from "../../shared/api/types";
import { DEFAULT_TEMPLATE_ID } from "../../shared/lib/core-shared";
import { relativeWhen } from "../../shared/lib/format";
import { templateName } from "../../shared/lib/session";
import { EmptyState, ProgressBar, Skeleton, Spinner } from "../../shared/ui/Feedback";
import { Select } from "../../shared/ui/Select";
import { useStore } from "../../store";
import { AnalysisView } from "./AnalysisView";

export function AnalysisTab({
	s,
	detail,
}: {
	s: SessionSummary;
	detail: SessionDetail | undefined;
}) {
	const templates = useStore((st) => st.templates);
	const selected = useStore(
		(st) => st.selectedTemplateId ?? st.settings?.defaultTemplateId ?? DEFAULT_TEMPLATE_ID,
	);
	const model = useStore((st) => st.settings?.analysisModel ?? "");
	const activeId = useStore((st) => st.activeAnalysis[s.id]);
	const { selectTemplate, analyze, setActiveAnalysis, deleteAnalysis } = useStore.getState();

	if (!detail && s.status !== "transcribing" && s.status !== "recording") {
		return (
			<div className="col gap10" data-testid="detail-loading">
				<Skeleton width="60%" height={34} />
				<Skeleton width="80%" />
			</div>
		);
	}
	const canAnalyze =
		!!detail?.transcript && s.status !== "transcribing" && s.status !== "recording";
	if (!canAnalyze) {
		return (
			<EmptyState title="Disponível após a transcrição" testId="analysis-unavailable">
				Assim que a transcrição terminar, você poderá gerar análises aqui.
			</EmptyState>
		);
	}

	const analyzing = s.status === "analyzing";
	const analyses = detail?.analyses ?? [];
	const active = analyses.find((a) => a.id === activeId) ?? analyses.at(-1);
	const options = templates.map((t) => ({ value: t.id, label: t.name }));
	if (!options.some((o) => o.value === selected))
		options.unshift({ value: selected, label: templateName(templates, selected) });

	return (
		<>
			<div className="fx ac gap10">
				<Select
					className="f1"
					label="Template de análise"
					value={selected}
					options={options}
					onChange={selectTemplate}
					testId="template-select"
				/>
				<button
					type="button"
					className="btn"
					data-testid="generate-analysis"
					disabled={analyzing}
					onClick={() => void analyze(s.id, selected)}
				>
					Gerar análise
				</button>
			</div>

			{!analyzing && s.lastError ? (
				<div className="warn" style={{ marginTop: 16 }} role="alert" data-testid="analysis-error">
					<span className="tdot k-err" />
					{s.lastError}
				</div>
			) : null}

			{analyzing ? (
				<div
					className="card"
					style={{ marginTop: 16, padding: 22, display: "flex", flexDirection: "column", gap: 14 }}
					data-testid="analyzing"
				>
					<div className="fx ac gap10">
						<Spinner />
						<span className="fw6 fs13">Analisando com {model}…</span>
						<span className="hint">pode levar alguns segundos</span>
					</div>
					<ProgressBar />
				</div>
			) : null}

			{analyses.length > 0 ? (
				<div className="fx ac gap8 wrap" style={{ marginTop: 16 }}>
					{analyses.map((a) => (
						<button
							key={a.id}
							type="button"
							className={a.id === active?.id ? "chip on" : "chip"}
							aria-pressed={a.id === active?.id}
							data-testid="analysis-chip"
							onClick={() => setActiveAnalysis(s.id, a.id)}
						>
							{templateName(templates, a.templateId)} · {relativeWhen(a.createdAt)}
						</button>
					))}
				</div>
			) : null}

			{analyses.length === 0 && !analyzing ? (
				<EmptyState title="Nenhuma análise ainda" style={{ marginTop: 16 }} testId="no-analysis">
					Escolha um template acima e clique em Gerar análise.
				</EmptyState>
			) : null}

			{active && !analyzing ? (
				<>
					<AnalysisView
						key={active.id}
						analysis={active}
						title={templateName(templates, active.templateId)}
					/>
					<div className="fx jb ac" style={{ marginTop: 18 }}>
						<span className="hint mono">
							{active.provider} · {active.model}
						</span>
						<button
							type="button"
							className="ghost"
							style={{ color: "var(--red)", fontSize: 12 }}
							data-testid="delete-analysis"
							onClick={() => void deleteAnalysis(s.id, active.id)}
						>
							Apagar análise
						</button>
					</div>
				</>
			) : null}
		</>
	);
}
