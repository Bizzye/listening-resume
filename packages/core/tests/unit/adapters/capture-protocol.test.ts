import { describe, expect, it } from "vitest";
import {
	assertDeviceId,
	buildCaptureArgs,
	buildMeterArgs,
	buildToneArgs,
	LineSplitter,
	MAX_DEVICE_ID_LENGTH,
	muteCommand,
	parseCaptureLine,
	switchCommand,
} from "../../../src/adapters/audio/capture-protocol.js";
import {
	acknowledgedSources,
	deviceEventMatches,
} from "../../../src/adapters/audio/wasapi-capture.js";
import { ValidationError } from "../../../src/domain/errors.js";
import type { CaptureOptions } from "../../../src/ports/audio-capture.js";

describe("parseCaptureLine", () => {
	it("parses CHUNK lines (Windows paths, CRLF)", () => {
		expect(parseCaptureLine("CHUNK:C:\\data\\sessions\\x\\audio\\chunk_0000.wav\r")).toEqual({
			type: "chunk",
			path: "C:\\data\\sessions\\x\\audio\\chunk_0000.wav",
		});
		expect(parseCaptureLine("CHUNK:")).toBeNull();
	});

	it("parses LEVEL lines and clamps to 0..1", () => {
		expect(parseCaptureLine("LEVEL:0.1235,1.0000")).toEqual({
			type: "level",
			system: 0.1235,
			mic: 1,
		});
		expect(parseCaptureLine("LEVEL:1.7,-0.2")).toEqual({ type: "level", system: 1, mic: 0 });
		expect(parseCaptureLine("LEVEL:NaN,abc")).toEqual({ type: "level", system: 0, mic: 0 });
		expect(parseCaptureLine("LEVEL:0.5")).toEqual({ type: "level", system: 0.5, mic: 0 });
	});

	it("parses legacy 2-field DEVICE lines with and without mic (changed unknown)", () => {
		expect(parseCaptureLine("DEVICE:Alto-falantes (Realtek(R) Audio)|Microfone (USB)")).toEqual({
			type: "device",
			systemName: "Alto-falantes (Realtek(R) Audio)",
			micName: "Microfone (USB)",
			changed: null,
		});
		expect(parseCaptureLine("DEVICE:Speakers|")).toEqual({
			type: "device",
			systemName: "Speakers",
			micName: null,
			changed: null,
		});
		expect(parseCaptureLine("DEVICE:|")).toEqual({
			type: "device",
			systemName: null,
			micName: null,
			changed: null,
		});
		expect(parseCaptureLine("DEVICE:Speakers")).toEqual({
			type: "device",
			systemName: "Speakers",
			micName: null,
			changed: null,
		});
	});

	it("parses the changed-source tag of 3-field DEVICE lines", () => {
		expect(parseCaptureLine("DEVICE:Speakers|Mic|sys")).toEqual({
			type: "device",
			systemName: "Speakers",
			micName: "Mic",
			changed: "system",
		});
		expect(parseCaptureLine("DEVICE:Speakers||mic")).toMatchObject({
			micName: null,
			changed: "mic",
		});
		expect(parseCaptureLine("DEVICE:Speakers|Mic|both\r")).toMatchObject({
			micName: "Mic",
			changed: "both",
		});
		expect(parseCaptureLine("DEVICE:||")).toEqual({
			type: "device",
			systemName: null,
			micName: null,
			changed: null,
		});
	});

	it("keeps a '|' inside the mic name and ignores an unknown trailing field", () => {
		expect(parseCaptureLine("DEVICE:Speakers|Mic A|B|mic")).toMatchObject({
			micName: "Mic A|B",
			changed: "mic",
		});
		// Not a tag: part of the (legacy) mic name.
		expect(parseCaptureLine("DEVICE:Speakers|Mic A|B")).toMatchObject({
			micName: "Mic A|B",
			changed: null,
		});
		expect(parseCaptureLine("DEVICE:Speakers|Mic|toString")).toMatchObject({
			micName: "Mic|toString",
			changed: null,
		});
	});

	it("parses WARN and DEVICES lines", () => {
		expect(parseCaptureLine("WARN:mic not found, using default")).toEqual({
			type: "warn",
			message: "mic not found, using default",
		});
		const devices = [
			{ id: "Spk", name: "Spk (Loopback)", isMonitor: true, isDefault: true, type: "monitor" },
		];
		expect(parseCaptureLine(`DEVICES:${JSON.stringify(devices)}`)).toEqual({
			type: "devices",
			devices,
		});
		expect(parseCaptureLine("DEVICES:{broken")).toBeNull();
		expect(parseCaptureLine('DEVICES:{"not":"array"}')).toBeNull();
	});

	it("ignores blank, unknown and untagged lines", () => {
		for (const line of ["", "   ", "hello", "INFO:x", ":x", "chunk:lowercase"]) {
			expect(parseCaptureLine(line)).toBeNull();
		}
	});
});

