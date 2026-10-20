import { barHeights, expect, maxOf, test } from "./support/fixtures";

test.use({ initialSettings: { onboardingDone: false } });

test("first run: onboarding (mode → audio test → ready) lands on the dashboard and never shows again", async ({
	page,
	api,
}) => {
	await page.goto("/");
	const onboarding = page.getByTestId("onboarding");
	await expect(onboarding).toBeVisible();

	// Step 1 — transcription mode. Groq reveals the optional key field; Whisper hides it.
	await page.getByTestId("onboarding-mode-groq").click();
	await expect(page.getByTestId("onboarding-mode-groq")).toHaveAttribute("aria-pressed", "true");
	await expect(page.getByTestId("onboarding-groq-key")).toBeVisible();
	await page.getByTestId("onboarding-mode-whisper").click();
	await expect(page.getByTestId("onboarding-mode-whisper")).toHaveAttribute("aria-pressed", "true");
	await expect(page.getByTestId("onboarding-groq-key")).toBeHidden();
	await page.getByTestId("onboarding-next").click();

	// Step 2 — live meters fed by the real SSE level stream.
	await expect(page.getByRole("heading", { name: "Vamos testar seu áudio" })).toBeVisible();
	const sys = page.getByTestId("meter-system");
	const mic = page.getByTestId("meter-mic");
	await expect(sys.getByText("Captando")).toBeVisible();
	await expect(sys).toContainText("Padrão do sistema (Alto-falantes (Realtek(R) Audio))");
	await expect(mic).toContainText("Padrão do sistema (Microfone (Realtek(R) Audio))");

	for (const meter of [sys, mic]) {
		const bars = meter.locator("div:has(> .wbar2)");
		await expect(bars.locator(".wbar2")).toHaveCount(44);
		const first = await barHeights(bars);
		// Bars rise above the 3 px floor and keep moving as new levels arrive.
		await expect.poll(async () => maxOf(await barHeights(bars))).toBeGreaterThan(8);
		await expect.poll(async () => (await barHeights(bars)).join(",")).not.toBe(first.join(","));
	}
	await page.getByTestId("onboarding-next").click();

	// Step 3 — ready.
	await expect(page.getByRole("heading", { name: "Tudo pronto." })).toBeVisible();
	await page.getByTestId("onboarding-finish").click();

	await expect(onboarding).toBeHidden();
	await expect(page.getByTestId("greeting")).toHaveText(/^(Bom dia|Boa tarde|Boa noite)/);
	await expect(page.getByTestId("toast")).toContainText("Bem-vindo!");

	const settings = await api.settings();
	expect(settings.onboardingDone).toBe(true);
	expect(settings.transcriptionProvider).toBe("whisper-cpp");

	await page.reload();
	await expect(page.getByTestId("record-button")).toBeVisible();
	await expect(page.getByTestId("onboarding")).toHaveCount(0);
});

test("onboarding can be skipped", async ({ page, api }) => {
	await page.goto("/");
	await page.getByTestId("onboarding-skip").click();
	await expect(page.getByTestId("record-button")).toBeVisible();
	expect((await api.settings()).onboardingDone).toBe(true);
});
