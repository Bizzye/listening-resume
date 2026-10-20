import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "../../src/app/App";
import { ErrorBoundary } from "../../src/app/ErrorBoundary";
import { useStore } from "../../src/store";
import {
	DEVICES,
	installFakeEventSource,
	installManualRaf,
	makeDetail,
	makeHealth,
	makeSession,
	makeSettings,
	mockFetch,
	type Route,
	TEMPLATES,
} from "./helpers";

function bootRoutes(
	over: { settings?: ReturnType<typeof makeSettings>; status?: unknown } = {},
): Route[] {
	return [
		["GET", "/settings", over.settings ?? makeSettings()],
		[
			"PATCH",
			"/settings",
			(c) => ({ ...(over.settings ?? makeSettings()), ...(c.body as object) }),
		],
		["GET", "/recording/status", over.status ?? { recording: false }],
		["GET", /^\/sessions\?/, { sessions: [makeSession({ id: "a", title: "Aula 12" })] }],
		["GET", "/templates", { templates: TEMPLATES }],
		["GET", "/health", makeHealth()],
		["GET", "/config/groq-key", { configured: false, masked: null }],
		["GET", "/devices", { devices: DEVICES }],
		["GET", "/analysis/models", { models: [] }],
		["POST", "/recording/start", { session: { id: "r1" }, startTime: Date.now(), devices: null }],
	];
}

