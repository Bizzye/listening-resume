import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { barHeights, expect, maxOf, selectByLabel, test } from "./support/fixtures";

/**
 * Walks the whole app and writes the documentation screenshots to docs/images/.
 * Run with: `playwright test --grep @screens` (seeds its own data on a fresh fake backend).
 */
const OUT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"docs",
	"images",
);

async function shot(page: Page, name: string) {
	// Let fonts settle and the mouse get out of the way of hover styles.
	await page.evaluate(() => document.fonts.ready);
	// `animations: "disabled"` fast-forwards CSS transitions (theme fade, page entry); the
	// waveform is rAF-driven and unaffected.
	await page.screenshot({
		path: path.join(OUT, `${name}.png`),
		caret: "hide",
		animations: "disabled",
	});
}

async function quiet(page: Page) {
	await expect(page.getByTestId("toast")).toBeHidden({ timeout: 6_000 });
}

test.use({ initialSettings: { onboardingDone: false } });
test.setTimeout(240_000);

test("documentation screenshots @screens", async ({ page, api }) => {
	// ── Seed: long imported sessions, transcribed and analyzed ─────────────────────────────
	const oneOnOne = await api.importAudio({
		title: "1:1 com a Carla — feedback trimestral",
		seconds: 22 * 60,
	});
	await api.waitIdle(oneOnOne.id);
	const podcast = await api.importAudio({
		title: "Podcast Tecnologia & Sociedade · Ep. 42",
		seconds: 52 * 60,
	});
	await api.waitIdle(podcast.id);
	await api.analyze(podcast.id, ["podcast-artigo"]);
	const meeting = await api.importAudio({
		title: "Reunião de planejamento — Roadmap Q3",
		seconds: 38 * 60,
	});
	await api.waitIdle(meeting.id);
	await api.analyze(meeting.id, ["ata-reuniao"]);
	const lecture = await api.importAudio({
		title: "Aula 7 — Termodinâmica: Entropia e a 2ª Lei",
		seconds: 47 * 60 + 12,
	});
	await api.waitIdle(lecture.id);
	await api.analyze(lecture.id, ["resumo-executivo", "flashcards-anki", "videoaula-extracao"]);
	// One session still waiting for transcription.
	await api.patchSettings({ autoTranscribe: false, onboardingDone: false });
	await api.importAudio({ title: "Daily do time de produto", seconds: 14 * 60 + 31 });
	await api.patchSettings({ autoTranscribe: true });

	// ── Onboarding ──────────────────────────────────────────────────────────────────────────
	await page.goto("/");
	await expect(page.getByTestId("onboarding")).toBeVisible();
	await page.getByTestId("onboarding-mode-whisper").click();
	await page.mouse.move(0, 0);
	await shot(page, "01-onboarding-modo");

	await page.getByTestId("onboarding-next").click();
	const sysBars = page.getByTestId("meter-system").locator("div:has(> .wbar2)");
	const micBars = page.getByTestId("meter-mic").locator("div:has(> .wbar2)");
	await expect(page.getByTestId("meter-system").getByText("Captando")).toBeVisible();
	// Let the 44-bar history fill up.
	await expect
		.poll(async () => (await barHeights(sysBars)).filter((h) => h > 4).length)
		.toBeGreaterThan(40);
	await expect
		.poll(async () => (await barHeights(micBars)).filter((h) => h > 4).length)
		.toBeGreaterThan(40);
	await shot(page, "02-onboarding-teste-audio");

	await page.getByTestId("onboarding-next").click();
	await expect(page.getByRole("heading", { name: "Tudo pronto." })).toBeVisible();
	await shot(page, "03-onboarding-pronto");

	await page.getByTestId("onboarding-finish").click();
	await expect(page.getByTestId("greeting")).toBeVisible();
	// Whisper isn't installed on the fake backend; switch to Groq with a demo key so the
	// service status line is clean (the key only lands in the throw-away config dir).
	await api.post("/config/groq-key", {
		key: "gsk_demo0000000000000000000000000000000000000000000000",
	});
	await api.patchSettings({ transcriptionProvider: "groq" });
	await page.reload();
	await expect(page.getByTestId("greeting")).toBeVisible();
	await expect(page.getByTestId("services-summary")).not.toContainText("indisponível");
	await quiet(page);
	await expect(page.getByTestId("session-card")).toHaveCount(4);
	await shot(page, "04-dashboard");

	// ── Recording ───────────────────────────────────────────────────────────────────────────
	await page.getByTestId("record-button").click();
	const wave = page.getByTestId("waveform");
	await expect(wave).toBeVisible();
	await quiet(page);
	// Wait for a full, lively history (all 72 bars above the floor, some tall).
	await expect
		.poll(async () => (await barHeights(wave)).filter((h) => h > 20).length, { timeout: 10_000 })
		.toBeGreaterThan(65);
	await expect.poll(async () => maxOf(await barHeights(wave))).toBeGreaterThan(90);
	await expect(page.getByTestId("recording-timer")).not.toHaveText(/^00:00:0[0-3]$/);
	await shot(page, "05-gravacao");

	await selectByLabel(page.getByTestId("mic-device-select"), "Microfone (USB Audio Device)");
	await expect(page.getByTestId("toast")).toContainText("Microfone trocado");
	await shot(page, "06-gravacao-dispositivos");

	await page.getByTestId("mute-system-button").click();
	await page.getByTestId("mute-mic-button").click();
	await expect(page.getByTestId("silence-warning")).toBeVisible();
	await quiet(page);
	await expect
		.poll(async () => maxOf(await barHeights(wave)), { timeout: 8_000 })
		.toBeLessThanOrEqual(4.5);
	await shot(page, "07-gravacao-silencio");
	await page.getByTestId("mute-system-button").click();
	await page.getByTestId("mute-mic-button").click();
	await page.getByTestId("stop-recording-button").click();
	await expect(page.getByTestId("session-detail")).toBeVisible();
	await page.getByTestId("detail-title").click();
	await page.getByTestId("detail-title-input").fill("Teste de captura — fone + microfone");
	await page.getByTestId("detail-title-input").press("Enter");
	await expect(page.getByTestId("segment").first()).toBeVisible({ timeout: 20_000 });

	// ── Sessions ────────────────────────────────────────────────────────────────────────────
	await page.getByTestId("nav-sessions").click();
	await expect(page.getByTestId("session-card")).toHaveCount(6);
	await quiet(page);
	await page.mouse.move(0, 0);
	await shot(page, "08-sessoes");

	await page
		.getByTestId("session-card")
		.filter({ hasText: "Reunião de planejamento" })
		.getByTestId("session-menu-button")
		.click();
	await expect(page.getByTestId("session-menu")).toBeVisible();
	await shot(page, "09-sessoes-menu");
	await page.keyboard.press("Escape");
	await page.getByRole("heading", { name: "Sessões" }).click();

	// ── Detail ──────────────────────────────────────────────────────────────────────────────
	await page.getByTestId("session-card").filter({ hasText: "Aula 7" }).click();
	await expect(page.getByTestId("detail-title")).toHaveText(/Aula 7/);
	const segments = page.getByTestId("segment");
	await expect(segments.nth(5)).toBeVisible();
	await segments.nth(4).click();
	await page.getByTestId("play-toggle").click();
	await expect(page.getByTestId("play-toggle")).toHaveAttribute("aria-label", "Reproduzir");
	await expect(segments.nth(4)).toHaveClass(/\bon\b/);
	await page.mouse.move(0, 0);
	await shot(page, "10-detalhe-transcricao");

	await page.getByTestId("tab-analysis").click();
	const chips = page.getByTestId("analysis-chip");
	await expect(chips).toHaveCount(3);
	await chips.filter({ hasText: "Videoaula" }).click();
	await expect(page.getByTestId("analysis-view")).toBeVisible();
	await page.mouse.move(0, 0);
	await shot(page, "11-detalhe-analise");

	await chips.filter({ hasText: "Flashcards" }).click();
	const cards = page.getByTestId("flashcard");
	await expect(cards.first()).toBeVisible();
	await cards.nth(1).click();
	await expect(cards.nth(1)).toHaveAttribute("aria-pressed", "true");
	await page.mouse.move(0, 0);
	await page.waitForTimeout(700); // flip transition
	await shot(page, "12-detalhe-flashcards");

	await page.getByTestId("tab-export").click();
	await page.getByTestId("export-pdf").click();
	await expect(page.getByTestId("toast")).toContainText("PDF salvo em");
	await page.mouse.move(0, 0);
	await shot(page, "13-detalhe-export");

	// ── Templates ───────────────────────────────────────────────────────────────────────────
	await page.getByTestId("nav-templates").click();
	await expect(page.getByTestId("template-card")).toHaveCount(6);
	await quiet(page);
	await page.mouse.move(0, 0);
	await shot(page, "14-templates");

	await page.getByTestId("new-template-button").click();
	await page.getByTestId("template-name-input").fill("Retrospectiva da sprint");
	await page
		.getByTestId("template-desc-input")
		.fill("O que foi bem, o que melhorar e as ações combinadas.");
	await page
		.getByTestId("template-prompt-input")
		.fill(
			'Você é um facilitador ágil. A partir da transcrição da retrospectiva "{titulo}", organize:\n\n## O que foi bem\nPontos positivos citados, um por linha.\n\n## O que melhorar\nProblemas e incômodos, com contexto.\n\n## Ações\n- [ ] ação — responsável — prazo\n\nTranscrição:\n{transcricao}',
		);
	// Show the prompt from its first line, without the focus ring.
	await page.getByTestId("template-prompt-input").evaluate((el) => {
		el.scrollTop = 0;
		(el as HTMLTextAreaElement).blur();
	});
	await shot(page, "15-template-editor");
	await page.getByTestId("template-save-button").click();
	await expect(page.getByTestId("template-modal")).toBeHidden();

	// ── Settings + light theme ──────────────────────────────────────────────────────────────
	await page.getByTestId("nav-settings").click();
	await expect(page.getByTestId("service-ollama")).toContainText("conectado");
	await quiet(page);
	await page.mouse.move(0, 0);
	await shot(page, "16-configuracoes");

	await page.getByTestId("nav-dashboard").click();
	await page.getByTestId("theme-switch").click();
	await expect(page.locator("div.lr")).toHaveClass(/\blight\b/);
	await page.mouse.move(0, 0);
	await shot(page, "17-tema-claro");
	await page.getByTestId("theme-switch").click();
	await expect(page.locator("div.lr")).not.toHaveClass(/\blight\b/);

	// ── Delete confirmation ─────────────────────────────────────────────────────────────────
	await page.getByTestId("nav-sessions").click();
	await page
		.getByTestId("session-card")
		.filter({ hasText: "Daily do time" })
		.getByTestId("session-menu-button")
		.click();
	await page.getByTestId("menu-delete").click();
	await expect(page.getByTestId("delete-modal")).toBeVisible();
	await page.mouse.move(0, 0);
	await shot(page, "18-apagar-modal");
	await page.getByTestId("delete-cancel").click();
});
