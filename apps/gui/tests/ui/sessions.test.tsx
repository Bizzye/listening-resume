import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DashboardPage, dashboardStats } from "../../src/features/dashboard/DashboardPage";
import { ConfirmTranscribeModal } from "../../src/features/sessions/ConfirmTranscribeModal";
import { DeleteSessionModal } from "../../src/features/sessions/DeleteSessionModal";
import { SessionsPage } from "../../src/features/sessions/SessionsPage";
import { ToastHost } from "../../src/shared/ui/Toast";
import { useStore } from "../../src/store";
import { makeHealth, makeSession, makeSettings, mockFetch } from "./helpers";

const physics = makeSession({
	id: "a",
	title: "Aula de Física",
	preview: "entropia nunca diminui",
	status: "completed",
	duration: 3600,
	analysesCount: 1,
});
const meeting = makeSession({
	id: "b",
	title: "Reunião semanal",
	preview: "pix parcelado",
	status: "transcribed",
	duration: 1800,
});
const failed = makeSession({
	id: "c",
	title: "Entrevista",
	preview: null,
	status: "failed",
	lastError: "Sem memória",
	duration: 60,
});

function renderPage(ui: React.ReactNode) {
	useStore.setState({ settings: makeSettings(), sessions: [physics, meeting, failed] });
	return render(
		<>
			{ui}
			<DeleteSessionModal />
			<ConfirmTranscribeModal />
			<ToastHost />
		</>,
	);
}

