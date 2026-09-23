import type { AnalysisTemplate } from "../ports/analyzer.js";
import { actionItemsTemplate } from "./action-items.js";
import { meetingSummaryTemplate } from "./meeting-summary.js";
import { videoaulaInsanaTemplate } from "./videoaula-insana.js";

/** Builtin templates used for seeding the database */
export const builtinTemplates: AnalysisTemplate[] = [
	meetingSummaryTemplate,
	actionItemsTemplate,
	videoaulaInsanaTemplate,
];

/**
 * @deprecated Use repo.getTemplate() instead — templates are now stored in the database.
 * Kept for backwards compatibility during transition.
 */
export function getTemplate(id: string): AnalysisTemplate | undefined {
	return builtinTemplates.find((t) => t.id === id);
}

/**
 * @deprecated Use repo.listTemplates() instead — templates are now stored in the database.
 * Kept for backwards compatibility during transition.
 */
export function listTemplates(): AnalysisTemplate[] {
	return builtinTemplates;
}
