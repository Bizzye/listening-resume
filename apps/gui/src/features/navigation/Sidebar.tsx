import { Icon, type IconName } from "../../shared/ui/Icon";
import { Logo } from "../../shared/ui/Logo";
import { Switch } from "../../shared/ui/Switch";
import { useStore } from "../../store";
import type { Screen } from "../../store/slices/ui";

const NAV: { screen: Screen; label: string; icon: IconName; testId: string }[] = [
	{ screen: "dash", label: "Dashboard", icon: "dashboard", testId: "nav-dashboard" },
	{ screen: "sessions", label: "Sessões", icon: "sessions", testId: "nav-sessions" },
	{ screen: "templates", label: "Templates", icon: "templates", testId: "nav-templates" },
	{ screen: "settings", label: "Configurações", icon: "settings", testId: "nav-settings" },
];

function OllamaStatus() {
	const ollama = useStore((s) => s.health?.services.ollama);
	const model = useStore((s) => s.settings?.analysisModel ?? ollama?.model ?? "");
	const ok = !!ollama?.ok;
	return (
		<div className="srow" data-testid="sidebar-ollama-status">
			<span className="stt fs12">
				<span className={ok ? "tdot k-ok" : "tdot k-err"} />
				{ok ? "Ollama conectado" : "Ollama offline"}
			</span>
			<span className="hint mono">{model.split(":")[0]}</span>
		</div>
	);
}

export function Sidebar() {
	const screen = useStore((s) => s.screen);
	const theme = useStore((s) => s.theme);
	const pending = useStore((s) => s.recordingPending);
	const { go, startRecording, toggleTheme } = useStore.getState();

	return (
		<aside className="side">
			<div className="lrow">
				<Logo />
				<div>
					<div className="lname">Listening Resume</div>
					<div className="lsub">Áudio → notas</div>
				</div>
			</div>
			<nav aria-label="Navegação principal" style={{ display: "contents" }}>
				{NAV.map((n) => {
					const on = screen === n.screen || (n.screen === "sessions" && screen === "detail");
					return (
						<button
							key={n.screen}
							type="button"
							className={on ? "navi on" : "navi"}
							aria-current={on ? "page" : undefined}
							data-testid={n.testId}
							onClick={() => go(n.screen)}
						>
							<Icon name={n.icon} className="nvic" />
							{n.label}
						</button>
					);
				})}
			</nav>
			<button
				type="button"
				className="recbtn"
				data-testid="record-button"
				disabled={pending}
				onClick={() => void startRecording()}
			>
				<span className="recdot" />
				Gravar agora
			</button>
			<div className="sfoot">
				<OllamaStatus />
				<div className="srow">
					<span>Tema escuro</span>
					<Switch
						checked={theme === "dark"}
						onChange={toggleTheme}
						label="Tema escuro"
						testId="theme-switch"
					/>
				</div>
			</div>
		</aside>
	);
}
