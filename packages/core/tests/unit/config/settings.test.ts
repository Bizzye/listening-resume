import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings, renameWithRetry, SettingsStore } from "../../../src/config/settings.js";
import { ValidationError } from "../../../src/domain/errors.js";
import { makeTempDir } from "../../helpers.js";

describe("SettingsStore", () => {
	let dir: string;
	let cleanup: () => void;
	let file: string;

	beforeEach(() => {
		({ dir, cleanup } = makeTempDir());
		file = path.join(dir, "nested", "settings.json");
	});
	afterEach(() => cleanup());

	it("returns the contract defaults when no file exists", () => {
		const settings = new SettingsStore(file).get();
		expect(settings).toMatchObject({
			onboardingDone: false,
			theme: "dark",
			systemDevice: "@default",
			micDevice: "@default",
			transcriptionProvider: "groq",
			whisperModel: "medium",
			autoTranscribe: true,
			silenceDetection: true,
			analysisModel: "llama3.1:8b",
			analysisLanguage: "pt-BR",
			defaultTemplateId: "resumo-executivo",
			exportFormat: "md",
		});
		expect(settings.exportDir).toMatch(/ListeningResume$/);
		expect(fs.existsSync(file)).toBe(false);
	});

	it("persists partial updates atomically and keeps other fields", () => {
		const store = new SettingsStore(file);
		const updated = store.update({ theme: "light", micDevice: null });
		expect(updated.theme).toBe("light");
		expect(updated.micDevice).toBeNull();
		expect(updated.analysisModel).toBe("llama3.1:8b");

		const again = new SettingsStore(file).update({ onboardingDone: true });
		expect(again).toMatchObject({ theme: "light", micDevice: null, onboardingDone: true });
		expect(JSON.parse(fs.readFileSync(file, "utf-8")).onboardingDone).toBe(true);
		expect(fs.readdirSync(path.dirname(file))).toEqual(["settings.json"]); // no tmp left
	});

	it("rejects invalid values and unknown keys with ValidationError (nothing written)", () => {
		const store = new SettingsStore(file);
		expect(() => store.update({ theme: "neon" as "dark" })).toThrow(ValidationError);
		expect(() => store.update({ exportFormat: "odt" as "md" })).toThrow(/exportFormat/);
		expect(() => store.update({ bogus: 1 } as never)).toThrow(ValidationError);
		expect(() => store.update({ systemDevice: "" })).toThrow(ValidationError);
		expect(fs.existsSync(file)).toBe(false);
	});

	it("survives a corrupt file and keeps valid fields of a partially bad one", () => {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "{not json");
		expect(new SettingsStore(file).get()).toEqual(defaultSettings());

		fs.writeFileSync(
			file,
			JSON.stringify({ theme: "light", whisperModel: "huge", analysisLanguage: "en", extra: 1 }),
		);
		const settings = new SettingsStore(file).get();
		expect(settings.theme).toBe("light");
		expect(settings.analysisLanguage).toBe("en");
		expect(settings.whisperModel).toBe("medium");
		expect(settings).not.toHaveProperty("extra");
	});

	it("get() returns copies", () => {
		const store = new SettingsStore(file);
		const s = store.get();
		s.theme = "light";
		expect(store.get().theme).toBe("dark");
		expect(store.path).toBe(file);
	});
});

describe("SettingsStore persistence details", () => {
	let dir: string;
	let cleanup: () => void;
	beforeEach(() => {
		({ dir, cleanup } = makeTempDir());
	});
	afterEach(() => cleanup());

	it("getExplicit returns only stored, valid values", () => {
		const file = path.join(dir, "settings.json");
		const store = new SettingsStore(file);
		expect(store.getExplicit()).toEqual({});
		fs.writeFileSync(file, JSON.stringify({ micDevice: null, theme: "neon", analysisModel: "x" }));
		expect(new SettingsStore(file).getExplicit()).toEqual({ micDevice: null, analysisModel: "x" });
	});

	it("renameWithRetry retries transient lock errors and gives up on others", () => {
		const locked = (code: string) => Object.assign(new Error(code), { code });
		const flaky = vi
			.fn()
			.mockImplementationOnce(() => {
				throw locked("EPERM");
			})
			.mockImplementationOnce(() => {
				throw locked("EBUSY");
			})
			.mockImplementationOnce(() => {});
		renameWithRetry("a", "b", flaky);
		expect(flaky).toHaveBeenCalledTimes(3);

		const fatal = vi.fn(() => {
			throw locked("ENOSPC");
		});
		expect(() => renameWithRetry("a", "b", fatal)).toThrow("ENOSPC");
		expect(fatal).toHaveBeenCalledTimes(1);

		const stuck = vi.fn(() => {
			throw locked("EACCES");
		});
		expect(() => renameWithRetry("a", "b", stuck)).toThrow("EACCES");
		expect(stuck).toHaveBeenCalledTimes(5);
	});

	it("removes the temp file when the write fails", () => {
		const file = path.join(dir, "settings.json");
		fs.mkdirSync(file); // a directory where the file should go: rename fails
		const store = new SettingsStore(file);
		expect(() => store.update({ theme: "light" })).toThrow();
		expect(fs.readdirSync(dir)).toEqual(["settings.json"]);
	});
});
