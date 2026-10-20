import path from "node:path";
import { fileURLToPath } from "node:url";
import { API_URL, barHeights, expect, maxOf, optionLabels, test } from "./support/fixtures";

/**
 * REAL capture on this machine (Windows: wasapi-capture.exe, no fakes). Excluded from the
 * default run; start it with `playwright test --grep @hardware` (the config then boots the real
 * backend with a throw-away data/config dir). It plays test tones on the default output so the
 * loopback level is non-zero — expect to hear beeps.
 */
const OUT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"docs",
	"images",
);

// No auto-transcription: a workspace .env Groq key would otherwise send real audio out.
test.use({ initialSettings: { onboardingDone: false, autoTranscribe: false } });

test("real hardware: onboarding, loopback drives the waveform, live mic switch, duration ≈ wall time @hardware", async ({
	page,
	api,
	playwright,
}) => {
	test.skip(process.platform !== "win32", "WASAPI capture is Windows-only");
	const health = await api.get<{ services: { capture: { backend: string; ok: boolean } } }>(
		"/health",
	);
	expect(health.services.capture).toMatchObject({ backend: "wasapi", ok: true });

	// Onboarding with real meters.
	await page.goto("/");
	await page.getByTestId("onboarding-mode-whisper").click();
	await page.getByTestId("onboarding-next").click();
	await expect(page.getByTestId("meter-system").getByText("Captando")).toBeVisible({
		timeout: 15_000,
	});
	await expect(page.getByTestId("meter-system")).toContainText("Padrão do sistema (");
	await page.getByTestId("onboarding-next").click();
	await page.getByTestId("onboarding-finish").click();
	await expect(page.getByTestId("record-button")).toBeVisible();

	// Start recording.
	await page.getByTestId("record-button").click();
	await expect(page.getByTestId("recording-screen")).toBeVisible();
	const status = await api.get<{ recording: boolean; sessionId: string; startTime: number }>(
		"/recording/status",
	);
	expect(status.recording).toBe(true);
	const wave = page.getByTestId("waveform");
	await expect(page.getByTestId("toast")).toBeHidden({ timeout: 6_000 });

	// Beep on the default output via the native binary while sampling the bars.
	const tones = await playwright.request.newContext();
	const sample = async (ms: number) => {
		const maxima: number[] = [];
		const end = Date.now() + ms;
		while (Date.now() < end) {
			maxima.push(maxOf(await barHeights(wave)));
			await page.waitForTimeout(100);
		}
		return maxima;
	};
	let playing = true;
	const beeper = (async () => {
		while (playing) {
			await tones
				.post(`${API_URL}/audio/test`, {
					data: { device: "@default" },
					headers: { "content-type": "application/json" },
				})
				.catch(() => {});
			await new Promise((r) => setTimeout(r, 300));
		}
	})();
	const loud = await sample(3_500);
	await page.screenshot({ path: path.join(OUT, "19-real-gravacao-onda.png") });
	const loudMore = await sample(1_000);
	playing = false;
	await beeper;
	await tones.dispose();
	const loudMax = maxOf([...loud, ...loudMore]);

	// Silence: the 72-frame history (≈3.6 s) scrolls the tone out.
	await page.waitForTimeout(4_500);
	const quiet = await sample(1_500);
	const quietMax = maxOf(quiet);
	console.log(
		`[hardware] waveform max bar height — with tone: ${loudMax.toFixed(1)} px, silent: ${quietMax.toFixed(1)} px`,
	);
	expect(loudMax).toBeGreaterThan(30);
	expect(quietMax).toBeLessThan(loudMax);

	// Live mic switch to another device and back to "Padrão do sistema".
	const mic = page.getByTestId("mic-device-select");
	const labels = await optionLabels(mic);
	expect(labels[0]).toMatch(/^Padrão do sistema/);
	const values = await mic.evaluate((el) =>
		Array.from((el as HTMLSelectElement).options, (o) => o.value),
	);
	const other = values.find((v) => v !== "@default" && v !== "none");
	console.log(`[hardware] mic options: ${labels.join(" | ")}; switching to: ${other ?? "(none)"}`);
	if (other) {
		await mic.selectOption(other);
		await expect(page.getByTestId("toast")).toContainText("Microfone trocado");
		await expect(mic).toHaveValue(other);
		await mic.selectOption("@default");
		await expect(page.getByTestId("toast")).toContainText(
			"Microfone trocado: Padrão do sistema — sem interromper a gravação",
		);
	}
	await expect(page.getByTestId("recording-screen")).toBeVisible();
	expect((await api.recordingStatus()).recording).toBe(true);

	// Stop → duration from the WAV headers ≈ wall time.
	await page.getByTestId("stop-recording-button").click();
	const wall = (Date.now() - status.startTime) / 1000;
	await expect(page.getByTestId("session-detail")).toBeVisible();
	const { session } = await api.session(status.sessionId);
	console.log(
		`[hardware] session ${session.id}: duration ${session.duration.toFixed(2)} s vs wall ${wall.toFixed(2)} s, chunks ${session.chunks}`,
	);
	expect(Math.abs(session.duration - wall)).toBeLessThanOrEqual(1);
	expect(session.status).toBe("stopped");
	await expect(page.getByTestId("player")).toBeVisible();
	await expect(page.getByTestId("not-transcribed")).toContainText("Transcreva para ler");
	await expect(page.getByTestId("toast")).toBeHidden({ timeout: 6_000 });
	await page.mouse.move(0, 0);
	await page.screenshot({ path: path.join(OUT, "20-real-sessao.png") });
});
