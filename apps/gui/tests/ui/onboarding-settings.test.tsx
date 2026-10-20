import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
	meterCaption,
	meterDeviceLabel,
	Onboarding,
} from "../../src/features/onboarding/Onboarding";
import { groqStatus, SettingsPage, serviceRows } from "../../src/features/settings/SettingsPage";
import { TemplateEditorModal } from "../../src/features/templates/TemplateEditorModal";
import { TemplatesPage, templateMeta } from "../../src/features/templates/TemplatesPage";
import { ToastHost } from "../../src/shared/ui/Toast";
import { useStore } from "../../src/store";
import {
	DEVICES,
	installFakeEventSource,
	installManualRaf,
	makeHealth,
	makeSettings,
	mockFetch,
	TEMPLATES,
	waitForEventSource,
} from "./helpers";

const patchEcho = [
	"PATCH",
	"/settings",
	(c: { body: unknown }) => makeSettings(c.body as object),
] as const;

describe("Onboarding", () => {
	function setup(
		settings = makeSettings({ onboardingDone: false, transcriptionProvider: "whisper-cpp" }),
	) {
		installFakeEventSource();
		installManualRaf();
		const f = mockFetch([
			["PATCH", "/settings", (c) => ({ ...useStore.getState().settings, ...(c.body as object) })],
			["POST", "/config/groq-key", { ok: true, masked: "gsk_…abcd" }],
			["GET", "/devices", { devices: DEVICES }],
			["GET", "/health", makeHealth()],
		]);
		useStore.setState({ settings, devices: DEVICES });
		render(
			<>
				<Onboarding />
				<ToastHost />
			</>,
		);
		return f;
	}

	it("preselects Whisper (Recomendado) on first run even when settings default to Groq", () => {
		setup(makeSettings({ onboardingDone: false, transcriptionProvider: "groq" }));
		expect(screen.getByTestId("onboarding-mode-whisper")).toHaveClass("mode on");
		expect(screen.getByTestId("onboarding-mode-groq")).toHaveAttribute("aria-pressed", "false");
	});

	it("meter captions add the recording rate when the server reports it", () => {
		expect(meterCaption("Microfone USB", 16000)).toBe("Microfone USB · 16 kHz");
		expect(meterCaption("Microfone USB", 44100)).toBe("Microfone USB · 44.1 kHz");
		expect(meterCaption("Microfone USB", undefined)).toBe("Microfone USB");
		expect(meterDeviceLabel(DEVICES, "system", "@default", "Fone (Loopback)")).toBe(
			"Padrão do sistema (Fone)",
		);
		expect(meterDeviceLabel(DEVICES, "mic", "Microfone interno", null)).toBe("Microfone interno");
		expect(meterDeviceLabel(DEVICES, "mic", "Sumiu", null)).toBe("Sumiu");
	});

	it("walks the 3 steps with real meters and finishes", async () => {
		const f = setup();
		expect(screen.getByTestId("onboarding-mode-whisper")).toHaveClass("mode on");
		fireEvent.click(screen.getByTestId("onboarding-next"));

		// step 2: meters over SSE with the configured devices
		expect(await screen.findByText("Vamos testar seu áudio")).toBeInTheDocument();
		expect(f.to("PATCH", "/settings")[0].body).toEqual({ transcriptionProvider: "whisper-cpp" });
		const es = await waitForEventSource();
		expect(es.url).toBe("http://localhost:3456/api/audio/levels?system=%40default&mic=%40default");
		expect(within(screen.getByTestId("meter-system")).getByText("Conectando…")).toBeInTheDocument();
		act(() => es.open());
		expect(within(screen.getByTestId("meter-system")).getByText("Captando")).toBeInTheDocument();
		expect(screen.getByTestId("meter-system")).toHaveTextContent(
			"Padrão do sistema (Alto-falantes (Realtek))",
		);
		act(() =>
			es.emitEvent("devices", {
				system: "@default",
				mic: "@default",
				systemName: "Fone Bluetooth",
				micName: "Headset",
			}),
		);
		expect(screen.getByTestId("meter-mic")).toHaveTextContent("Padrão do sistema (Headset)");
		expect(screen.getByTestId("meter-system").querySelectorAll(".wbar2")).toHaveLength(44);

		fireEvent.click(screen.getByTestId("onboarding-next"));
		expect(es.closed).toBe(true);
		expect(screen.getByText("Tudo pronto.")).toBeInTheDocument();
		fireEvent.click(screen.getByTestId("onboarding-finish"));
		expect(
			await screen.findByText("Bem-vindo! Ctrl+Shift+R inicia uma gravação."),
		).toBeInTheDocument();
		expect(f.to("PATCH", "/settings")[1].body).toEqual({ onboardingDone: true });
		expect(useStore.getState().settings?.onboardingDone).toBe(true);
	});

	it("choosing Groq can save a key on the way", async () => {
		const f = setup();
		fireEvent.click(screen.getByTestId("onboarding-mode-groq"));
		fireEvent.change(screen.getByTestId("onboarding-groq-key"), { target: { value: "gsk_123" } });
		fireEvent.click(screen.getByTestId("onboarding-next"));
		await screen.findByText("Vamos testar seu áudio");
		expect(f.to("POST", "/config/groq-key")[0].body).toEqual({ key: "gsk_123" });
		expect(f.to("PATCH", "/settings")[0].body).toEqual({ transcriptionProvider: "groq" });
		fireEvent.click(screen.getByTestId("onboarding-back"));
		expect(screen.getByTestId("onboarding-mode-groq")).toBeInTheDocument();
	});

	it("shows 'Sem microfone' when no mic is configured", async () => {
		setup(makeSettings({ onboardingDone: false, micDevice: null }));
		fireEvent.click(screen.getByTestId("onboarding-next"));
		await screen.findByText("Vamos testar seu áudio");
		expect((await waitForEventSource()).url).toContain("mic=none");
		expect(screen.queryByTestId("meter-mic")).toBeNull();
		expect(screen.getByText("Sem microfone")).toBeInTheDocument();
	});

	it("marks a meter unavailable when the server cannot open the device", async () => {
		setup();
		fireEvent.click(screen.getByTestId("onboarding-next"));
		const es = await waitForEventSource();
		act(() => es.emitEvent("unavailable", { error: "Dispositivo não encontrado" }));
		const meter = screen.getByTestId("meter-system");
		expect(within(meter).getByText("Indisponível")).toBeInTheDocument();
		expect(meter).toHaveTextContent("Dispositivo não encontrado");
	});

	it("can be skipped", async () => {
		const f = setup();
		fireEvent.click(screen.getByTestId("onboarding-skip"));
		await vi.waitFor(() => expect(f.to("PATCH", "/settings")).toHaveLength(1));
		expect(f.to("PATCH", "/settings")[0].body).toEqual({ onboardingDone: true });
	});
});

