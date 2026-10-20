import { expect, openApp, test } from "./support/fixtures";

const TITLES = [
	"Reunião de planejamento Q3",
	"Aula de Termodinâmica — Entropia",
	"Podcast · Tecnologia & Sociedade",
];

test("sessions: search filters by title and transcript, quick-menu rename and delete via modal", async ({
	page,
	api,
}) => {
	for (const title of TITLES) await api.recordSession({ title, seconds: 1 });

	await openApp(page);
	// Dashboard shows the stats + the recent sessions.
	await expect(page.getByTestId("stat").first()).toContainText("3");
	await expect(page.getByTestId("session-card")).toHaveCount(3);

	await page.getByTestId("nav-sessions").click();
	const cards = page.getByTestId("session-card");
	await expect(cards).toHaveCount(3);
	await expect(page.getByText("3 gravações")).toBeVisible();

	const search = page.getByTestId("sessions-search");
	await search.fill("termodinâmica");
	await expect(cards).toHaveCount(1);
	await expect(cards.first()).toContainText("Aula de Termodinâmica");
	// Transcript text (server-side search) matches every session.
	await search.fill("cronograma de entregas");
	await expect(cards).toHaveCount(3);
	await search.fill("xyzzy-nada");
	await expect(page.getByTestId("sessions-empty")).toContainText("Nada por aqui");
	await page.getByRole("button", { name: "Limpar busca" }).click();
	await expect(cards).toHaveCount(3);

	// Quick menu → Renomear opens the detail with the title in edit mode.
	const podcast = cards.filter({ hasText: "Podcast" });
	await podcast.getByTestId("session-menu-button").click();
	const menu = page.getByTestId("session-menu");
	await expect(menu).toBeVisible();
	await expect(menu.getByRole("menuitem")).toHaveText([
		"Renomear",
		"Transcrever",
		"Analisar",
		"Exportar",
		"Apagar",
	]);
	await page.getByTestId("menu-rename").click();
	const titleInput = page.getByTestId("detail-title-input");
	await expect(titleInput).toBeFocused();
	await titleInput.fill("Podcast · Episódio 42");
	await titleInput.press("Enter");
	await expect(page.getByTestId("detail-title")).toHaveText("Podcast · Episódio 42");

	// Back to the list; the menu closes on outside click.
	await page.getByTestId("detail-back").click();
	await expect(cards.filter({ hasText: "Podcast · Episódio 42" })).toHaveCount(1);
	await cards.first().getByTestId("session-menu-button").click();
	await expect(menu).toBeVisible();
	await page.getByRole("heading", { name: "Sessões" }).click();
	await expect(menu).toBeHidden();

	// Delete via the confirmation modal (cancel first, then confirm).
	const reuniao = cards.filter({ hasText: "Reunião de planejamento" });
	await reuniao.getByTestId("session-menu-button").click();
	await page.getByTestId("menu-delete").click();
	const modal = page.getByTestId("delete-modal");
	await expect(modal).toContainText("Reunião de planejamento Q3");
	await page.getByTestId("delete-cancel").click();
	await expect(modal).toBeHidden();
	await expect(cards).toHaveCount(3);

	await reuniao.getByTestId("session-menu-button").click();
	await page.getByTestId("menu-delete").click();
	await page.getByTestId("delete-confirm").click();
	await expect(modal).toBeHidden();
	await expect(page.getByTestId("toast")).toHaveText("Sessão apagada");
	await expect(cards).toHaveCount(2);
	await expect(page.getByText("2 gravações")).toBeVisible();

	const remaining = (await api.sessions()).map((s) => s.title).sort();
	expect(remaining).toEqual(["Aula de Termodinâmica — Entropia", "Podcast · Episódio 42"]);
});
