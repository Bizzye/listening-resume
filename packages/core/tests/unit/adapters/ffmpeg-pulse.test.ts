import { describe, expect, it } from "vitest";
import { buildPulseArgs, toPulseSource } from "../../../src/adapters/audio/ffmpeg-pulse.js";
import type { CaptureOptions } from "../../../src/ports/audio-capture.js";

const opts: CaptureOptions = {
	devices: { system: "@default", mic: null },
	micVolume: 1.2,
	sampleRate: 16000,
	channels: 1,
	chunkSeconds: 60,
	outputDir: "/tmp/out",
	filenamePrefix: "chunk",
};
const unmuted = { system: false, mic: false };

describe("FFmpegPulseAdapter args", () => {
	it("maps @default to pulse's default aliases", () => {
		expect(toPulseSource("system", "@default")).toBe("@DEFAULT_MONITOR@");
		expect(toPulseSource("mic", "@default")).toBe("@DEFAULT_SOURCE@");
		expect(toPulseSource("system", "alsa_output.x.monitor")).toBe("alsa_output.x.monitor");
	});

	it("records the system monitor alone at the configured output format", () => {
		const args = buildPulseArgs(opts, "/tmp/out/chunk_0000.wav", unmuted);
		expect(args).toContain("@DEFAULT_MONITOR@");
		expect(args).not.toContain("-filter_complex");
		expect(args.join(" ")).toContain("-ac 1 -ar 16000 -t 60 -y /tmp/out/chunk_0000.wav");
	});

	it("mixes the mic with a limiter, honoring mute volumes", () => {
		const withMic = { ...opts, devices: { system: "spk.monitor", mic: "@default" } };
		const args = buildPulseArgs(withMic, "c.wav", { system: true, mic: false });
		const filter = args[args.indexOf("-filter_complex") + 1];
		expect(args).toContain("@DEFAULT_SOURCE@");
		expect(filter).toContain("volume=0[sys]");
		expect(filter).toContain("volume=1.2[mic]");
		expect(filter).toContain("alimiter");
		expect(args).toContain("[mixed]");

		const micMuted = buildPulseArgs(withMic, "c.wav", { system: false, mic: true });
		expect(micMuted[micMuted.indexOf("-filter_complex") + 1]).toContain("volume=0[mic]");
	});

	it("silences a muted system source without a mic", () => {
		const args = buildPulseArgs(opts, "c.wav", { system: true, mic: false });
		expect(args[args.indexOf("-af") + 1]).toBe("volume=0");
	});
});
