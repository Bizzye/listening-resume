import {
	barHeights,
	expect,
	maxOf,
	openApp,
	optionLabels,
	selectByLabel,
	test,
} from "./support/fixtures";

test("recording journey: live waveform, live device switch, mute → silence, stop → transcript + player", async ({
	page,
	api,
}) => {
	await openApp(page);
	await page.getByTestId("record-button").click();

	const screen = page.getByTestId("recording-screen");
	await expect(screen).toBeVisible();
	await expect(page.getByTestId("record-button")).toBeHidden(); // app shell hidden while recording
	const startedAt = Date.now();
	const status = await api.recordingStatus();
	expect(status.recording).toBe(true);
	const sessionId = status.sessionId as string;

	// Timer advances from the server start time.
	const timer = page.getByTestId("recording-timer");
	await expect(timer).toHaveText(/^00:00:0\d$/);
	await expect(timer).not.toHaveText("00:00:00");

	// Waveform: 72 bars driven by the SSE levels — tall and changing over time.
	const wave = page.getByTestId("waveform");
	await expect(wave.locator(".wbar2")).toHaveCount(72);
	await expect.poll(async () => maxOf(await barHeights(wave))).toBeGreaterThan(30);
	const t0 = await barHeights(wave);
	await page.waitForTimeout(500);
	const t1 = await barHeights(wave);
	expect(t1).not.toEqual(t0);
	expect(t1.filter((h) => h > 4).length).toBeGreaterThan(10);

	// Device pickers: "Padrão do sistema (<current>)" first, then the real devices.
	const out = page.getByTestId("recording-device-select");
	const mic = page.getByTestId("mic-device-select");
	await expect(out).toHaveValue("@default");
	await expect(mic).toHaveValue("@default");
	const outLabels = await optionLabels(out);
	expect(outLabels[0]).toBe("Padrão do sistema (Alto-falantes (Realtek(R) Audio))");
	expect(outLabels).toContain("Fones de ouvido (WH-1000XM4)");
	const micLabels = await optionLabels(mic);
	expect(micLabels[0]).toBe("Padrão do sistema (Microfone (Realtek(R) Audio))");
	expect(micLabels).toContain("Microfone (USB Audio Device)");
	expect(micLabels.at(-1)).toBe("Sem microfone");

	// Live switch, mic and output — the same recording keeps going.
	const toast = page.getByTestId("toast");
	await selectByLabel(mic, "Microfone (USB Audio Device)");
	await expect(toast).toHaveText(
		"Microfone trocado: Microfone (USB Audio Device) — sem interromper a gravação",
	);
	await selectByLabel(out, "Fones de ouvido");
	await expect(toast).toContainText("Captura trocada: Fones de ouvido (WH-1000XM4)");
	await expect(screen).toBeVisible();
	const after = await api.get<{
		recording: boolean;
		sessionId: string;
		devices: Record<string, string>;
	}>("/recording/status");
	expect(after).toMatchObject({
		recording: true,
		sessionId,
		devices: { system: "Fones de ouvido (WH-1000XM4)", mic: "Microfone (USB Audio Device)" },
	});
	await expect.poll(async () => maxOf(await barHeights(wave))).toBeGreaterThan(30);

	// Back to "Padrão do sistema" for the mic.
	await mic.selectOption("@default");
	await expect(toast).toHaveText(
		"Microfone trocado: Padrão do sistema — sem interromper a gravação",
	);

	// Mute both sources → silence warning + collapsed bars.
	await page.getByTestId("mute-system-button").click();
	await page.getByTestId("mute-mic-button").click();
	await expect(page.getByTestId("mute-system-button")).toHaveAttribute("aria-pressed", "true");
	await expect(page.getByTestId("mute-mic-button")).toHaveAttribute("aria-pressed", "true");
	await expect(page.getByTestId("silence-warning")).toBeVisible();
	await expect(page.locator(".wavewrap")).toHaveClass(/dead/);
	await expect
		.poll(async () => maxOf(await barHeights(wave)), { timeout: 8_000 })
		.toBeLessThanOrEqual(4.5);
	expect((await api.recordingStatus()).muted).toEqual({ system: true, mic: true });

	// Unmute → audio is back, warning gone.
	await page.getByTestId("mute-system-button").click();
	await page.getByTestId("mute-mic-button").click();
	await expect(page.getByTestId("silence-warning")).toBeHidden();
	await expect.poll(async () => maxOf(await barHeights(wave))).toBeGreaterThan(30);

	// Stop → session detail; auto-transcription finishes and shows segments.
	await page.getByTestId("stop-recording-button").click();
	const wall = (Date.now() - startedAt) / 1000;
	await expect(page.getByTestId("session-detail")).toBeVisible();
	await expect(toast).toContainText("Gravação salva");
	const segments = page.getByTestId("segment");
	await expect(segments.first()).toBeVisible({ timeout: 20_000 });
	await expect(page.getByTestId("status-badge")).toHaveAttribute("data-status", "transcribed");

	const { session, transcript } = await api.session(sessionId);
	expect(session.duration).toBeGreaterThan(wall - 2);
	expect(session.duration).toBeLessThan(wall + 2);
	const n = transcript?.segments.length ?? 0;
	expect(n).toBeGreaterThan(2);
	await expect(segments).toHaveCount(n);
	await expect(page.getByTestId("segment-count")).toHaveText(`${n} segmentos`);

	// Click a later segment → the <audio> seeks there and the player time follows.
	const target = segments.nth(n - 1);
	const stamp = (await target.locator(".seg-t").textContent())?.trim() ?? "";
	expect(stamp).not.toBe("0:00");
	await target.click();
	await expect(page.getByTestId("player-time")).toHaveText(stamp);
	await expect(target).toHaveClass(/\bon\b/);
	const current = await page
		.getByTestId("session-audio")
		.evaluate((a) => (a as HTMLAudioElement).currentTime);
	// <audio> stores currentTime as a double rounded by the media pipeline (6.06 vs 6.0600000000000005).
	expect(current).toBeGreaterThanOrEqual((transcript?.segments[n - 1].start ?? 0) - 0.01);

	// Scrub to the start.
	const scrub = page.getByTestId("scrub");
	const box = await scrub.boundingBox();
	if (!box) throw new Error("scrub not laid out");
	await page.mouse.click(box.x + 1, box.y + box.height / 2);
	await expect(page.getByTestId("player-time")).toHaveText("0:00");
});

