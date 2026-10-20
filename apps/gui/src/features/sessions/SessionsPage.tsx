import {
	Fragment,
	type KeyboardEvent,
	type RefObject,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { api } from "../../shared/api/client";
import type { SessionSummary } from "../../shared/api/types";
import { useDocumentClick } from "../../shared/hooks/useDocumentClick";
import { fmtDuration, plural } from "../../shared/lib/format";
import {
	filterSessions,
	sessionMeta,
	sessionPreview,
	sessionTitle,
} from "../../shared/lib/session";
import { EmptyState } from "../../shared/ui/Feedback";
import { StatusBadge } from "../../shared/ui/StatusBadge";
import { useStore } from "../../store";
import { SESSIONS_LIMIT } from "../../store/slices/sessions";
import { NewRecordingButton } from "./NewRecordingButton";

const SEARCH_DEBOUNCE_MS = 250;

/**
 * Server-side search (title + transcript text), debounced. Until the server answers, the
 * list is filtered locally so typing feels instant.
 */
function useSessionSearch(sessions: SessionSummary[], query: string): SessionSummary[] {
	const [remote, setRemote] = useState<{ q: string; ids: string[] } | null>(null);
	const q = query.trim();
	useEffect(() => {
		if (!q) return;
		let alive = true;
		const id = setTimeout(async () => {
			try {
				const { sessions: found } = await api.listSessions({ q, limit: SESSIONS_LIMIT });
				if (alive) setRemote({ q, ids: found.map((s) => s.id) });
			} catch {
				// keep the local filter
			}
		}, SEARCH_DEBOUNCE_MS);
		return () => {
			alive = false;
			clearTimeout(id);
		};
	}, [q]);
	return useMemo(() => {
		if (!q) return sessions;
		if (remote?.q === q) {
			const byId = new Map(sessions.map((s) => [s.id, s]));
			return remote.ids.flatMap((id) => byId.get(id) ?? []);
		}
		return filterSessions(sessions, q);
	}, [sessions, q, remote]);
}

const MENU_ITEMS: { id: string; label: string; testId: string; del?: boolean }[] = [
	{ id: "rename", label: "Renomear", testId: "menu-rename" },
	{ id: "transcribe", label: "Transcrever", testId: "menu-transcribe" },
	{ id: "analyze", label: "Analisar", testId: "menu-analyze" },
	{ id: "export", label: "Exportar", testId: "menu-export" },
	{ id: "delete", label: "Apagar", testId: "menu-delete", del: true },
];

/** Quick actions menu: focus moves in on open; arrows/Home/End move, Escape/Tab close. */
function QuickMenu({
	s,
	close,
	trigger,
}: {
	s: SessionSummary;
	close: () => void;
	trigger: RefObject<HTMLButtonElement | null>;
}) {
	const menu = useRef<HTMLDivElement>(null);
	const { openSession, requestTranscribe, quickAnalyze, askDelete } = useStore.getState();
	const actions: Record<string, () => void> = {
		rename: () => openSession(s.id, "t", { editTitle: true }),
		transcribe: () => requestTranscribe(s.id),
		analyze: () => quickAnalyze(s.id),
		export: () => openSession(s.id, "e"),
		delete: () => askDelete(s.id),
	};

	useEffect(() => {
		menu.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
	}, []);

	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		const items = Array.from(
			menu.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? [],
		);
		const i = items.indexOf(document.activeElement as HTMLButtonElement);
		let next: HTMLButtonElement | undefined;
		if (e.key === "ArrowDown") next = items[(i + 1) % items.length];
		else if (e.key === "ArrowUp") next = items[(i - 1 + items.length) % items.length];
		else if (e.key === "Home") next = items[0];
		else if (e.key === "End") next = items.at(-1);
		else if (e.key === "Escape") {
			e.preventDefault();
			close();
			trigger.current?.focus();
			return;
		} else if (e.key === "Tab") {
			close();
			return;
		}
		if (next) {
			e.preventDefault();
			next.focus();
		}
	};

	return (
		<div
			ref={menu}
			className="qmenu"
			role="menu"
			aria-label={`Opções rápidas: ${sessionTitle(s)}`}
			data-testid="session-menu"
			onClick={(e) => e.stopPropagation()}
			onKeyDown={onKeyDown}
		>
			{MENU_ITEMS.map((item) => (
				<Fragment key={item.id}>
					{item.del ? (
						<div style={{ height: 1, background: "var(--line)", margin: "4px 2px" }} />
					) : null}
					<button
						type="button"
						role="menuitem"
						tabIndex={-1}
						className={item.del ? "qi del" : "qi"}
						data-testid={item.testId}
						onClick={() => {
							close();
							actions[item.id]();
						}}
					>
						{item.label}
					</button>
				</Fragment>
			))}
		</div>
	);
}

