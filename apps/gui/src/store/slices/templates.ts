import { api, errorMessage } from "../../shared/api/client";
import type { Template, TemplateInput } from "../../shared/api/types";
import type { SliceCreator } from "../types";

export interface TemplatesSlice {
	templates: Template[];
	loadTemplates: () => Promise<void>;
	saveTemplate: (id: string | null, input: TemplateInput) => Promise<boolean>;
	deleteTemplate: (id: string) => Promise<boolean>;
}

export const createTemplatesSlice: SliceCreator<TemplatesSlice> = (set, get) => ({
	templates: [],
	loadTemplates: async () => {
		try {
			const { templates } = await api.templates();
			set({ templates });
		} catch {
			// non-critical; the analysis select falls back to the default id
		}
	},
	saveTemplate: async (id, input) => {
		try {
			const { template } = id
				? await api.updateTemplate(id, input)
				: await api.createTemplate(input);
			set((s) => ({
				templates: id
					? s.templates.map((t) => (t.id === id ? template : t))
					: [...s.templates, template],
			}));
			get().pop("Template salvo");
			return true;
		} catch (err) {
			get().pop(`Não foi possível salvar o template: ${errorMessage(err)}`, "err");
			return false;
		}
	},
	deleteTemplate: async (id) => {
		try {
			await api.deleteTemplate(id);
			set((s) => ({ templates: s.templates.filter((t) => t.id !== id) }));
			get().pop("Template apagado", "err");
			return true;
		} catch (err) {
			get().pop(`Não foi possível apagar o template: ${errorMessage(err)}`, "err");
			return false;
		}
	},
});
