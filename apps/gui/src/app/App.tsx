import { type ReactNode, useEffect, useRef } from "react";
import { DashboardPage } from "../features/dashboard/DashboardPage";
import { Sidebar } from "../features/navigation/Sidebar";
import { Onboarding } from "../features/onboarding/Onboarding";
import { RecordingScreen } from "../features/recording/RecordingScreen";
import { SessionDetailPage } from "../features/session-detail/SessionDetailPage";
import { ConfirmTranscribeModal } from "../features/sessions/ConfirmTranscribeModal";
import { DeleteSessionModal } from "../features/sessions/DeleteSessionModal";
import { SessionsPage } from "../features/sessions/SessionsPage";
import { SettingsPage } from "../features/settings/SettingsPage";
import { TemplateEditorModal } from "../features/templates/TemplateEditorModal";
import { TemplatesPage } from "../features/templates/TemplatesPage";
import { useHotkey } from "../shared/hooks/useHotkey";
import { usePolling } from "../shared/hooks/usePolling";
import { Spinner } from "../shared/ui/Feedback";
import { ToastHost } from "../shared/ui/Toast";
import { useStore } from "../store";
import { busySessionIds } from "../store/slices/sessions";
import { bootApp } from "./boot";
import { ErrorBoundary } from "./ErrorBoundary";

const SESSIONS_POLL_MS = 2500;
const HEALTH_POLL_MS = 30_000;

function BootScreen() {
	const boot = useStore((s) => s.boot);
	if (boot === "error") {
		return (
			<div className="boot">
				<div className="errc" style={{ maxWidth: 440 }} data-testid="boot-error">
					<span className="fw6 fs14">Não foi possível conectar ao serviço local</span>
					<span className="fs13" style={{ color: "var(--tx2)" }}>
						O servidor do Listening Resume não respondeu. Feche e abra o app, ou tente novamente.
					</span>
					<button
						type="button"
						className="btn2"
						style={{ marginTop: 6 }}
						onClick={() => void bootApp()}
					>
						Tentar novamente
					</button>
				</div>
			</div>
		);
	}
	return (
		<div className="boot" data-testid="boot-loading">
			<div className="fx ac gap10 hint">
				<Spinner />
				Conectando ao serviço local…
			</div>
		</div>
	);
}

function MainContent() {
	const screen = useStore((s) => s.screen);
	const detailId = useStore((s) => s.detailId);
	switch (screen) {
		case "sessions":
			return <SessionsPage />;
		case "detail":
			return detailId ? <SessionDetailPage key={detailId} id={detailId} /> : <SessionsPage />;
		case "templates":
			return <TemplatesPage />;
		case "settings":
			return <SettingsPage />;
		default:
			return <DashboardPage />;
	}
}

/**
 * Sidebar + pages + their modals. Kept mounted (hidden) while the full-screen recording runs,
 * so in-progress edits (template editor, inputs) survive a Ctrl+Shift+R round trip.
 */
function AppShell({ hidden }: { hidden: boolean }) {
	const root = useRef<HTMLDivElement>(null);
	// Never let session playback leak into a recording (loopback would capture it).
	useEffect(() => {
		if (!hidden) return;
		for (const a of root.current?.querySelectorAll("audio") ?? []) a.pause();
	}, [hidden]);
	return (
		<div
			ref={root}
			className="app"
			style={hidden ? { display: "none" } : undefined}
			aria-hidden={hidden || undefined}
		>
			<Sidebar />
			<main className="main">
				<MainContent />
			</main>
			<TemplateEditorModal />
			<DeleteSessionModal />
			<ConfirmTranscribeModal />
		</div>
	);
}

/**
 * Background refresh: while jobs run, only the busy sessions are polled (GET /sessions/:id);
 * the list is refreshed once whenever a job settles. Service health occasionally.
 */
function useBackgroundSync(active: boolean) {
	const busyKey = useStore((s) => busySessionIds(s).sort().join(","));
	const { pollBusy, loadSessions, loadHealth } = useStore.getState();
	usePolling(pollBusy, SESSIONS_POLL_MS, active && busyKey !== "");
	usePolling(loadHealth, HEALTH_POLL_MS, active);
	const prevBusy = useRef(busyKey);
	useEffect(() => {
		const before = prevBusy.current ? prevBusy.current.split(",") : [];
		prevBusy.current = busyKey;
		const now = new Set(busyKey ? busyKey.split(",") : []);
		if (active && before.some((id) => !now.has(id))) void loadSessions({ background: true });
	}, [busyKey, active, loadSessions]);
}

/**
 * Ctrl+Shift+R from anywhere (inputs and modals included — the browser hard-reload is always
 * prevented). Before switching screens, the focused field is blurred so pending edits commit
 * (title rename, paths) and the delete confirmation is dismissed.
 */
function useRecordingHotkey(enabled: boolean) {
	useHotkey(
		{ key: "r", ctrl: true, shift: true },
		() => {
			const st = useStore.getState();
			if (!st.recording) {
				const active = document.activeElement;
				if (active instanceof HTMLElement && active !== document.body) active.blur();
				st.cancelDelete();
				st.cancelTranscribe();
			}
			st.toggleRecording();
		},
		enabled,
	);
}

export function App() {
	const boot = useStore((s) => s.boot);
	const theme = useStore((s) => s.theme);
	const onboardingDone = useStore((s) => s.settings?.onboardingDone ?? false);
	const recording = useStore((s) => s.recording);
	const ready = boot === "ready";

	useEffect(() => {
		void bootApp();
	}, []);
	useBackgroundSync(ready);
	useRecordingHotkey(ready && onboardingDone);

	let screen: ReactNode;
	if (!ready) screen = <BootScreen />;
	else if (!onboardingDone) screen = <Onboarding />;
	else
		screen = (
			<>
				{recording ? <RecordingScreen recording={recording} /> : null}
				<AppShell hidden={!!recording} />
			</>
		);

	return (
		<ErrorBoundary>
			<div className={theme === "light" ? "lr light" : "lr"}>
				{screen}
				<ToastHost />
			</div>
		</ErrorBoundary>
	);
}