/** Clicks on these (inside a card) are their own action, not "open the session". */
const isInnerControl = (target: EventTarget | null, card: HTMLElement) => {
	const el =
		target instanceof Element ? target.closest("button, a, input, select, [role=menu]") : null;
	return !!el && el !== card && card.contains(el);
};

/**
 * Session card. The card is a plain container (a click anywhere opens the session, for
 * pointer users); the title is the real button — keyboard/screen-reader path — so the menu
 * button is not nested inside another interactive element.
 */
function SessionCard({
	s,
	menuOpen,
	toggleMenu,
	closeMenu,
}: {
	s: SessionSummary;
	menuOpen: boolean;
	toggleMenu: () => void;
	closeMenu: () => void;
}) {
	const openSession = useStore((st) => st.openSession);
	const menuButton = useRef<HTMLButtonElement>(null);
	const title = sessionTitle(s);
	const open = () => openSession(s.id);
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: pointer shortcut; the title button is the keyboard path
		// biome-ignore lint/a11y/noStaticElementInteractions: see above
		<div
			className={menuOpen ? "card sess open" : "card sess"}
			style={{ position: "relative" }}
			data-testid="session-card"
			onClick={(e) => {
				if (!isInnerControl(e.target, e.currentTarget)) open();
			}}
		>
			<div
				style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}
			>
				<button
					type="button"
					className="s-t s-open"
					style={{ flex: 1, minWidth: 0 }}
					data-testid="session-open"
					onClick={open}
				>
					{title}
				</button>
				<StatusBadge status={s.status} />
				<button
					ref={menuButton}
					type="button"
					className="ghost"
					style={{ padding: "2px 8px", fontSize: 17, lineHeight: 1, marginRight: -8 }}
					title="Opções rápidas"
					aria-label={`Opções rápidas: ${title}`}
					aria-haspopup="menu"
					aria-expanded={menuOpen}
					data-testid="session-menu-button"
					onClick={(e) => {
						e.stopPropagation();
						toggleMenu();
					}}
				>
					⋯
				</button>
			</div>
			{menuOpen ? <QuickMenu s={s} close={closeMenu} trigger={menuButton} /> : null}
			<div className="s-m">
				{sessionMeta(s)} · <span className="mono">{fmtDuration(s.duration)}</span>
			</div>
			<p className="s-p">{sessionPreview(s)}</p>
		</div>
	);
}

export function SessionsPage() {
	const sessions = useStore((s) => s.sessions);
	const [query, setQuery] = useState("");
	const [menuId, setMenuId] = useState<string | null>(null);
	const list = useSessionSearch(sessions, query);
	useDocumentClick(() => setMenuId(null), menuId !== null);

	return (
		<div className="pg" data-screen-label="Sessões">
			<div className="fx jb ac gap16">
				<div>
					<h1 className="h1">Sessões</h1>
					<p className="sub">{plural(sessions.length, "gravação", "gravações")}</p>
				</div>
				<NewRecordingButton />
			</div>
			<div style={{ marginTop: 20 }}>
				<input
					className="inp w100"
					placeholder="Buscar em títulos e transcrições…"
					aria-label="Buscar sessões"
					data-testid="sessions-search"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
				/>
			</div>
			<div style={{ height: 18 }} />
			{list.length > 0 ? (
				<div className="grid2">
					{list.map((s) => (
						<SessionCard
							key={s.id}
							s={s}
							menuOpen={menuId === s.id}
							toggleMenu={() => setMenuId((m) => (m === s.id ? null : s.id))}
							closeMenu={() => setMenuId(null)}
						/>
					))}
				</div>
			) : query.trim() ? (
				<EmptyState
					title="Nada por aqui"
					testId="sessions-empty"
					action={
						<button
							type="button"
							className="btn2"
							style={{ marginTop: 8 }}
							onClick={() => setQuery("")}
						>
							Limpar busca
						</button>
					}
				>
					Nenhuma sessão bate com sua busca. Tente outro termo ou limpe a busca.
				</EmptyState>
			) : (
				<EmptyState title="Nenhuma gravação ainda" testId="sessions-empty">
					Clique em Nova gravação ou pressione Ctrl+Shift+R para começar.
				</EmptyState>
			)}
		</div>
	);
}
