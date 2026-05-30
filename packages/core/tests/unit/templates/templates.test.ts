import { describe, it, expect } from "vitest";
import { getTemplate, listTemplates } from "../../../src/templates/index.js";

describe("Templates", () => {
  it("lists built-in templates", () => {
    const templates = listTemplates();
    expect(templates.length).toBeGreaterThanOrEqual(2);
    expect(templates.map((t) => t.id)).toContain("meeting-summary");
    expect(templates.map((t) => t.id)).toContain("action-items");
  });

  it("gets template by id", () => {
    const template = getTemplate("meeting-summary");
    expect(template).toBeDefined();
    expect(template!.name).toBe("Meeting Summary");
    expect(template!.systemPrompt).toContain("summarizer");
    expect(template!.userPromptTemplate).toContain("{{transcript}}");
  });

  it("returns undefined for unknown template", () => {
    const template = getTemplate("nonexistent");
    expect(template).toBeUndefined();
  });
});
