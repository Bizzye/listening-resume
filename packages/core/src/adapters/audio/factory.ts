import type { AudioCapturePort, CaptureBackend } from "../../ports/audio-capture.js";
import { FakeCaptureAdapter } from "./fake-capture.js";
import { FFmpegPulseAdapter } from "./ffmpeg-pulse.js";
import { WasapiCaptureAdapter } from "./wasapi-capture.js";

export function defaultCaptureBackend(): CaptureBackend {
	return process.platform === "win32" ? "wasapi" : "pulse";
}

export function createCaptureAdapter(
	backend: CaptureBackend = defaultCaptureBackend(),
): AudioCapturePort {
	switch (backend) {
		case "wasapi":
			return new WasapiCaptureAdapter();
		case "pulse":
			return new FFmpegPulseAdapter();
		case "fake":
			return new FakeCaptureAdapter();
	}
}