describe("SessionsPage", () => {
	it("lists sessions with status badges and count", () => {
		mockFetch();
		renderPage(<SessionsPage />);
		expect(screen.getByText("3 gravações")).toBeInTheDocument();
		const cards = screen.getAllByTestId("session-card");
		expect(cards).toHaveLength(3);
		expect(within(cards[0]).getByTestId("status-badge")).toHaveTextContent("Concluído");
		expect(within(cards[2]).getByText("Sem memória")).toBeInTheDocument();
	});

	it("filters locally while typing and then uses the server search (transcript text)", async () => {
		const f = mockFetch([["GET", /^\/sessions\?limit=\d+&q=/, { sessions: [meeting] }]]);
		renderPage(<SessionsPage />);
		fireEvent.change(screen.getByTestId("sessions-search"), { target: { value: "física" } });
		expect(screen.getAllByTestId("session-card")).toHaveLength(1);
		expect(screen.getByText("Aula de Física")).toBeInTheDocument();
		// server result wins once it arrives (matched on transcript text)
		expect(await screen.findByText("Reunião semanal")).toBeInTheDocument();
		expect(screen.queryByText("Aula de Física")).toBeNull();
		expect(f.calls[0].path).toMatch(/q=f%C3%ADsica/);
	});

	it("shows the empty state and clears the search", async () => {
		mockFetch([["GET", /^\/sessions\?/, { sessions: [] }]]);
		renderPage(<SessionsPage />);
		fireEvent.change(screen.getByTestId("sessions-search"), { target: { value: "zzz" } });
		expect(screen.getByText("Nada por aqui")).toBeInTheDocument();
		fireEvent.click(screen.getByText("Limpar busca"));
		expect(screen.getAllByTestId("session-card")).toHaveLength(3);
	});

	it("opens a session on click", () => {
		mockFetch();
		renderPage(<SessionsPage />);
		fireEvent.click(screen.getAllByTestId("session-card")[1]);
		expect(useStore.getState()).toMatchObject({ screen: "detail", detailId: "b", detailTab: "t" });
	});

	it("quick menu: open/close, transcribe, rename, export, delete", async () => {
		const f = mockFetch([
			["POST", "/sessions/b/transcribe", { status: 202, body: { status: "transcribing" } }],
			["DELETE", "/sessions/a", { ok: true }],
		]);
		renderPage(<SessionsPage />);
		const menuButtons = screen.getAllByTestId("session-menu-button");
		fireEvent.click(menuButtons[1]);
		expect(screen.getByTestId("session-menu")).toBeInTheDocument();
		expect(useStore.getState().screen).not.toBe("detail"); // menu click does not open the card
		fireEvent.click(document.body);
		expect(screen.queryByTestId("session-menu")).toBeNull();

		fireEvent.click(menuButtons[1]);
		fireEvent.click(screen.getByTestId("menu-transcribe"));
		// Already transcribed: confirm before replacing the transcript.
		const confirm = screen.getByTestId("retranscribe-modal");
		expect(confirm).toHaveTextContent("“Reunião semanal” já tem uma transcrição");
		expect(f.to("POST", "/sessions/b/transcribe")).toHaveLength(0);
		fireEvent.click(within(confirm).getByTestId("retranscribe-confirm"));
		expect(await screen.findByText("Transcrevendo “Reunião semanal”…")).toBeInTheDocument();
		expect(f.to("POST", "/sessions/b/transcribe")).toHaveLength(1);

		fireEvent.click(menuButtons[0]);
		fireEvent.click(screen.getByTestId("menu-delete"));
		const modal = screen.getByTestId("delete-modal");
		expect(modal).toHaveTextContent(
			"“Aula de Física” — áudio, transcrição e análises serão removidos",
		);
		fireEvent.click(within(modal).getByTestId("delete-confirm"));
		expect(await screen.findByText("Sessão apagada")).toBeInTheDocument();
		expect(f.to("DELETE", "/sessions/a")).toHaveLength(1);
		expect(screen.queryByTestId("delete-modal")).toBeNull();
		expect(screen.getAllByTestId("session-card")).toHaveLength(2);

		fireEvent.click(screen.getAllByTestId("session-menu-button")[0]);
		fireEvent.click(screen.getByTestId("menu-rename"));
		expect(useStore.getState()).toMatchObject({
			screen: "detail",
			detailId: "b",
			editTitleOnOpen: true,
		});
	});

	it("quick menu analyze refuses a failed session without transcript", () => {
		mockFetch();
		renderPage(<SessionsPage />);
		fireEvent.click(screen.getAllByTestId("session-menu-button")[2]);
		fireEvent.click(screen.getByTestId("menu-analyze"));
		expect(screen.getByTestId("toast")).toHaveTextContent("Transcreva a sessão antes de analisar");
	});

	it("delete modal can be cancelled with the button or Escape", () => {
		mockFetch();
		renderPage(<SessionsPage />);
		act(() => useStore.getState().askDelete("a"));
		fireEvent.click(screen.getByTestId("delete-cancel"));
		expect(screen.queryByTestId("delete-modal")).toBeNull();
		act(() => useStore.getState().askDelete("a"));
		const dialog = screen.getByTestId("delete-modal");
		// Focus moved into the dialog (first control), so Escape is handled there.
		expect(dialog).toContainElement(document.activeElement as HTMLElement);
		fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
		expect(useStore.getState().deleteId).toBeNull();
	});

	it("modal traps Tab and restores focus on close", () => {
		mockFetch();
		renderPage(<SessionsPage />);
		const opener = screen.getAllByTestId("session-menu-button")[0];
		opener.focus();
		act(() => useStore.getState().askDelete("a"));
		const cancel = screen.getByTestId("delete-cancel");
		const confirm = screen.getByTestId("delete-confirm");
		expect(cancel).toHaveFocus();
		fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true });
		expect(confirm).toHaveFocus();
		fireEvent.keyDown(confirm, { key: "Tab" });
		expect(cancel).toHaveFocus();
		fireEvent.click(cancel);
		expect(opener).toHaveFocus();
	});

	it("re-transcribe confirmation can be cancelled; untranscribed sessions skip it", async () => {
		const f = mockFetch([
			["POST", "/sessions/b/transcribe", { status: 202, body: { status: "transcribing" } }],
			["POST", "/sessions/n/transcribe", { status: 202, body: { status: "transcribing" } }],
		]);
		const fresh = makeSession({ id: "n", title: "Nova", status: "stopped", preview: null });
		renderPage(<SessionsPage />);
		act(() => useStore.setState((st) => ({ sessions: [...st.sessions, fresh] })));
		act(() => useStore.getState().requestTranscribe("b"));
		fireEvent.click(screen.getByTestId("retranscribe-cancel"));
		expect(screen.queryByTestId("retranscribe-modal")).toBeNull();
		expect(f.to("POST", "/sessions/b/transcribe")).toHaveLength(0);
		act(() => useStore.getState().requestTranscribe("n"));
		expect(screen.queryByTestId("retranscribe-modal")).toBeNull();
		await vi.waitFor(() => expect(f.to("POST", "/sessions/n/transcribe")).toHaveLength(1));
	});

	it("cards: the title is the keyboard 'open' button; inner controls do not open the card", () => {
		mockFetch();
		renderPage(<SessionsPage />);
		const card = screen.getAllByTestId("session-card")[0];
		expect(card).not.toHaveAttribute("role");
		const open = within(card).getByTestId("session-open");
		expect(open.tagName).toBe("BUTTON");
		expect(open).toHaveTextContent("Aula de Física");
		fireEvent.click(within(card).getByTestId("session-menu-button"));
		expect(useStore.getState().screen).not.toBe("detail");
		fireEvent.click(open);
		expect(useStore.getState()).toMatchObject({ screen: "detail", detailId: "a" });
	});

	it("quick menu: focus moves in, arrows move, Escape closes and returns focus", () => {
		mockFetch();
		renderPage(<SessionsPage />);
		const trigger = screen.getAllByTestId("session-menu-button")[0];
		fireEvent.click(trigger);
		const menu = screen.getByTestId("session-menu");
		expect(screen.getByTestId("menu-rename")).toHaveFocus();
		fireEvent.keyDown(menu, { key: "ArrowDown" });
		expect(screen.getByTestId("menu-transcribe")).toHaveFocus();
		fireEvent.keyDown(menu, { key: "ArrowUp" });
		fireEvent.keyDown(menu, { key: "ArrowUp" });
		expect(screen.getByTestId("menu-delete")).toHaveFocus();
		fireEvent.keyDown(menu, { key: "Home" });
		expect(screen.getByTestId("menu-rename")).toHaveFocus();
		fireEvent.keyDown(menu, { key: "Escape" });
		expect(screen.queryByTestId("session-menu")).toBeNull();
		expect(trigger).toHaveFocus();
	});
});