describe("SettingsPage", () => {
	function setup() {
		const f = mockFetch([
			[...patchEcho],
			["GET", "/devices", { devices: DEVICES }],
			["GET", "/analysis/models", { models: ["llama3.1:8b", "qwen2.5:14b"] }],
			["GET", "/config/groq-key", { configured: true, masked: "gsk_…abcd" }],
			["POST", "/config/groq-key", { ok: true, masked: "gsk_…wxyz" }],
			["POST", "/config/groq-key/validate", { valid: true }],
			["DELETE", "/config/groq-key", { ok: true }],
			["GET", "/health", makeHealth({ ffmpeg: { ok: false, version: null } })],
			["POST", "/audio/test", { ok: true }],
		]);
		useStore.setState({ settings: makeSettings(), templates: TEMPLATES });
		render(
			<>
				<SettingsPage />
				<ToastHost />
			</>,
		);
		return f;
	}

	it("device pickers offer 'Padrão do sistema' and persist the choice", async () => {
		const f = setup();
		const sys = (await screen.findByTestId("settings-system-device-select")) as HTMLSelectElement;
		await vi.waitFor(() => expect(sys.options.length).toBe(3));
		expect(sys.options[0].text).toBe("Padrão do sistema (Alto-falantes (Realtek))");
		fireEvent.change(screen.getByTestId("settings-mic-device-select"), {
			target: { value: "none" },
		});
		await vi.waitFor(() => expect(f.to("PATCH", "/settings")).toHaveLength(1));
		expect(f.to("PATCH", "/settings")[0].body).toEqual({ micDevice: null });
	});

	it("toggles map to settings fields", async () => {
		const f = setup();
		fireEvent.click(screen.getByTestId("switch-silence"));
		fireEvent.click(screen.getByTestId("switch-auto-transcribe"));
		fireEvent.click(screen.getByTestId("provider-whisper"));
		await vi.waitFor(() => expect(f.to("PATCH", "/settings")).toHaveLength(3));
		expect(f.to("PATCH", "/settings").map((c) => c.body)).toEqual([
			{ silenceDetection: false },
			{ autoTranscribe: false },
			{ transcriptionProvider: "whisper-cpp" },
		]);
		expect(screen.getByTestId("switch-silence")).toHaveAttribute("aria-checked", "false");
		expect(screen.getByTestId("provider-whisper")).toHaveClass("mode on");
	});

	it("selects whisper model / analysis model / format", async () => {
		const f = setup();
		await vi.waitFor(() =>
			expect(
				(screen.getByTestId("analysis-model-select") as HTMLSelectElement).options,
			).toHaveLength(2),
		);
		fireEvent.change(screen.getByTestId("whisper-model-select"), { target: { value: "large-v3" } });
		fireEvent.change(screen.getByTestId("analysis-model-select"), {
			target: { value: "qwen2.5:14b" },
		});
		fireEvent.change(screen.getByTestId("export-format-select"), { target: { value: "pdf" } });
		await vi.waitFor(() => expect(f.to("PATCH", "/settings")).toHaveLength(3));
		expect(f.to("PATCH", "/settings").map((c) => c.body)).toEqual([
			{ whisperModel: "large-v3" },
			{ analysisModel: "qwen2.5:14b" },
			{ exportFormat: "pdf" },
		]);
	});

	it("test sound plays on the selected device", async () => {
		const f = setup();
		fireEvent.click(screen.getByTestId("test-sound-button"));
		expect(
			await screen.findByText("Tocando som de teste na saída selecionada…"),
		).toBeInTheDocument();
		expect(f.to("POST", "/audio/test")[0].body).toEqual({ device: "@default" });
	});

	it("Groq key: shows masked placeholder, saves + validates a new key, removes", async () => {
		const f = setup();
		const input = screen.getByTestId("groq-key-input");
		await vi.waitFor(() => expect(input).toHaveAttribute("placeholder", "gsk_…abcd"));
		expect(input).toHaveAttribute("type", "password");
		fireEvent.click(screen.getByTestId("groq-key-toggle"));
		expect(input).toHaveAttribute("type", "text");
		fireEvent.change(input, { target: { value: "gsk_new" } });
		fireEvent.click(screen.getByTestId("groq-key-validate"));
		expect(await screen.findByText("Chave válida — Groq conectado")).toBeInTheDocument();
		// validated before saving
		expect(f.to("POST", "/config/groq-key/validate")[0].body).toEqual({ key: "gsk_new" });
		expect(f.to("POST", "/config/groq-key")[0].body).toEqual({ key: "gsk_new" });
		expect(input).toHaveValue("");
		fireEvent.click(screen.getByTestId("groq-key-remove"));
		expect(await screen.findByText("Chave removida")).toBeInTheDocument();
		expect(f.to("DELETE", "/config/groq-key")).toHaveLength(1);
	});

	it("does not save an invalid key; validates the stored key without a draft", async () => {
		const f = mockFetch([
			["GET", "/devices", { devices: [] }],
			["GET", "/analysis/models", { models: [] }],
			["GET", "/config/groq-key", { configured: true, masked: "gsk_…abcd" }],
			["GET", "/health", makeHealth()],
			[
				"POST",
				"/config/groq-key/validate",
				(c) =>
					(c.body as { key?: string }).key ? { valid: false, error: "401" } : { valid: true },
			],
		]);
		useStore.setState({ settings: makeSettings(), templates: TEMPLATES });
		render(
			<>
				<SettingsPage />
				<ToastHost />
			</>,
		);
		await vi.waitFor(() => expect(screen.getByTestId("groq-key-validate")).toBeEnabled());
		fireEvent.click(screen.getByTestId("groq-key-validate"));
		expect(await screen.findByText("Chave válida — Groq conectado")).toBeInTheDocument();
		expect(f.to("POST", "/config/groq-key/validate")[0].body).toEqual({});
		expect(useStore.getState().groqValidated).toBe(true);
		fireEvent.change(screen.getByTestId("groq-key-input"), { target: { value: "gsk_bad" } });
		fireEvent.click(screen.getByTestId("groq-key-validate"));
		expect(await screen.findByText("Chave inválida: 401")).toBeInTheDocument();
		expect(f.to("POST", "/config/groq-key")).toHaveLength(0);
		expect(screen.getByTestId("groq-key-input")).toHaveValue("gsk_bad");
	});

	it("shows service status from /health", async () => {
		setup();
		const status = screen.getByTestId("service-status");
		await vi.waitFor(() =>
			expect(within(status).getByTestId("service-ffmpeg")).toHaveTextContent("não encontrado"),
		);
		expect(within(status).getByTestId("service-ollama")).toHaveTextContent("conectado · :11434");
	});

	it("Groq status: sem chave / chave não validada / conectado after validation", () => {
		expect(groqStatus(false, false)).toEqual({ detail: "sem chave", tone: "amb" });
		expect(groqStatus(true, false)).toEqual({ detail: "chave não validada", tone: "amb" });
		expect(groqStatus(true, true)).toEqual({ detail: "conectado", tone: "ok" });
	});

	it("serviceRows handles a missing server", () => {
		expect(serviceRows(null, makeSettings())).toEqual([
			{ key: "server", label: "Serviço local", detail: "indisponível", tone: "err" },
		]);
	});
});

