import { describe, expect, it } from "vitest";
import { Router } from "../../../server/router.js";

describe("Router", () => {
	const h = (name: string) => () => name;
	const router = new Router()
		.get("/sessions", h("list"))
		.post("/sessions/import", h("import"))
		.get("/sessions/:id", h("detail"))
		.get("/sessions/:id/audio", h("audio"))
		.delete("/analyses/:id", h("deleteAnalysis"));

	it("matches static routes", () => {
		const m = router.match("GET", "/sessions");
		expect(m).not.toBeNull();
		expect(typeof m === "object" && m?.handler({} as never)).toBe("list");
	});

	it("captures and decodes params", () => {
		const m = router.match("GET", "/sessions/ab%20c/audio");
		expect(m && typeof m === "object" ? m.params : null).toEqual({ id: "ab c" });
	});

	it("tolerates trailing slashes", () => {
		const m = router.match("GET", "/sessions/123/");
		expect(m && typeof m === "object" ? m.handler({} as never) : null).toBe("detail");
	});

	it("prefers the first registered match (static before param)", () => {
		const m = router.match("POST", "/sessions/import");
		expect(m && typeof m === "object" ? m.handler({} as never) : null).toBe("import");
	});

	it("reports method-not-allowed when the path exists under another method", () => {
		expect(router.match("PUT", "/sessions")).toBe("method-not-allowed");
	});

	it("maps HEAD onto GET routes", () => {
		const m = router.match("HEAD", "/sessions/1/audio");
		expect(m && typeof m === "object" ? m.handler({} as never) : null).toBe("audio");
	});

	it("returns null for unknown paths and malformed escapes", () => {
		expect(router.match("GET", "/nope")).toBeNull();
		expect(router.match("GET", "/sessions/1/audio/extra")).toBeNull();
		expect(router.match("GET", "/sessions/%E0%A4%A")).toBeNull();
	});
});
