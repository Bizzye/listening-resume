import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Json, startTestApp, type TestApp } from "./harness.js";

describe("templates", () => {
	let t: TestApp;
	beforeAll(async () => {
		t = await startTestApp();
	});
	afterAll(() => t.close());

	it("lists the 5 built-ins", async () => {
		const { body } = await t.json("/templates");
		const builtins = body.templates.filter((x: Json) => x.builtin);
		expect(builtins.map((x: Json) => x.id)).toEqual([
			"videoaula-extracao",
			"ata-reuniao",
			"resumo-executivo",
			"flashcards-anki",
			"podcast-artigo",
		]);
		expect(builtins[0]).toMatchObject({ language: "pt-BR", sections: expect.any(Number) });
	});

	it("creates, updates and deletes a custom template", async () => {
		const created = await t.json("/templates", {
			method: "POST",
			json: { name: "  Meu template ", description: "Teste", prompt: "Resuma: {transcricao}" },
		});
		expect(created.status).toBe(201);
		const tpl = created.body.template;
		expect(tpl).toMatchObject({ name: "Meu template", description: "Teste", builtin: false });

		const updated = await t.json(`/templates/${tpl.id}`, {
			method: "PUT",
			json: { name: "Renomeado" },
		});
		expect(updated.body.template).toMatchObject({
			id: tpl.id,
			name: "Renomeado",
			prompt: tpl.prompt,
		});

		expect((await t.json("/templates")).body.templates.map((x: Json) => x.id)).toContain(tpl.id);
		expect((await t.json(`/templates/${tpl.id}`, { method: "DELETE" })).body).toEqual({ ok: true });
		expect((await t.json(`/templates/${tpl.id}`, { method: "DELETE" })).status).toBe(404);
		expect(
			(await t.json(`/templates/${tpl.id}`, { method: "PUT", json: { name: "x" } })).status,
		).toBe(404);
	});

	it("validates input and protects built-ins", async () => {
		expect((await t.json("/templates", { method: "POST", json: { name: "x" } })).status).toBe(400);
		expect(
			(await t.json("/templates", { method: "POST", json: { name: "", prompt: "p" } })).status,
		).toBe(400);
		expect(
			(await t.json("/templates", { method: "POST", json: { name: 1, prompt: "p" } })).status,
		).toBe(400);
		expect((await t.json("/templates/ata-reuniao", { method: "DELETE" })).status).toBe(400);
		expect(
			(await t.json("/templates/ata-reuniao", { method: "PUT", json: { name: "x" } })).status,
		).toBe(400);
	});
});