test("discarding a recording removes it", async ({ page, api }) => {
	await openApp(page);
	await page.getByTestId("record-button").click();
	await expect(page.getByTestId("recording-screen")).toBeVisible();
	await page.getByTestId("discard-recording-button").click();
	await expect(page.getByTestId("greeting")).toBeVisible();
	await expect(page.getByTestId("toast")).toHaveText("Gravação descartada");
	expect(await api.sessions()).toHaveLength(0);
	expect((await api.recordingStatus()).recording).toBe(false);
});

test("Ctrl+Shift+R starts and stops a recording from anywhere", async ({ page, api }) => {
	await openApp(page);
	await page.getByTestId("nav-templates").click();
	await page.keyboard.press("Control+Shift+R");
	await expect(page.getByTestId("recording-screen")).toBeVisible();
	await expect(page.getByTestId("recording-timer")).not.toHaveText("00:00:00");
	await page.keyboard.press("Control+Shift+R");
	await expect(page.getByTestId("session-detail")).toBeVisible();
	expect((await api.recordingStatus()).recording).toBe(false);
	expect(await api.sessions()).toHaveLength(1);
});

test.describe("without auto-transcription", () => {
	test.use({ initialSettings: { autoTranscribe: false } });

	test("stopping lands on a playable, not-yet-transcribed session; Transcrever runs on demand", async ({
		page,
		api,
	}) => {
		await openApp(page);
		await page.getByTestId("record-button").click();
		await expect(page.getByTestId("recording-timer")).not.toHaveText(/^00:00:0[01]$/);
		await page.getByTestId("stop-recording-button").click();
		await expect(page.getByTestId("session-detail")).toBeVisible();
		await expect(page.getByTestId("toast")).toHaveText("Gravação salva");
		await expect(page.getByTestId("status-badge")).toHaveAttribute("data-status", "stopped");
		await expect(page.getByTestId("player")).toBeVisible();
		const empty = page.getByTestId("not-transcribed");
		await expect(empty).toContainText("Transcreva para ler, buscar e analisar esta sessão.");

		await empty.getByRole("button", { name: "Transcrever" }).click();
		await expect(page.getByTestId("segment").first()).toBeVisible({ timeout: 20_000 });
		const [s] = await api.sessions();
		expect(s.status).toBe("transcribed");
	});
});