describe("LineSplitter", () => {
	it("buffers partial lines across data events", () => {
		const s = new LineSplitter();
		expect(s.push("LEVEL:0.1,0.2\nCHU")).toEqual(["LEVEL:0.1,0.2"]);
		expect(s.push("NK:a.wav\nDEV")).toEqual(["CHUNK:a.wav"]);
		expect(s.flush()).toEqual(["DEV"]);
		expect(s.flush()).toEqual([]);
	});
});

const options: CaptureOptions = {
	devices: { system: "@default", mic: "Microfone (USB)" },
	micVolume: 1.5,
	sampleRate: 16000,
	channels: 1,
	chunkSeconds: 120,
	outputDir: "C:\\out dir",
	filenamePrefix: "chunk",
};

describe("binary args", () => {
	it("buildCaptureArgs maps every option (values kept as single argv entries)", () => {
		expect(buildCaptureArgs(options)).toEqual([
			"--output-dir",
			"C:\\out dir",
			"--prefix",
			"chunk",
			"--chunk-seconds",
			"120",
			"--sample-rate",
			"16000",
			"--channels",
			"1",
			"--device",
			"@default",
			"--mic",
			"Microfone (USB)",
			"--mic-volume",
			"1.5",
		]);
	});

	it("always passes the mic volume (a mic added live later uses it) and defaults it", () => {
		const noMic = buildCaptureArgs({ ...options, devices: { system: "Spk", mic: null } });
		expect(noMic).not.toContain("--mic");
		expect(noMic.slice(-4)).toEqual(["--device", "Spk", "--mic-volume", "1.5"]);

		const defaultVol = buildCaptureArgs({ ...options, micVolume: undefined });
		expect(defaultVol.slice(-2)).toEqual(["--mic-volume", "1.2"]);
		const noMicDefault = buildCaptureArgs({
			...options,
			devices: { system: "Spk", mic: null },
			micVolume: undefined,
		});
		expect(noMicDefault.slice(-2)).toEqual(["--mic-volume", "1.2"]);
	});

	it("buildMeterArgs writes no files", () => {
		expect(buildMeterArgs({ system: "@default", mic: "@default" })).toEqual([
			"--meter-only",
			"--device",
			"@default",
			"--mic",
			"@default",
		]);
		expect(buildMeterArgs({ system: "Spk", mic: null })).toEqual([
			"--meter-only",
			"--device",
			"Spk",
		]);
	});

	it("buildToneArgs strips the legacy (Loopback) suffix", () => {
		expect(buildToneArgs("Speakers (Realtek) (Loopback)")).toEqual([
			"--play-tone",
			"--device",
			"Speakers (Realtek)",
		]);
		expect(buildToneArgs("@default")).toEqual(["--play-tone", "--device", "@default"]);
		expect(buildToneArgs("")).toEqual(["--play-tone"]);
	});
});

describe("stdin commands", () => {
	it("mute commands", () => {
		expect(muteCommand("system", true)).toBe("mute-sys");
		expect(muteCommand("system", false)).toBe("unmute-sys");
		expect(muteCommand("mic", true)).toBe("mute-mic");
		expect(muteCommand("mic", false)).toBe("unmute-mic");
	});

	it("switch commands", () => {
		expect(switchCommand("system", "Fones (WH-1000XM4)")).toBe("set-sys Fones (WH-1000XM4)");
		expect(switchCommand("system", "@default")).toBe("set-sys @default");
		expect(switchCommand("mic", null)).toBe("set-mic none");
		expect(switchCommand("mic", "@default")).toBe("set-mic @default");
	});
});

