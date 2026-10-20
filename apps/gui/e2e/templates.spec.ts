import { expect, openApp, test } from "./support/fixtures";

test("templates: built-ins are read-only; custom template create → edit → delete", async ({
	page,
	api,
}) => {
	await openApp(page);
	await page.getByTestId("nav-templates").click();
	const cards = page.getByTestId("template-card");
	await expect(cards).toHaveCount(5);
	for (const name of [
		"Videoaula — Extração Total",
		"Ata de Reunião",
		"Resumo Executivo",
		"Flashcards (Anki)",
	]) {
		await expect(cards.filter({ hasText: name })).toHaveCount(1);
	}

	// Built-ins are read-only: no delete, and saving creates an editable copy.
	await cards.filter({ hasText: "Resumo Executivo" }).first().click();
	const modal = page.getByTestId("template-modal");
	await expect(modal.getByRole("heading")).toHaveText("Editar template");
	await expect(page.getByTestId("template-copy-hint")).toBeVisible();
	await expect(page.getByTestId("template-delete-button")).toHaveCount(0);
	await expect(page.getByTestId("template-name-input")).toHaveValue("Resumo Executivo (cópia)");
	await expect(page.getByTestId("template-prompt-input")).not.toBeEmpty();
	await page.keyboard.press("Escape");
	await expect(modal).toBeHidden();
	await expect(cards).toHaveCount(5);

	await cards.filter({ hasText: "Resumo Executivo" }).first().click();
	await page.getByTestId("template-save-button").click();
	await expect(modal).toBeHidden();
	const copy = cards.filter({ hasText: "Resumo Executivo (cópia)" });
	await expect(copy).toHaveCount(1);
	await expect(copy).toContainText("custom");
	await expect(cards).toHaveCount(6);
	await copy.click();
	await expect(page.getByTestId("template-delete-button")).toBeVisible();
	await page.getByTestId("template-delete-button").click();
	await expect(cards).toHaveCount(5);

	// Create.
	await page.getByTestId("new-template-button").click();
	await expect(modal.getByRole("heading")).toHaveText("Novo template");
	await page.getByTestId("template-save-button").click();
	await expect(page.getByTestId("toast")).toHaveText("Preencha o nome e o prompt");
	await page.getByTestId("template-name-input").fill("Retro da sprint");
	await page.getByTestId("template-desc-input").fill("O que foi bem, o que melhorar e ações.");
	await page
		.getByTestId("template-prompt-input")
		.fill("Resuma a retrospectiva {titulo}.\n\n## Foi bem\n## Melhorar\n## Ações\n\n{transcricao}");
	await page.getByTestId("template-save-button").click();
	await expect(modal).toBeHidden();
	await expect(page.getByTestId("toast")).toHaveText("Template salvo");
	const custom = cards.filter({ hasText: "Retro da sprint" });
	await expect(custom).toHaveCount(1);
	await expect(custom).toContainText("custom");
	await expect(custom).toContainText("3 seções");

	// Edit.
	await custom.click();
	await expect(modal.getByRole("heading")).toHaveText("Editar template");
	await expect(page.getByTestId("template-name-input")).toHaveValue("Retro da sprint");
	await page.getByTestId("template-name-input").fill("Retrospectiva da sprint");
	await page.getByTestId("template-save-button").click();
	await expect(modal).toBeHidden();
	await expect(cards.filter({ hasText: "Retrospectiva da sprint" })).toHaveCount(1);
	const { templates } = await api.get<{ templates: { name: string; builtin: boolean }[] }>(
		"/templates",
	);
	expect(templates.filter((t) => !t.builtin).map((t) => t.name)).toEqual([
		"Retrospectiva da sprint",
	]);

	// Delete.
	await cards.filter({ hasText: "Retrospectiva da sprint" }).click();
	await page.getByTestId("template-delete-button").click();
	await expect(modal).toBeHidden();
	await expect(page.getByTestId("toast")).toHaveText("Template apagado");
	await expect(cards).toHaveCount(5);
});
