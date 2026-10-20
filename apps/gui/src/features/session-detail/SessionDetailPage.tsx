import { type KeyboardEvent, useEffect, useId, useState } from "react";
import { sessionAudioUrl } from "../../shared/api/client";
import type { SessionSummary } from "../../shared/api/types";
import { fmtDuration } from "../../shared/lib/format";
import { sessionMeta, sessionTitle } from "../../shared/lib/session";
import { Icon } from "../../shared/ui/Icon";
import { StatusBadge } from "../../shared/ui/StatusBadge";
import { useStore } from "../../store";
import { detailStampOf } from "../../store/slices/sessions";
import type { DetailTab } from "../../store/slices/ui";
import { AnalysisTab } from "./AnalysisTab";
import { ExportTab } from "./ExportTab";
import { SessionAudio } from "./PlayerBar";
import { TranscriptTab } from "./TranscriptTab";
import { useAudioPlayer } from "./useAudioPlayer";

const TABS: { id: DetailTab; label: string; testId: string }[] = [
	{ id: "t", label: "Transcrição", testId: "tab-transcript" },
	{ id: "a", label: "Análise", testId: "tab-analysis" },
	{ id: "e", label: "Export", testId: "tab-export" },
];

function EditableTitle({ s }: { s: SessionSummary }) {
	const renameSession = useStore((st) => st.renameSession);
	const consumeEditTitle = useStore((st) => st.consumeEditTitle);
	const title = sessionTitle(s);
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(title);

	useEffect(() => {
		if (consumeEditTitle()) {
			setDraft(title);
			setEditing(true);
		}
	}, [consumeEditTitle, title]);

	const start = () => {
		setDraft(title);
		setEditing(true);
	};
	const save = () => {
		if (!editing) return;
		setEditing(false);
		const t = draft.trim();
		if (t && t !== title) void renameSession(s.id, t);
	};

	if (editing) {
		return (
			<input
				className="ttl-in"
				// biome-ignore lint/a11y/noAutofocus: entering rename mode is an explicit user action
				autoFocus
				aria-label="Título da sessão"
				data-testid="detail-title-input"
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={save}
				onKeyDown={(e) => {
					if (e.key === "Enter") save();
					if (e.key === "Escape") setEditing(false);
				}}
			/>
		);
	}
	return (
		<div style={{ display: "flex", alignItems: "center", gap: 6 }}>
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: the rename button next to it is the keyboard path */}
			<h1
				className="h1 ttl"
				title="Clique para renomear"
				data-testid="detail-title"
				onClick={start}
			>
				{title}
			</h1>
			<button
				type="button"
				className="ghost"
				style={{ padding: 6 }}
				title="Renomear"
				aria-label="Renomear sessão"
				onClick={start}
			>
				<Icon name="pencil" size={14} />
			</button>
		</div>
	);
}

/**
 * Session detail. Background jobs are followed by the app-wide busy poll; this page re-fetches
 * its transcript/analyses whenever the session's status or analyses count moves past what the
 * cached detail was fetched for. The <audio> lives here (not in a tab) so playback and
 * position survive tab switches.
 */
export function SessionDetailPage({ id }: { id: string }) {
	const s = useStore((st) => st.findSession(id));
	const detail = useStore((st) => st.details[id]);
	const stamp = useStore((st) => st.detailStamp[id]);
	const tab = useStore((st) => st.detailTab);
	const { loadDetail, setDetailTab, go, requestTranscribe, quickAnalyze, askDelete } =
		useStore.getState();
	const player = useAudioPlayer(s?.duration ?? 0);
	const tabsId = useId();
	const current = s ? detailStampOf(s) : null;

	useEffect(() => {
		void loadDetail(id);
	}, [id, loadDetail]);
	// Status / analyses changed after the cached detail was fetched (e.g. found by the list poll).
	useEffect(() => {
		if (current && stamp && current !== stamp) void loadDetail(id);
	}, [id, current, stamp, loadDetail]);

	if (!s) {
		return (
			<div className="pg">
				<div className="col gap10" data-testid="detail-loading">
					<div className="sk" style={{ height: 24, width: "50%" }} />
					<div className="sk" style={{ height: 13, width: "30%" }} />
				</div>
			</div>
		);
	}

	const hasAudio =
		s.status !== "recording" && (s.duration > 0 || s.chunks > 0 || !!detail?.transcript);
	const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
		if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
		const i = TABS.findIndex((t) => t.id === tab);
		const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
		setDetailTab(next.id);
		document.getElementById(`${tabsId}-tab-${next.id}`)?.focus();
	};

	return (
		<div className="pg" data-screen-label="Detalhe da sessão" data-testid="session-detail">
			{hasAudio ? <SessionAudio player={player} src={sessionAudioUrl(s.id)} /> : null}
			<div style={{ marginBottom: 12, marginLeft: -10 }}>
				<button
					type="button"
					className="ghost"
					data-testid="detail-back"
					onClick={() => go("sessions")}
				>
					← Sessões
				</button>
			</div>
			<div
				style={{
					display: "flex",
					justifyContent: "space-between",
					alignItems: "flex-start",
					gap: 20,
				}}
			>
				<div style={{ flex: 1, minWidth: 0 }}>
					<EditableTitle s={s} />
					<div className="fx ac gap10 sub" style={{ marginTop: 6 }}>
						<StatusBadge status={s.status} />
						<span>{sessionMeta(s)}</span>
						<span className="mono">{fmtDuration(s.duration)}</span>
					</div>
				</div>
				<div style={{ display: "flex", alignItems: "center", gap: 8, flex: "none" }}>
					<button
						type="button"
						className="btn2 qa"
						data-testid="detail-transcribe"
						onClick={() => requestTranscribe(s.id)}
					>
						<Icon name="transcribe" size={14} />
						Transcrever
					</button>
					<button
						type="button"
						className="btn2 qa"
						data-testid="detail-analyze"
						onClick={() => quickAnalyze(s.id)}
					>
						<Icon name="sparkle" size={14} />
						Analisar
					</button>
					<button
						type="button"
						className="btn2 qa"
						data-testid="detail-export"
						onClick={() => setDetailTab("e")}
					>
						<Icon name="download" size={14} />
						Exportar
					</button>
					<button
						type="button"
						className="btn2 qa"
						style={{ color: "var(--red)" }}
						title="Apagar sessão"
						data-testid="detail-delete"
						onClick={() => askDelete(s.id)}
					>
						<Icon name="trash" size={14} />
						Apagar
					</button>
				</div>
			</div>

			<div className="tabs" role="tablist" aria-label="Seções da sessão" onKeyDown={onTabKey}>
				{TABS.map((t) => (
					<button
						key={t.id}
						id={`${tabsId}-tab-${t.id}`}
						type="button"
						role="tab"
						aria-selected={tab === t.id}
						aria-controls={`${tabsId}-panel`}
						tabIndex={tab === t.id ? 0 : -1}
						className={tab === t.id ? "tabb on" : "tabb"}
						data-testid={t.testId}
						onClick={() => setDetailTab(t.id)}
					>
						{t.label}
					</button>
				))}
			</div>

			<div role="tabpanel" id={`${tabsId}-panel`} aria-labelledby={`${tabsId}-tab-${tab}`}>
				{tab === "t" ? (
					<TranscriptTab s={s} detail={detail} player={hasAudio ? player : null} />
				) : null}
				{tab === "a" ? <AnalysisTab s={s} detail={detail} /> : null}
				{tab === "e" ? <ExportTab s={s} /> : null}
			</div>
		</div>
	);
}
