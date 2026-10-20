import type { NewTemplate } from "@listening-resume/core";
import type { AppContext } from "../context.js";
import { badRequest, readJson } from "../http.js";
import { type Router, reply } from "../router.js";

/**
 * Shape-check a template body; content rules (trim, lengths, built-ins read-only) are enforced
 * by the core repository, whose ValidationError/NotFoundError map to 400/404.
 */
export function parseTemplateBody(
	body: Record<string, unknown>,
	partial: boolean,
): Partial<NewTemplate> {
	const out: Partial<NewTemplate> = {};
	for (const key of ["name", "description", "prompt"] as const) {
		const v = body[key];
		if (v === undefined || v === null) {
			if (!partial && key !== "description") throw badRequest(`Campo obrigatório: ${key}`);
			continue;
		}
		if (typeof v !== "string") throw badRequest(`${key} deve ser texto`);
		out[key] = v;
	}
	return out;
}

export function registerTemplateRoutes(router: Router, { deps }: AppContext): void {
	const { repo } = deps;

	router.get("/templates", () => ({ templates: repo.listTemplates() }));

	router.post("/templates", async ({ req }) => {
		const data = parseTemplateBody(await readJson(req), false) as NewTemplate;
		return reply(201, { template: repo.createTemplate(data) });
	});

	router.put("/templates/:id", async ({ req, params }) => {
		const data = parseTemplateBody(await readJson(req), true);
		return { template: repo.updateTemplate(params.id as string, data) };
	});

	router.delete("/templates/:id", ({ params }) => {
		repo.deleteTemplate(params.id as string);
		return { ok: true };
	});
}