describe("Templates", () => {
	function setup() {
		const f = mockFetch([
			[
				"POST",
				"/templates",
				(c) => ({
					status: 201,
					body: {
						template: {
							...(c.body as object),
							id: "new",
							builtin: false,
							sections: 1,
							language: "pt-BR",
						},
					},
				}),
			],
			[
				"PUT",
				"/templates/custom-1",
				(c) => ({ template: { ...TEMPLATES[2], ...(c.body as object) } }),
			],
			["DELETE", "/templates/custom-1", { ok: true }],
		]);
		useStore.setState({ templates: TEMPLATES });
		render(
			<>
				<TemplatesPage />
				<TemplateEditorModal />
				<ToastHost />
			</>,
		);
		return f;
	}

	it("lists templates with badges and meta", () => {
		mockFetch();
		setup();
		const cards = screen.getAllByTestId("template-card");
		expect(cards).toHaveLength(3);
		expect(cards[0]).toHaveTextContent("builtin");
		expect(cards[2]).toHaveTextContent("custom");
		expect(templateMeta(TEMPLATES[1])).toBe("1 seção · pt-BR");
		expect(cards[0]).toHaveTextContent("2 seções · pt-BR");
	});

	it("creates a new template", async () => {
		const f = setup();
		fireEvent.click(screen.getByTestId("new-template-button"));
		const modal = screen.getByTestId("template-modal");
		expect(modal).toHaveTextContent("Novo template");
		fireEvent.click(within(modal).getByTestId("template-save-button"));
		expect(screen.getByTestId("toast")).toHaveTextContent("Preencha o nome e o prompt");
		fireEvent.change(within(modal).getByTestId("template-name-input"), {
			target: { value: "Aula" },
		});
		fireEvent.change(within(modal).getByTestId("template-prompt-input"), {
			target: { value: "Resuma {transcricao}" },
		});
		fireEvent.click(within(modal).getByTestId("template-save-button"));
		expect(await screen.findByText("Template salvo")).toBeInTheDocument();
		expect(f.to("POST", "/templates")[0].body).toEqual({
			name: "Aula",
			description: "",
			prompt: "Resuma {transcricao}",
		});
		expect(screen.queryByTestId("template-modal")).toBeNull();
		expect(screen.getAllByTestId("template-card")).toHaveLength(4);
	});

	it("edits and deletes a custom template; builtins save as a copy", async () => {
		const f = setup();
		fireEvent.click(screen.getAllByTestId("template-card")[2]);
		let modal = screen.getByTestId("template-modal");
		fireEvent.change(within(modal).getByTestId("template-desc-input"), {
			target: { value: "Nova descrição" },
		});
		fireEvent.click(within(modal).getByTestId("template-save-button"));
		await screen.findByText("Template salvo");
		expect(f.to("PUT", "/templates/custom-1")[0].body).toMatchObject({
			description: "Nova descrição",
		});

		fireEvent.click(screen.getAllByTestId("template-card")[2]);
		fireEvent.click(
			within(screen.getByTestId("template-modal")).getByTestId("template-delete-button"),
		);
		await screen.findByText("Template apagado");
		expect(screen.getAllByTestId("template-card")).toHaveLength(2);

		fireEvent.click(screen.getAllByTestId("template-card")[0]);
		modal = screen.getByTestId("template-modal");
		expect(within(modal).getByRole("heading")).toHaveTextContent("Editar template");
		expect(within(modal).getByTestId("template-copy-hint")).toHaveTextContent(
			"Templates padrão são salvos como cópia",
		);
		expect(within(modal).getByTestId("template-save-button")).toHaveTextContent("Salvar template");
		expect(within(modal).getByTestId("template-name-input")).toHaveValue(
			"Resumo Executivo (cópia)",
		);
		expect(within(modal).queryByTestId("template-delete-button")).toBeNull();
		fireEvent.click(within(modal).getByTestId("template-save-button"));
		await vi.waitFor(() => expect(f.to("POST", "/templates")).toHaveLength(1));
	});
});