describe("App", () => {
	it("boots into the shell with the sidebar and dashboard", async () => {
		mockFetch(bootRoutes());
		render(<App />);
		expect(screen.getByTestId("boot-loading")).toBeInTheDocument();
		expect(await screen.findByTestId("greeting")).toBeInTheDocument();
		expect(screen.getByTestId("sidebar-ollama-status")).toHaveTextContent("Ollama conectado");
		expect(screen.getByTestId("sidebar-ollama-status")).toHaveTextContent("llama3.1");
		expect(screen.getAllByTestId("session-card")).toHaveLength(1);
	});

	it("shows onboarding until it is done", async () => {
		installFakeEventSource();
		mockFetch(bootRoutes({ settings: makeSettings({ onboardingDone: false }) }));
		render(<App />);
		expect(await screen.findByTestId("onboarding")).toBeInTheDocument();
		fireEvent.click(screen.getByTestId("onboarding-skip"));
		expect(await screen.findByTestId("greeting")).toBeInTheDocument();
	});

	it("resumes an active recording on boot", async () => {
		installFakeEventSource();
		installManualRaf();
		mockFetch(
			bootRoutes({
				status: {
					recording: true,
					sessionId: "r1",
					startTime: Date.now(),
					chunks: 0,
					devices: null,
					muted: { system: false, mic: false },
				},
			}),
		);
		render(<App />);
		expect(await screen.findByTestId("recording-screen")).toBeInTheDocument();
	});

	it("navigates with the sidebar", async () => {
		mockFetch(bootRoutes());
		render(<App />);
		await screen.findByTestId("greeting");
		fireEvent.click(screen.getByTestId("nav-sessions"));
		expect(screen.getByText("1 gravação")).toBeInTheDocument();
		expect(screen.getByTestId("nav-sessions")).toHaveAttribute("aria-current", "page");
		fireEvent.click(screen.getByTestId("nav-templates"));
		expect(screen.getAllByTestId("template-card")).toHaveLength(3);
		fireEvent.click(screen.getByTestId("nav-settings"));
		expect(screen.getByText("Áudio, transcrição, análise e export.")).toBeInTheDocument();
		fireEvent.click(screen.getByTestId("nav-dashboard"));
		expect(screen.getByTestId("greeting")).toBeInTheDocument();
	});

	it("Ctrl+Shift+R starts a recording from anywhere", async () => {
		installFakeEventSource();
		installManualRaf();
		const f = mockFetch(bootRoutes());
		render(<App />);
		await screen.findByTestId("greeting");
		fireEvent.keyDown(window, { key: "R", ctrlKey: true, shiftKey: true });
		expect(await screen.findByTestId("recording-screen")).toBeInTheDocument();
		expect(f.to("POST", "/recording/start")).toHaveLength(1);
	});

	it("Ctrl+Shift+R works inside a modal's input: no hard reload, the draft survives", async () => {
		installFakeEventSource();
		installManualRaf();
		const f = mockFetch(bootRoutes());
		render(<App />);
		await screen.findByTestId("greeting");
		act(() => useStore.getState().openTemplateEditor({ mode: "new" }));
		const name = screen.getByTestId("template-name-input");
		expect(name).toHaveFocus(); // modal moved focus inside
		fireEvent.change(name, { target: { value: "Rascunho" } });
		const ev = new KeyboardEvent("keydown", {
			key: "R",
			ctrlKey: true,
			shiftKey: true,
			bubbles: true,
			cancelable: true,
		});
		act(() => {
			name.dispatchEvent(ev);
		});
		expect(ev.defaultPrevented).toBe(true);
		expect(await screen.findByTestId("recording-screen")).toBeInTheDocument();
		expect(f.to("POST", "/recording/start")).toHaveLength(1);
		// The shell (and its modal) stays mounted but hidden: nothing typed is lost.
		expect(screen.getByTestId("template-name-input")).toHaveValue("Rascunho");
		expect(screen.queryByRole("navigation", { name: "Navegação principal" })).toBeNull();
	});

	it("Escape inside a modal closes it (handled on the dialog, not window)", async () => {
		mockFetch(bootRoutes());
		render(<App />);
		await screen.findByTestId("greeting");
		act(() => useStore.getState().openTemplateEditor({ mode: "new" }));
		fireEvent.keyDown(screen.getByTestId("template-name-input"), { key: "Escape" });
		expect(screen.queryByTestId("template-modal")).toBeNull();
	});

	it("Ctrl+Shift+R while renaming commits the title first and dismisses confirmations", async () => {
		installFakeEventSource();
		installManualRaf();
		const s = makeSession({ id: "a", title: "Aula 12" });
		const f = mockFetch([
			["GET", "/sessions/a", makeDetail(s)],
			["PATCH", "/sessions/a", { session: { ...s, title: "Aula 13" } }],
			...bootRoutes(),
		]);
		render(<App />);
		await screen.findByTestId("greeting");
		act(() => useStore.getState().openSession("a"));
		const title = await screen.findByTestId("detail-title");
		act(() => useStore.getState().askDelete("a"));
		fireEvent.click(title);
		const input = screen.getByTestId("detail-title-input");
		expect(input).toHaveFocus();
		fireEvent.change(input, { target: { value: "Aula 13" } });
		expect(f.to("PATCH", "/sessions/a")).toHaveLength(0);
		fireEvent.keyDown(input, { key: "R", ctrlKey: true, shiftKey: true });
		expect(await screen.findByTestId("recording-screen")).toBeInTheDocument();
		expect(f.to("PATCH", "/sessions/a")[0]?.body).toEqual({ title: "Aula 13" });
		expect(useStore.getState().deleteId).toBeNull();
		expect(within(document.body).queryByTestId("delete-modal")).toBeNull();
	});

	it("the crash fallback renders inside a themed `.lr` root (design tokens apply)", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		useStore.setState({ theme: "light" });
		const Boom = () => {
			throw new Error("kaboom");
		};
		const { container } = render(
			<ErrorBoundary>
				<Boom />
			</ErrorBoundary>,
		);
		expect(container.firstElementChild).toHaveClass("lr", "light");
		expect(screen.getByText("kaboom")).toBeInTheDocument();
		spy.mockRestore();
	});

	it("theme switch toggles the .light class on the root", async () => {
		const f = mockFetch(bootRoutes());
		const { container } = render(<App />);
		await screen.findByTestId("greeting");
		const root = container.querySelector(".lr");
		expect(root).not.toHaveClass("light");
		fireEvent.click(screen.getByTestId("theme-switch"));
		expect(root).toHaveClass("light");
		await vi.waitFor(() => expect(f.to("PATCH", "/settings")[0].body).toEqual({ theme: "light" }));
	});

	it("shows a retry screen when the server never answers, and retries", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout"] });
		const f = mockFetch([["GET", "/settings", { status: 500, body: { error: "down" } }]]);
		render(<App />);
		await vi.advanceTimersByTimeAsync(20_000);
		expect(useStore.getState().boot).toBe("error");
		expect(screen.getByTestId("boot-error")).toBeInTheDocument();
		const attempts = f.to("GET", "/settings").length;
		expect(attempts).toBe(31);
		fireEvent.click(screen.getByText("Tentar novamente"));
		await vi.advanceTimersByTimeAsync(100);
		expect(f.to("GET", "/settings").length).toBeGreaterThan(attempts);
	});
});
