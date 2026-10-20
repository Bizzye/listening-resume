import { describe, expect, it } from "vitest";
import {
	DEVICE_FALLBACK_MESSAGE,
	describeCaptureWarning,
} from "../../../src/application/error-messages.js";

describe("describeCaptureWarning", () => {
	it("maps a named-device fallback (missing or lost) to the pt-BR fallback message", () => {
		for (const raw of [
			"could not open system audio 'Fones (JBL)' (not found); falling back to the system default",
			"microphone 'USB Mic' was lost (0x88890004); Falling back to the system default",
		]) {
			expect(describeCaptureWarning(raw)).toEqual({
				message: DEVICE_FALLBACK_MESSAGE,
				fallback: true,
			});
		}
		expect(DEVICE_FALLBACK_MESSAGE).toBe("Dispositivo indisponível — usando o padrão do sistema");
	});

	it("passes the clock-resync warning (already pt-BR) through", () => {
		expect(describeCaptureWarning(" relógio saltou 3600s (suspensão?) — sincronizado ")).toEqual({
			message: "relógio saltou 3600s (suspensão?) — sincronizado",
			fallback: false,
		});
	});

	it("prefixes any other warning", () => {
		expect(describeCaptureWarning("microphone: COM init failed (x)")).toEqual({
			message: "Aviso da captura de áudio: microphone: COM init failed (x)",
			fallback: false,
		});
	});
});
