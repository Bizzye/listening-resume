import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { scrubFraction } from "../../src/features/session-detail/PlayerBar";
import { SessionDetailPage } from "../../src/features/session-detail/SessionDetailPage";
import { transcribingHint } from "../../src/features/session-detail/TranscriptTab";
import { ConfirmTranscribeModal } from "../../src/features/sessions/ConfirmTranscribeModal";
import { DeleteSessionModal } from "../../src/features/sessions/DeleteSessionModal";
import type { SessionDetail, SessionSummary } from "../../src/shared/api/types";
import { ToastHost } from "../../src/shared/ui/Toast";
import { useStore } from "../../src/store";
import {
	makeAnalysis,
	makeDetail,
	makeSession,
	makeSettings,
	mockFetch,
	type Route,
	TEMPLATES,
} from "./helpers";

function setup(
	session: SessionSummary,
	detail: SessionDetail | null = makeDetail(session),
	routes: Route[] = [],
) {
	const f = mockFetch([
		...routes,
		["GET", `/sessions/${session.id}`, detail ?? { status: 404, body: { error: "x" } }],
		["GET", /^\/sessions\?/, { sessions: [session] }],
	]);
	useStore.setState({
		settings: makeSettings(),
		templates: TEMPLATES,
		sessions: [session],
		screen: "detail",
		detailId: session.id,
		detailTab: "t",
	});
	const Page = () => {
		const id = useStore((s) => s.detailId);
		return id ? <SessionDetailPage id={id} /> : <div>lista</div>;
	};
	render(
		<>
			<Page />
			<DeleteSessionModal />
			<ConfirmTranscribeModal />
			<ToastHost />
		</>,
	);
	return f;
}