describe("device id validation", () => {
	it("rejects control characters (stdin command injection) everywhere a device id is sent", () => {
		expect(assertDeviceId("Fones (USB)")).toBe("Fones (USB)");
		expect(assertDeviceId("Microfone (Intel® Smart Sound) — ção")).toBe(
			"Microfone (Intel® Smart Sound) — ção",
		);
		for (const bad of [
			"Mic\nq",
			"Mic\r\nmute-sys",
			"\n",
			"a\u0000b",
			"x\u001f",
			"del\u007f",
			"t\tab",
		]) {
			expect(() => assertDeviceId(bad)).toThrow(ValidationError);
			expect(() => assertDeviceId(bad)).toThrow("Nome de dispositivo contém caracteres inválidos");
			expect(() => switchCommand("mic", bad)).toThrow(ValidationError);
			expect(() => buildMeterArgs({ system: bad, mic: null })).toThrow(ValidationError);
			expect(() => buildToneArgs(bad)).toThrow(ValidationError);
			expect(() => buildCaptureArgs({ ...options, devices: { system: "Spk", mic: bad } })).toThrow(
				ValidationError,
			);
		}
	});

	it("rejects ids longer than 512 characters", () => {
		expect(MAX_DEVICE_ID_LENGTH).toBe(512);
		expect(assertDeviceId("a".repeat(512))).toHaveLength(512);
		expect(() => assertDeviceId("a".repeat(513))).toThrow("Nome de dispositivo muito longo");
	});

	it("names the field in the message when given", () => {
		expect(() => assertDeviceId("a\nb", "micDevice")).toThrow(
			"micDevice contém caracteres inválidos",
		);
		expect(() => assertDeviceId("a".repeat(600), "device")).toThrow("device muito longo");
	});
});

describe("LineSplitter UTF-8", () => {
	it("keeps multi-byte characters split across chunks intact", () => {
		const bytes = Buffer.from("DEVICE:Microfone (Áudio)|Fone ção\n", "utf8");
		const at = bytes.indexOf(Buffer.from("Á", "utf8")) + 1; // split inside "Á"
		const splitter = new LineSplitter();
		expect(splitter.push(bytes.subarray(0, at))).toEqual([]);
		expect(splitter.push(bytes.subarray(at))).toEqual(["DEVICE:Microfone (Áudio)|Fone ção"]);
	});
});

describe("deviceEventMatches", () => {
	const event = (systemName: string | null, micName: string | null) => ({ systemName, micName });

	it("matches explicit names (case-insensitive), null mic and @default", () => {
		expect(deviceEventMatches({ system: "Fones" }, event("fones", "Mic"))).toBe(true);
		expect(deviceEventMatches({ system: "Fones" }, event("Speakers", "Mic"))).toBe(false);
		expect(deviceEventMatches({ mic: null }, event("Speakers", null))).toBe(true);
		expect(deviceEventMatches({ mic: null }, event("Speakers", "Mic"))).toBe(false);
		expect(deviceEventMatches({ system: "@default" }, event("Speakers", null))).toBe(true);
		expect(deviceEventMatches({ system: "@default" }, event(null, null))).toBe(false);
	});

	it("requires every requested source in the same event", () => {
		const both = { system: "Fones", mic: null };
		expect(deviceEventMatches(both, event("Fones", "Mic"))).toBe(false); // mic not removed yet
		expect(deviceEventMatches(both, event("Fones", null))).toBe(true);
		expect(deviceEventMatches({}, event(null, null))).toBe(true);
	});
});

describe("acknowledgedSources", () => {
	const ev = (
		systemName: string | null,
		micName: string | null,
		changed: "system" | "mic" | "both" | null,
	) => ({ devices: { systemName, micName }, changed });

	it("only lets an event about the switched source acknowledge it", () => {
		// The mic reopening (e.g. on a new default) must not satisfy a pending system switch.
		expect(acknowledgedSources({ system: "@default" }, ev("Old", "Mic", "mic"), false)).toEqual([]);
		expect(acknowledgedSources({ system: "@default" }, ev("Spk", "Mic", "system"), false)).toEqual([
			"system",
		]);
		expect(acknowledgedSources({ mic: null }, ev("Spk", null, "mic"), false)).toEqual(["mic"]);
		expect(acknowledgedSources({ mic: null }, ev("Spk", "Mic", "mic"), false)).toEqual([]);
	});

	it("requires the requested name unless a warning (fallback) came first", () => {
		const requested = { system: "Fones" };
		expect(acknowledgedSources(requested, ev("Spk", null, "system"), false)).toEqual([]);
		expect(acknowledgedSources(requested, ev("fones", null, "system"), false)).toEqual(["system"]);
		expect(acknowledgedSources(requested, ev("Spk", null, "system"), true)).toEqual(["system"]);
		// A warning never lets the other source's event through.
		expect(acknowledgedSources(requested, ev("Spk", "Mic", "mic"), true)).toEqual([]);
	});

	it("treats `both` and legacy untagged events as about every source", () => {
		const both = { system: "Fones", mic: "Mic" };
		expect(acknowledgedSources(both, ev("Fones", "Mic", "both"), false)).toEqual(["system", "mic"]);
		expect(acknowledgedSources(both, ev("Fones", "Other", null), false)).toEqual(["system"]);
		expect(acknowledgedSources({}, ev("Fones", "Mic", null), false)).toEqual([]);
	});
});
