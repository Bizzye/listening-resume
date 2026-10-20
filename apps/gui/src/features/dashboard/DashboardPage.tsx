import { useEffect, useState } from "react";
import type { SessionSummary } from "../../shared/api/types";
import { fmtDuration, fmtTotal, greeting, longDate } from "../../shared/lib/format";
import { serviceIssues } from "../../shared/lib/health";
import { sessionMeta, sessionPreview, sessionTitle } from "../../shared/lib/session";
import { isTranscribed } from "../../shared/lib/status";
import { ClickableCard } from "../../shared/ui/Clickable";
import { EmptyState } from "../../shared/ui/Feedback";
import { StatusBadge } from "../../shared/ui/StatusBadge";
import { useStore } from "../../store";
import { SESSIONS_LIMIT } from "../../store/slices/sessions";
import { ImportButton } from "../sessions/ImportButton";
import { NewRecordingButton } from "../sessions/NewRecordingButton";

export interface DashboardStat {
	n: string;
	l: string;
}

/**
 * The 4 dashboard stats, computed from the loaded list. The list is capped at
 * SESSIONS_LIMIT (no server-side aggregate endpoint yet): when it is full the numbers are
 * lower bounds and are shown with a "+".
 */
export function dashboardStats(
	sessions: SessionSummary[],
	limit = SESSIONS_LIMIT,
): DashboardStat[] {
	const more = sessions.length >= limit ? "+" : "";
	const total = sessions.reduce((a, s) => a + (s.duration || 0), 0);
	const transcribed = sessions.filter((s) => isTranscribed(s.status)).length;
	const analyzed = sessions.filter((s) => s.analysesCount > 0).length;
	return [
		{ n: `${sessions.length}${more}`, l: "Sessões" },
		{ n: `${fmtTotal(total)}${more}`, l: "Tempo gravado" },
		{ n: `${transcribed}${more}`, l: "Transcritas" },
		{ n: `${analyzed}${more}`, l: "Analisadas" },
	];
}

/** Re-renders every minute so the greeting/date stay current. */
function useNow(): Date {
	const [now, setNow] = useState(() => new Date());
	useEffect(() => {
		const id = setInterval(() => setNow(new Date()), 60_000);
		return () => clearInterval(id);
	}, []);
	return now;
}

function RecentCard({ s, now }: { s: SessionSummary; now: Date }) {
	const openSession = useStore((st) => st.openSession);
	const title = sessionTitle(s);
	return (
		<ClickableCard
			className="card sess fx ac gap16"
			label={title}
			testId="session-card"
			onActivate={() => openSession(s.id)}
		>
			<div className="f1" style={{ minWidth: 0 }}>
				<div className="fx ac gap10">
					<span className="s-t">{title}</span>
					<StatusBadge status={s.status} />
				</div>
				<div className="s-m">{sessionMeta(s, now)}</div>
				<p className="s-p">{sessionPreview(s)}</p>
			</div>
			<span className="ptime">{fmtDuration(s.duration)}</span>
		</ClickableCard>
	);
}

export function DashboardPage() {
	const sessions = useStore((s) => s.sessions);
	const health = useStore((s) => s.health);
	const provider = useStore((s) => s.settings?.transcriptionProvider);
	const go = useStore((s) => s.go);
	const now = useNow();
	const issues = serviceIssues(health, provider);

	return (
		<div className="pg" data-screen-label="Dashboard">
			<div className="fx jb ac gap16">
				<div>
					<h1 className="h1" data-testid="greeting">
						{greeting(now)}
					</h1>
					<p className="sub">
						{longDate(now)} ·{" "}
						<span
							style={{ color: issues.length ? "var(--amb)" : "var(--grn)" }}
							data-testid="services-summary"
						>
							{issues.length ? issues.join(" · ") : "todos os serviços conectados"}
						</span>
					</p>
				</div>
				<div className="fx gap10">
					<ImportButton />
					<NewRecordingButton />
				</div>
			</div>

			<div className="stats">
				{dashboardStats(sessions).map((st) => (
					<div key={st.l} className="card stat" data-testid="stat">
						<div className="stat-n">{st.n}</div>
						<div className="stat-l">{st.l}</div>
					</div>
				))}
			</div>

			<div className="fx jb ac" style={{ margin: "26px 0 12px" }}>
				<h2 className="h2">Recentes</h2>
				<button type="button" className="ghost" onClick={() => go("sessions")}>
					Ver todas
				</button>
			</div>
			{sessions.length === 0 ? (
				<EmptyState title="Nenhuma gravação ainda">
					Clique em Nova gravação ou pressione Ctrl+Shift+R para começar.
				</EmptyState>
			) : (
				<div className="col gap10">
					{sessions.slice(0, 4).map((s) => (
						<RecentCard key={s.id} s={s} now={now} />
					))}
				</div>
			)}
		</div>
	);
}