describe("SessionDetailPage — header & tabs", () => {
	it("renders title, badge, meta and switches tabs", async () => {
		const s = makeSession({ id: "a", title: "Aula 12", status: "completed", duration: 2832 });
		setup(s);
		expect(screen.getByTestId("detail-title")).toHaveTextContent("Aula 12");
		expect(screen.getByTestId("status-badge")).toHaveTextContent("Concluído");
		expect(screen.getByText("47:12")).toBeInTheDocument();
		expect(await screen.findAllByTestId("segment")).toHaveLength(3);
		fireEvent.click(screen.getByTestId("tab-analysis"));
		expect(screen.getByTestId("tab-analysis")).toHaveAttribute("aria-selected", "true");
		expect(screen.getByTestId("no-analysis")).toBeInTheDocument();
		fireEvent.click(screen.getByTestId("detail-export"));
		expect(screen.getByTestId("export-md")).toBeInTheDocument();
	});

	it("renames inline with Enter (PATCH) and cancels with Escape", async () => {
		const s = makeSession({ id: "a", title: "Antigo" });
		const f = setup(s, makeDetail(s), [["PATCH", "/sessions/a", { session: {} }]]);
		await screen.findAllByTestId("segment");
		fireEvent.click(screen.getByTestId("detail-title"));
		const input = screen.getByTestId("detail-title-input");
		fireEvent.change(input, { target: { value: "Novo título" } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(await screen.findByText("Sessão renomeada")).toBeInTheDocument();
		expect(f.to("PATCH", "/sessions/a")[0].body).toEqual({ title: "Novo título" });
		expect(screen.getByTestId("detail-title")).toHaveTextContent("Novo título");
		fireEvent.click(screen.getByLabelText("Renomear sessão"));
		fireEvent.keyDown(screen.getByTestId("detail-title-input"), { key: "Escape" });
		expect(screen.queryByTestId("detail-title-input")).toBeNull();
	});

	it("opens in rename mode when requested by the quick menu", () => {
		const s = makeSession({ id: "a", title: "Via menu" });
		useStore.setState({ editTitleOnOpen: true });
		setup(s);
		expect(screen.getByTestId("detail-title-input")).toHaveValue("Via menu");
	});

	it("deletes through the confirmation modal and returns to the list", async () => {
		const s = makeSession({ id: "a", title: "Apagar-me" });
		const f = setup(s, makeDetail(s), [["DELETE", "/sessions/a", { ok: true }]]);
		fireEvent.click(screen.getByTestId("detail-delete"));
		fireEvent.click(within(screen.getByTestId("delete-modal")).getByTestId("delete-confirm"));
		expect(await screen.findByText("lista")).toBeInTheDocument();
		expect(f.to("DELETE", "/sessions/a")).toHaveLength(1);
	});
});

describe("Transcription tab", () => {
	it("player: real <audio> source, segment click seeks + plays, active segment follows time", async () => {
		const s = makeSession({ id: "a", duration: 40 });
		setup(s);
		const segs = await screen.findAllByTestId("segment");
		const audio = screen.getByTestId("session-audio") as HTMLAudioElement;
		expect(audio.getAttribute("src")).toBe("http://localhost:3456/api/sessions/a/audio");
		fireEvent.click(segs[1]);
		expect(audio.currentTime).toBe(10);
		expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
		expect(screen.getByTestId("play-toggle")).toHaveAttribute("aria-label", "Pausar");
		expect(segs[1]).toHaveClass("seg on");
		act(() => {
			audio.currentTime = 30;
			audio.dispatchEvent(new Event("timeupdate"));
		});
		expect(screen.getAllByTestId("segment")[2]).toHaveClass("on");
		expect(screen.getByTestId("player-time")).toHaveTextContent("0:30");
		fireEvent.click(screen.getByTestId("play-toggle"));
		expect(screen.getByTestId("play-toggle")).toHaveAttribute("aria-label", "Reproduzir");
	});

	it("scrub maps the click position to a time", () => {
		expect(scrubFraction(150, { left: 100, width: 200 })).toBe(0.25);
		expect(scrubFraction(50, { left: 100, width: 200 })).toBe(0);
		expect(scrubFraction(500, { left: 100, width: 200 })).toBe(1);
		expect(scrubFraction(5, { left: 0, width: 0 })).toBe(0);
	});

	it("search highlights hits, dims the rest and counts", async () => {
		setup(makeSession({ id: "a" }));
		await screen.findAllByTestId("segment");
		expect(screen.getByTestId("segment-count")).toHaveTextContent("3 segmentos");
		fireEvent.change(screen.getByTestId("transcript-search"), { target: { value: "entropia" } });
		expect(screen.getByTestId("segment-count")).toHaveTextContent("2 trechos");
		const segs = screen.getAllByTestId("segment");
		expect(segs[0]).toHaveClass("hit");
		expect(segs[2]).toHaveClass("dim");
	});

	it("shows progress while transcribing, with the real model and language", () => {
		setup(
			makeSession({ id: "a", status: "transcribing", language: "pt" }),
			makeDetail(makeSession({ id: "a", status: "transcribing" }), { transcript: null }),
		);
		expect(screen.getByTestId("transcribing")).toHaveTextContent("Transcrevendo com Groq…");
		expect(screen.getByTestId("transcribing-hint")).toHaveTextContent(
			"whisper-large-v3-turbo · pt",
		);
		expect(transcribingHint("whisper-cpp", "small", "pt")).toBe("small · pt");
		expect(transcribingHint("groq", "medium", "")).toBe("whisper-large-v3-turbo · auto");
	});

	it("list poll finding a finished job re-fetches the open detail (no stale transcript)", async () => {
		const busy = makeSession({ id: "a", status: "transcribing" });
		const done = { ...busy, status: "transcribed" as const };
		let detail = makeDetail(busy, { transcript: null });
		const f = mockFetch([
			["GET", "/sessions/a", () => detail],
			["GET", /^\/sessions\?/, { sessions: [done] }],
		]);
		useStore.setState({
			settings: makeSettings(),
			templates: TEMPLATES,
			sessions: [busy],
			screen: "detail",
			detailId: "a",
			detailTab: "t",
		});
		render(<SessionDetailPage id="a" />);
		await vi.waitFor(() => expect(f.to("GET", "/sessions/a")).toHaveLength(1));
		expect(screen.getByTestId("transcribing")).toBeInTheDocument();
		detail = makeDetail(done);
		await act(() => useStore.getState().loadSessions());
		expect(await screen.findAllByTestId("segment")).toHaveLength(3);
		expect(f.to("GET", "/sessions/a")).toHaveLength(2);
	});

	it("audio error: inline message and play disabled", async () => {
		setup(makeSession({ id: "a", duration: 40 }));
		await screen.findAllByTestId("segment");
		act(() => {
			screen.getByTestId("session-audio").dispatchEvent(new Event("error"));
		});
		expect(screen.getByTestId("player-error")).toHaveTextContent(
			"Não foi possível carregar o áudio desta sessão.",
		);
		expect(screen.getByTestId("play-toggle")).toBeDisabled();
		expect(screen.queryByTestId("scrub")).toBeNull();
	});

	it("playback survives switching tabs (the <audio> lives above the tabs)", async () => {
		setup(makeSession({ id: "a", duration: 40 }));
		const segs = await screen.findAllByTestId("segment");
		const audio = screen.getByTestId("session-audio") as HTMLAudioElement;
		fireEvent.click(segs[1]);
		expect(audio.paused).toBe(false);
		fireEvent.click(screen.getByTestId("tab-analysis"));
		expect(screen.getByTestId("session-audio")).toBe(audio);
		expect(audio.paused).toBe(false);
		fireEvent.click(screen.getByTestId("tab-transcript"));
		expect(screen.getByTestId("play-toggle")).toHaveAttribute("aria-label", "Pausar");
		expect(screen.getByTestId("player-time")).toHaveTextContent("0:10");
	});

	it("tabs are wired to their panel for assistive tech", async () => {
		setup(makeSession({ id: "a" }));
		await screen.findAllByTestId("segment");
		const tab = screen.getByTestId("tab-transcript");
		const panel = screen.getByRole("tabpanel");
		expect(tab).toHaveAttribute("aria-controls", panel.id);
		expect(panel).toHaveAttribute("aria-labelledby", tab.id);
		fireEvent.keyDown(tab, { key: "ArrowRight" });
		expect(screen.getByTestId("tab-analysis")).toHaveAttribute("aria-selected", "true");
	});

	it("re-transcribing an already transcribed session asks first", async () => {
		const s = makeSession({ id: "a", status: "transcribed" });
		const f = setup(s, makeDetail(s), [
			["POST", "/sessions/a/transcribe", { status: 202, body: { status: "transcribing" } }],
		]);
		await screen.findAllByTestId("segment");
		fireEvent.click(screen.getByTestId("detail-transcribe"));
		const modal = screen.getByTestId("retranscribe-modal");
		expect(modal).toHaveTextContent("Ela será substituída pela nova");
		expect(f.to("POST", "/sessions/a/transcribe")).toHaveLength(0);
		fireEvent.click(within(modal).getByTestId("retranscribe-confirm"));
		await vi.waitFor(() => expect(f.to("POST", "/sessions/a/transcribe")).toHaveLength(1));
	});

	it("failed shows lastError and retries", async () => {
		const s = makeSession({ id: "a", status: "failed", lastError: "Chave Groq inválida" });
		const f = setup(s, makeDetail(s, { transcript: null }), [
			["POST", "/sessions/a/transcribe", { status: 202, body: {} }],
		]);
		const card = await screen.findByTestId("transcription-failed");
		expect(card).toHaveTextContent("Chave Groq inválida");
		fireEvent.click(within(card).getByTestId("retry-transcription"));
		await screen.findByTestId("transcribing");
		expect(f.to("POST", "/sessions/a/transcribe")).toHaveLength(1);
	});

	it("auto-transcribe failure (stopped + lastError) shows the error with retry", async () => {
		const s = makeSession({ id: "a", status: "stopped", lastError: "Configure a chave do Groq" });
		setup(s, makeDetail(s, { transcript: null }));
		expect(await screen.findByTestId("transcription-failed")).toHaveTextContent(
			"Configure a chave do Groq",
		);
		expect(screen.getByTestId("player")).toBeInTheDocument();
	});

	it("transcribe 400 (no transcriber) shows the server error and reverts", async () => {
		const s = makeSession({ id: "a", status: "stopped" });
		setup(s, makeDetail(s, { transcript: null }), [
			[
				"POST",
				"/sessions/a/transcribe",
				{ status: 400, body: { error: "Chave do Groq não configurada" } },
			],
		]);
		await screen.findByTestId("not-transcribed");
		fireEvent.click(screen.getByTestId("detail-transcribe"));
		expect(
			await screen.findByText("Não foi possível transcrever: Chave do Groq não configurada"),
		).toBeInTheDocument();
		expect(screen.getByTestId("status-badge")).toHaveTextContent("Gravado");
	});

	it("untranscribed session offers Transcrever and a player", async () => {
		const s = makeSession({ id: "a", status: "stopped", duration: 30 });
		setup(s, makeDetail(s, { transcript: null }));
		expect(await screen.findByTestId("not-transcribed")).toBeInTheDocument();
		expect(screen.getByTestId("player")).toBeInTheDocument();
	});
});

describe("Analysis tab", () => {
	it("shows a skeleton (not 'Disponível após a transcrição') while the detail loads", () => {
		const s = makeSession({ id: "a", status: "completed" });
		mockFetch([["GET", "/sessions/a", () => new Promise(() => {})]]);
		useStore.setState({
			settings: makeSettings(),
			templates: TEMPLATES,
			sessions: [s],
			detailTab: "a",
		});
		render(<SessionDetailPage id="a" />);
		expect(screen.getByTestId("detail-loading")).toBeInTheDocument();
		expect(screen.queryByTestId("analysis-unavailable")).toBeNull();
	});

	it("links in an analysis open outside the app, never navigating the SPA", async () => {
		const open = vi.fn();
		vi.stubGlobal("open", open);
		const s = makeSession({ id: "a", status: "completed", analysesCount: 1 });
		const an = makeAnalysis({
			content: "## Fontes\n\nVeja [o artigo](https://example.com/x) e [isto](javascript:alert(1)).",
		});
		setup(s, makeDetail(s, { analyses: [an] }));
		await screen.findAllByTestId("segment");
		fireEvent.click(screen.getByTestId("tab-analysis"));
		const link = screen.getByRole("link", { name: "o artigo" });
		expect(link).toHaveAttribute("target", "_blank");
		expect(link).toHaveAttribute("rel", "noopener noreferrer");
		const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
		link.dispatchEvent(ev);
		expect(ev.defaultPrevented).toBe(true);
		await vi.waitFor(() =>
			expect(open).toHaveBeenCalledWith("https://example.com/x", "_blank", "noopener,noreferrer"),
		);
		expect(screen.queryByRole("link", { name: "isto" })).toBeNull();
		expect(screen.getByText("isto")).toBeInTheDocument();
	});

	it("is unavailable before transcription", async () => {
		const s = makeSession({ id: "a", status: "stopped" });
		setup(s, makeDetail(s, { transcript: null }));
		fireEvent.click(screen.getByTestId("tab-analysis"));
		expect(await screen.findByTestId("analysis-unavailable")).toBeInTheDocument();
	});

	it("lists templates, generates with the selected one and shows progress", async () => {
		const s = makeSession({ id: "a", status: "transcribed" });
		const f = setup(s, makeDetail(s), [
			["POST", "/sessions/a/analyze", { status: 202, body: { status: "analyzing" } }],
		]);
		await screen.findAllByTestId("segment");
		fireEvent.click(screen.getByTestId("tab-analysis"));
		const select = screen.getByTestId("template-select") as HTMLSelectElement;
		expect(Array.from(select.options).map((o) => o.text)).toEqual(TEMPLATES.map((t) => t.name));
		expect(select.value).toBe("resumo-executivo");
		fireEvent.change(select, { target: { value: "flashcards-anki" } });
		fireEvent.click(screen.getByTestId("generate-analysis"));
		expect(await screen.findByTestId("analyzing")).toHaveTextContent("Analisando com llama3.1:8b…");
		expect(f.to("POST", "/sessions/a/analyze")[0].body).toEqual({ templateId: "flashcards-anki" });
		expect(screen.getByTestId("toast")).toHaveTextContent(
			"Gerando “Flashcards (Anki)” com llama3.1:8b…",
		);
	});

	it("renders markdown sections with design headings and chips per analysis", async () => {
		const s = makeSession({ id: "a", status: "completed", analysesCount: 2 });
		const resumo = makeAnalysis({ id: "r", createdAt: "2026-10-10T10:00:00" });
		const cards = makeAnalysis({
			id: "f",
			templateId: "flashcards-anki",
			content: "O que a entropia mede?;Microestados\nEnuncie a 2ª Lei;ΔS ≥ 0",
			createdAt: "2026-10-11T10:00:00",
		});
		setup(s, makeDetail(s, { analyses: [resumo, cards] }));
		await screen.findAllByTestId("segment");
		fireEvent.click(screen.getByTestId("tab-analysis"));
		const chips = screen.getAllByTestId("analysis-chip");
		expect(chips.map((c) => c.textContent?.split(" · ")[0])).toEqual([
			"Resumo Executivo",
			"Flashcards (Anki)",
		]);
		// newest is active: flip cards
		const fc = screen.getAllByTestId("flashcard");
		expect(fc).toHaveLength(2);
		expect(fc[0]).toHaveTextContent("O que a entropia mede?");
		fireEvent.click(fc[0]);
		expect(fc[0]).toHaveClass("fc on");
		fireEvent.click(chips[0]);
		const view = screen.getByTestId("analysis-view");
		expect(within(view).getByRole("heading", { name: "Resumo Executivo" })).toHaveClass("an-h");
		expect(within(view).getByText("Ponto dois").tagName).toBe("LI");
	});

	it("shows the last analysis error", async () => {
		const s = makeSession({ id: "a", status: "transcribed", lastError: "Ollama offline" });
		setup(s);
		await screen.findAllByTestId("segment");
		fireEvent.click(screen.getByTestId("tab-analysis"));
		expect(screen.getByTestId("analysis-error")).toHaveTextContent("Ollama offline");
	});

	it("deletes an analysis", async () => {
		const s = makeSession({ id: "a", status: "completed", analysesCount: 1 });
		const f = setup(s, makeDetail(s, { analyses: [makeAnalysis({ id: "x" })] }), [
			["DELETE", "/analyses/x", { ok: true }],
		]);
		await screen.findAllByTestId("segment");
		fireEvent.click(screen.getByTestId("tab-analysis"));
		fireEvent.click(screen.getByTestId("delete-analysis"));
		expect(await screen.findByText("Análise apagada")).toBeInTheDocument();
		expect(f.to("DELETE", "/analyses/x")).toHaveLength(1);
	});
});

describe("Export tab", () => {
	it("saves md/pdf/docx and shows the destination path", async () => {
		const s = makeSession({ id: "a" });
		const f = setup(s, makeDetail(s), [
			[
				"POST",
				"/sessions/a/export/save",
				(c) => ({ path: `C:\\out\\a.${(c.body as { format: string }).format}` }),
			],
		]);
		fireEvent.click(screen.getByTestId("tab-export"));
		expect(screen.getByTestId("export-dir-badge")).toHaveTextContent("Padrão global");
		expect(screen.getByTestId("export-dir-input")).toHaveValue(
			"C:\\Users\\me\\Documents\\ListeningResume",
		);
		expect(screen.getByTestId("export-apkg")).toBeDisabled();
		fireEvent.click(screen.getByTestId("export-pdf"));
		expect(await screen.findByText("PDF salvo em C:\\out\\a.pdf")).toBeInTheDocument();
		expect(f.to("POST", "/sessions/a/export/save")[0].body).toEqual({ format: "pdf" });
	});

	it("overrides the export dir per session and resets to the global default", async () => {
		const s = makeSession({ id: "a" });
		const f = setup(s, makeDetail(s), [["PATCH", "/sessions/a", { session: {} }]]);
		await screen.findAllByTestId("segment");
		fireEvent.click(screen.getByTestId("tab-export"));
		const input = screen.getByTestId("export-dir-input");
		fireEvent.change(input, { target: { value: "D:\\Aulas" } });
		fireEvent.blur(input);
		expect(await screen.findByText("Destino desta sessão: D:\\Aulas")).toBeInTheDocument();
		expect(f.to("PATCH", "/sessions/a")[0].body).toEqual({ exportDir: "D:\\Aulas" });
		expect(screen.getByTestId("export-dir-badge")).toHaveTextContent("Só nesta sessão");
		fireEvent.click(screen.getByTestId("export-dir-reset"));
		expect(await screen.findByText(/Usando a pasta padrão/)).toBeInTheDocument();
		expect(f.to("PATCH", "/sessions/a")[1].body).toEqual({ exportDir: null });
	});
});
