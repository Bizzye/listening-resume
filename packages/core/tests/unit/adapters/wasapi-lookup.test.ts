import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	findWasapiBinary,
	WASAPI_BINARY_ENV,
	WasapiCaptureAdapter,
	wasapiBinaryCandidates,
} from "../../../src/adapters/audio/wasapi-capture.js";

const root = path.resolve("/repo");
const bin = (...parts: string[]) => path.normalize(path.join(...parts, "wasapi-capture.exe"));

function ctx(overrides: Partial<Parameters<typeof wasapiBinaryCandidates>[0]> = {}) {
	return {
		env: {},
		execPath: path.join(root, "nodejs", "node.exe"),
		cwd: path.join(root, "apps", "cli"),
		moduleDir: path.join(root, "packages", "core", "dist"),
		...overrides,
	};
}

describe("wasapi binary lookup", () => {
	it("puts the LR_WASAPI_BIN override first", () => {
		const override = path.join(root, "custom", "capture.exe");
		const list = wasapiBinaryCandidates(ctx({ env: { [WASAPI_BINARY_ENV]: override } }));
		expect(list[0]).toBe(path.normalize(override));
	});

	it("finds the packaged NSIS layout relative to the bundled node", () => {
		const app = path.join(root, "Program", "Listening Resume");
		const execPath = path.join(app, "resources", "bin", "node.exe");
		const expected = bin(app, "binaries");
		expect(findWasapiBinary(ctx({ execPath }), (p) => p === expected)).toBe(expected);
	});

	it.each([
		["repo root", root],
		["apps/gui", path.join(root, "apps", "gui")],
		["apps/cli", path.join(root, "apps", "cli")],
		["packages/core", path.join(root, "packages", "core")],
	])("finds the dev build when cwd is %s", (_label, cwd) => {
		const expected = bin(root, "apps", "gui", "src-tauri", "binaries");
		expect(findWasapiBinary(ctx({ cwd, moduleDir: null }), (p) => p === expected)).toBe(expected);
	});

	it("finds the dev build from the module location (any cwd)", () => {
		const expected = bin(root, "apps", "gui", "src-tauri", "binaries");
		const found = findWasapiBinary(ctx({ cwd: path.resolve("/elsewhere") }), (p) => p === expected);
		expect(found).toBe(expected);
	});

	it("falls back to PATH and returns null when nothing exists", () => {
		const onPath = path.join(root, "tools");
		const expected = bin(onPath);
		expect(findWasapiBinary(ctx({ env: { PATH: onPath } }), (p) => p === expected)).toBe(expected);
		expect(findWasapiBinary(ctx(), () => false)).toBeNull();
	});

	it("candidates are unique", () => {
		const list = wasapiBinaryCandidates(ctx());
		expect(new Set(list).size).toBe(list.length);
	});

	it("adapter reports unavailable and throws a helpful error without a binary", async () => {
		const adapter = new WasapiCaptureAdapter({ findBinary: () => null });
		expect(await adapter.isAvailable()).toBe(false);
		await expect(adapter.listDevices()).rejects.toThrow(/build:wasapi/);
		await expect(adapter.playTestTone("@default")).rejects.toThrow(/wasapi-capture\.exe/);
		await expect(adapter.startMeter({ system: "@default", mic: null })).rejects.toThrow(
			/LR_WASAPI_BIN/,
		);
	});
});