describe("DashboardPage", () => {
	it("computes the 4 stats", () => {
		expect(dashboardStats([physics, meeting, failed])).toEqual([
			{ n: "3", l: "Sessões" },
			{ n: "1h 31m", l: "Tempo gravado" },
			{ n: "2", l: "Transcritas" },
			{ n: "1", l: "Analisadas" },
		]);
		// A full list (capped by the API) is a lower bound.
		expect(dashboardStats([physics, meeting], 2).map((x) => x.n)).toEqual([
			"2+",
			"1h 30m+",
			"2+",
			"1+",
		]);
	});

	it("greets, shows services status, stats and up to 4 recents", () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date(2026, 6, 10, 9, 30));
		mockFetch();
		useStore.setState({ health: makeHealth() });
		renderPage(<DashboardPage />);
		expect(screen.getByTestId("greeting")).toHaveTextContent("Bom dia");
		expect(screen.getByText(/sexta-feira, 10 de julho/)).toBeInTheDocument();
		expect(screen.getByTestId("services-summary")).toHaveTextContent(
			"todos os serviços conectados",
		);
		expect(screen.getAllByTestId("stat")).toHaveLength(4);
		expect(screen.getAllByTestId("session-card")).toHaveLength(3);
	});

	it("reports broken services", () => {
		mockFetch();
		useStore.setState({ health: makeHealth({ ollama: { ok: false, model: "", url: "" } }) });
		renderPage(<DashboardPage />);
		expect(screen.getByTestId("services-summary")).toHaveTextContent("Ollama offline");
	});

	it("imports a file and opens it", async () => {
		const f = mockFetch([
			[
				"POST",
				"/sessions/import",
				{
					status: 201,
					body: { session: { ...meeting, id: "imp", title: "aula.mp4", status: "stopped" } },
				},
			],
			[
				"GET",
				/^\/sessions\?/,
				{ sessions: [{ ...meeting, id: "imp", title: "aula.mp4", status: "stopped" }] },
			],
		]);
		renderPage(<DashboardPage />);
		const file = new File(["x"], "aula.mp4", { type: "video/mp4" });
		fireEvent.change(screen.getByTestId("import-input"), { target: { files: [file] } });
		expect(await screen.findByText("Arquivo importado — transcrevendo…")).toBeInTheDocument();
		expect(f.to("POST", "/sessions/import")[0].headers["X-Filename"]).toBe("aula.mp4");
		expect(useStore.getState()).toMatchObject({ screen: "detail", detailId: "imp" });
		// The server status is trusted (no forced "transcribing"); polling follows the job.
		expect(useStore.getState().findSession("imp")?.status).toBe("stopped");
		expect(useStore.getState().expectBusyUntil.imp).toBeGreaterThan(Date.now());
	});

	it("disables the import button while a file is uploading", async () => {
		let release: (v: unknown) => void = () => {};
		const gate = new Promise((r) => {
			release = r;
		});
		mockFetch([
			[
				"POST",
				"/sessions/import",
				async () => {
					await gate;
					return { status: 201, body: { session: { ...meeting, id: "imp2", status: "stopped" } } };
				},
			],
			["GET", /^\/sessions\?/, { sessions: [] }],
		]);
		renderPage(<DashboardPage />);
		const file = new File(["x"], "aula.mp4", { type: "video/mp4" });
		fireEvent.change(screen.getByTestId("import-input"), { target: { files: [file] } });
		const button = screen.getByTestId("import-button");
		await vi.waitFor(() => expect(button).toBeDisabled());
		expect(button).toHaveTextContent("Importando…");
		await act(async () => {
			release(null);
			await gate;
		});
		await vi.waitFor(() => expect(button).toBeEnabled());
		expect(button).toHaveTextContent("Importar arquivo");
	});

	it("starts a recording from the header button", async () => {
		const f = mockFetch([
			["POST", "/recording/start", { session: { id: "r" }, startTime: 1, devices: null }],
			["GET", "/devices", { devices: [] }],
		]);
		renderPage(<DashboardPage />);
		fireEvent.click(screen.getByTestId("new-recording-button"));
		await vi.waitFor(() => expect(useStore.getState().recording?.sessionId).toBe("r"));
		expect(f.to("POST", "/recording/start")).toHaveLength(1);
	});
});
