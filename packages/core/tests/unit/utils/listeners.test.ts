import { afterEach, describe, expect, it, vi } from "vitest";
import { Listeners } from "../../../src/utils/listeners.js";
import { logger } from "../../../src/utils/logger.js";

describe("Listeners", () => {
	afterEach(() => vi.restoreAllMocks());

	it("emits to every subscriber until it unsubscribes", () => {
		const listeners = new Listeners<number>();
		const a = vi.fn();
		const b = vi.fn();
		const offA = listeners.on(a);
		listeners.on(b);
		listeners.emit(1);
		offA();
		listeners.emit(2);
		expect(a.mock.calls).toEqual([[1]]);
		expect(b.mock.calls).toEqual([[1], [2]]);
		expect(listeners.size).toBe(1);
	});

	it("isolates a throwing subscriber and logs it at warn", () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const listeners = new Listeners<string>();
		const after = vi.fn();
		listeners.on(() => {
			throw new Error("boom");
		});
		listeners.on(after);
		expect(() => listeners.emit("x")).not.toThrow();
		expect(after).toHaveBeenCalledWith("x");
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("boom"));
	});
});
