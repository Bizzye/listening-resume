import { expect, openApp, optionLabels, test } from "./support/fixtures";

test("settings: device pickers, toggles persist across reloads", async ({ page, api }) => {
	await openApp(page);
	await page.getByTestId("nav-settings").click();
	await expect(page.getByRole("heading", { name: "Configurações" })).toBeVisible();

	const sys = page.getByTestId("settings-system-device-select");
	const mic = page.getByTestId("settings-mic-device-select");
	await expect(sys).toHaveValue("@default");
	await expect(mic).toHaveValue("@default");
	await expect
		.poll(() => optionLabels(sys))
		.toEqual([
			"Padrão do sistema (Alto-falantes (Realtek(R) Audio))",
			"Alto-falantes (Realtek(R) Audio)",
			"Fones de ouvido (WH-1000XM4)",
		]);
	expect(await optionLabels(mic)).toEqual([
		"Padrão do sistema (Microfone (Realtek(R) Audio))",
		"Microfone (Realtek(R) Audio)",
		"Microfone (USB Audio Device)",
		"Sem microfone",
	]);

	await mic.selectOption("none");
	await sys.selectOption("Fones de ouvido (WH-1000XM4)");
	const silence = page.getByTestId("switch-silence");
	const auto = page.getByTestId("switch-auto-transcribe");
	await expect(silence).toHaveAttribute("aria-checked", "true");
	await silence.click();
	await auto.click();
	await expect(silence).toHaveAttribute("aria-checked", "false");
	await expect(auto).toHaveAttribute("aria-checked", "false");
	await page.getByTestId("provider-whisper").click();
	await page.getByTestId("whisper-model-select").selectOption("large-v3");
	await expect
		.poll(() => api.settings())
		.toMatchObject({
			micDevice: null,
			systemDevice: "Fones de ouvido (WH-1000XM4)",
			silenceDetection: false,
			autoTranscribe: false,
			transcriptionProvider: "whisper-cpp",
			whisperModel: "large-v3",
		});

	await page.reload();
	await page.getByTestId("nav-settings").click();
	await expect(page.getByTestId("switch-silence")).toHaveAttribute("aria-checked", "false");
	await expect(page.getByTestId("switch-auto-transcribe")).toHaveAttribute("aria-checked", "false");
	await expect(page.getByTestId("settings-mic-device-select")).toHaveValue("none");
	await expect(page.getByTestId("settings-system-device-select")).toHaveValue(
		"Fones de ouvido (WH-1000XM4)",
	);
	await expect(page.getByTestId("provider-whisper")).toHaveAttribute("aria-pressed", "true");
	await expect(page.getByTestId("whisper-model-select")).toHaveValue("large-v3");

	// Service status rows come from /health.
	await expect(page.getByTestId("service-ollama")).toContainText("conectado");
	await expect(page.getByTestId("service-capture")).toContainText("Captura de áudio · fake");

	// Test sound → toast.
	await page.getByTestId("test-sound-button").click();
	await expect(page.getByTestId("toast")).toHaveText("Tocando som de teste na saída selecionada…");
});

test("theme switch toggles the light class and persists", async ({ page, api }) => {
	await openApp(page);
	const root = page.locator("div.lr");
	await expect(root).not.toHaveClass(/\blight\b/);
	const sw = page.getByTestId("theme-switch");
	await expect(sw).toHaveAttribute("aria-checked", "true");
	await sw.click();
	await expect(root).toHaveClass(/\blight\b/);
	await expect(sw).toHaveAttribute("aria-checked", "false");
	await expect.poll(async () => (await api.settings()).theme).toBe("light");
	const bg = await page.locator("body").evaluate(() => {
		const el = document.querySelector("div.lr") as HTMLElement;
		return getComputedStyle(el).backgroundColor;
	});
	await page.reload();
	await expect(page.locator("div.lr")).toHaveClass(/\blight\b/);
	await page.getByTestId("theme-switch").click();
	await expect(page.locator("div.lr")).not.toHaveClass(/\blight\b/);
	await expect.poll(async () => (await api.settings()).theme).toBe("dark");
	const darkBg = await page
		.locator("div.lr")
		.evaluate((el) => getComputedStyle(el).backgroundColor);
	expect(darkBg).not.toBe(bg);
});
