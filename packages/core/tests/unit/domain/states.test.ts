import { describe, expect, it } from "vitest";
import { ConflictError } from "../../../src/domain/errors.js";
import {
	assertTransition,
	canTransition,
	SESSION_STATUS_LABELS,
	TRANSIENT_STATUSES,
} from "../../../src/domain/states.js";

describe("Session state machine", () => {
	it("allows the happy path", () => {
		expect(canTransition("created", "recording")).toBe(true);
		expect(canTransition("recording", "stopped")).toBe(true);
		expect(canTransition("stopped", "transcribing")).toBe(true);
		expect(canTransition("transcribing", "transcribed")).toBe(true);
		expect(canTransition("transcribed", "analyzing")).toBe(true);
		expect(canTransition("analyzing", "completed")).toBe(true);
	});

	it("allows re-analysis, re-transcription and retry after failure", () => {
		expect(canTransition("completed", "analyzing")).toBe(true);
		expect(canTransition("completed", "transcribing")).toBe(true);
		expect(canTransition("failed", "transcribing")).toBe(true);
		expect(canTransition("analyzing", "transcribed")).toBe(true);
	});

	it("allows an import to settle straight from created to stopped", () => {
		expect(canTransition("created", "stopped")).toBe(true);
		expect(() => assertTransition("created", "stopped")).not.toThrow();
		expect(canTransition("created", "transcribing")).toBe(false);
	});

	it("rejects invalid transitions", () => {
		expect(canTransition("created", "completed")).toBe(false);
		expect(canTransition("completed", "recording")).toBe(false);
		expect(canTransition("failed", "recording")).toBe(false);
		expect(canTransition("recording", "analyzing")).toBe(false);
		expect(() => assertTransition("created", "recording")).not.toThrow();
	});

	it("assertTransition throws a pt-BR ConflictError (409)", () => {
		expect(() => assertTransition("transcribing", "transcribing")).toThrow(ConflictError);
		expect(() => assertTransition("transcribing", "transcribing")).toThrow(/já está em andamento/);
		expect(() => assertTransition("analyzing", "analyzing")).toThrow(/análise/);
		expect(() => assertTransition("recording", "transcribing")).toThrow(/sendo gravada/);
		expect(() => assertTransition("stopped", "completed")).toThrow(
			"Transição de estado inválida: Gravado → Concluído.",
		);
	});

	it("labels every status in pt-BR", () => {
		expect(SESSION_STATUS_LABELS.completed).toBe("Concluído");
		expect(SESSION_STATUS_LABELS.transcribing).toBe("Transcrevendo…");
	});

	it("lists the transient states", () => {
		expect([...TRANSIENT_STATUSES]).toEqual(["recording", "transcribing", "analyzing"]);
	});
});
