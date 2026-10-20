import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, openApp, type SessionSummary, test } from "./support/fixtures";

const TITLE = "Aula de Termodinâmica — Entropia";

async function openDetail(page: import("@playwright/test").Page, title: string) {
	await openApp(page);
	await page.getByTestId("nav-sessions").click();
	await page.getByTestId("session-card").filter({ hasText: title }).click();
	await expect(page.getByTestId("detail-title")).toHaveText(title);
}

test.describe("session detail", () => {
	let session: SessionSummary;

	test.beforeEach(async ({ api }) => {
		session = await api.recordSession({ title: TITLE, seconds: 2 });
		expect(session.status).toBe("transcribed");
	});

	test("analysis tab: executive summary renders; flashcards flip on click", async ({
		page,
		api,
	}) => {
		await openDetail(page, TITLE);
		await page.getByTestId("tab-analysis").click();
		await expect(page.getByTestId("no-analysis")).toBeVisible();

		const select = page.getByTestId("template-select");
		await expect(select).toHaveValue("resumo-executivo");
		await page.getByTestId("generate-analysis").click();
		await expect(page.getByTestId("toast")).toContainText("Gerando “Resumo Executivo”");
		await expect(page.getByTestId("analyzing")).toBeVisible();
		const chips = page.getByTestId("analysis-chip");
		await expect(chips).toHaveCount(1, { timeout: 20_000 });
		await expect(chips.first()).toContainText("Resumo Executivo");
		await expect(chips.first()).toHaveAttribute("aria-pressed", "true");
		const view = page.getByTestId("analysis-view");
		await expect(view.locator("h3.an-h").first()).toBeVisible();
		await expect(view).toContainText("Carla revisa o documento de requisitos");

		// Flashcards template → flip cards.
		await select.selectOption("flashcards-anki");
		await page.getByTestId("generate-analysis").click();
		await expect(chips).toHaveCount(2, { timeout: 20_000 });
		await expect(chips.nth(1)).toContainText("Flashcards");
		await expect(chips.nth(1)).toHaveAttribute("aria-pressed", "true");
		const cards = page.getByTestId("flashcard");
		await expect(cards.first()).toBeVisible();
		expect(await cards.count()).toBeGreaterThanOrEqual(4);
		const card = cards.first();
		await expect(card).toHaveAttribute("aria-pressed", "false");
		await expect(card).toHaveAttribute("aria-label", /^Pergunta: /);
		await card.click();
		await expect(card).toHaveAttribute("aria-pressed", "true");
		await expect(card).toHaveClass(/\bon\b/);
		await expect(card).toHaveAttribute("aria-label", /^Resposta: /);
		await card.click();
		await expect(card).toHaveAttribute("aria-pressed", "false");

		// Chips switch between analyses.
		await chips.first().click();
		await expect(page.getByTestId("flashcard")).toHaveCount(0);
		await expect(view).toContainText("Carla");
		expect((await api.session(session.id)).analyses).toHaveLength(2);

		// Delete the active analysis.
		await page.getByTestId("delete-analysis").click();
		await expect(chips).toHaveCount(1);
		await expect(page.getByTestId("toast")).toHaveText("Análise apagada");
	});

	test("export tab: md/pdf/docx saved to the global dir, then a per-session override and reset", async ({
		page,
		api,
	}) => {
		const globalDir = (await api.settings()).exportDir as string;
		await openDetail(page, TITLE);
		await page.getByTestId("detail-export").click();
		const badge = page.getByTestId("export-dir-badge");
		await expect(badge).toHaveText("Padrão global");
		await expect(page.getByTestId("export-dir-input")).toHaveValue(globalDir);
		await expect(page.getByTestId("export-apkg")).toBeDisabled();

		const toast = page.getByTestId("toast");
		const saved: string[] = [];
		for (const [fmt, label] of [
			["md", "Markdown"],
			["pdf", "PDF"],
			["docx", "DOCX"],
		] as const) {
			await page.getByTestId(`export-${fmt}`).click();
			await expect(toast).toHaveText(new RegExp(`^${label} salvo em .+\\.${fmt}$`));
			const file = ((await toast.textContent()) ?? "").replace(`${label} salvo em `, "");
			expect(path.dirname(file)).toBe(globalDir);
			expect(fs.statSync(file).size).toBeGreaterThan(200);
			saved.push(file);
		}
		expect(fs.readFileSync(saved[0], "utf-8")).toContain(TITLE);
		expect(fs.readFileSync(saved[1]).subarray(0, 5).toString()).toBe("%PDF-");
		expect(fs.readFileSync(saved[2]).subarray(0, 2).toString()).toBe("PK");

		// Per-session override.
		const override = path.join(os.tmpdir(), "lr-e2e", "fake", "override-export");
		fs.rmSync(override, { recursive: true, force: true });
		const input = page.getByTestId("export-dir-input");
		await input.fill(override);
		await input.press("Enter");
		await expect(badge).toHaveText("Só nesta sessão");
		await expect(toast).toHaveText(`Destino desta sessão: ${override}`);
		expect((await api.session(session.id)).session.exportDir).toBe(override);
		await page.getByTestId("export-md").click();
		await expect(toast).toHaveText(new RegExp(`^Markdown salvo em ${escapeRe(override)}`));
		expect(fs.readdirSync(override).some((f) => f.endsWith(".md"))).toBe(true);

		// Reset back to the global default.
		await page.getByTestId("export-dir-reset").click();
		await expect(badge).toHaveText("Padrão global");
		await expect(input).toHaveValue(globalDir);
		await expect(toast).toHaveText(`Usando a pasta padrão: ${globalDir}`);
		expect((await api.session(session.id)).session.exportDir).toBeNull();
	});

	test("re-transcribe asks for confirmation; rename from the title; delete from the detail page", async ({
		page,
		api,
	}) => {
		await openDetail(page, TITLE);
		// An already-transcribed session asks before replacing its transcript.
		await page.getByTestId("detail-transcribe").click();
		await expect(page.getByTestId("retranscribe-modal")).toBeVisible();
		await page.getByTestId("retranscribe-cancel").click();
		await expect(page.getByTestId("retranscribe-modal")).toBeHidden();
		expect((await api.session(session.id)).session.status).toBe("transcribed");

		await page.getByTestId("detail-title").click();
		const input = page.getByTestId("detail-title-input");
		await expect(input).toBeFocused();
		await input.fill("Aula 7 — Segunda Lei");
		await input.press("Enter");
		await expect(page.getByTestId("detail-title")).toHaveText("Aula 7 — Segunda Lei");
		await expect(page.getByTestId("toast")).toHaveText("Sessão renomeada");
		expect((await api.session(session.id)).session.title).toBe("Aula 7 — Segunda Lei");

		await page.getByTestId("detail-delete").click();
		await expect(page.getByTestId("delete-modal")).toContainText("Aula 7 — Segunda Lei");
		await page.getByTestId("delete-confirm").click();
		await expect(page.getByTestId("delete-modal")).toBeHidden();
		await expect(page.getByTestId("toast")).toHaveText("Sessão apagada");
		await expect(page.getByTestId("session-detail")).toHaveCount(0);
		expect(await api.sessions()).toHaveLength(0);
	});
});

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
