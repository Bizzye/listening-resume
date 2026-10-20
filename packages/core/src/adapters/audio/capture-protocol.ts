import { StringDecoder } from "node:string_decoder";
import { DEFAULT_MIC_VOLUME } from "../../constants.js";
import { ValidationError } from "../../domain/errors.js";
import type {
	AudioDevice,
	CaptureDevices,
	CaptureOptions,
	CaptureSource,
} from "../../ports/audio-capture.js";

/**
 * Line protocol of the native `wasapi-capture` binary (see CONTRACT §2):
 *
 *   stdout: `CHUNK:<path>` · `LEVEL:<sys>,<mic>` · `DEVICE:<sys>|<mic>|<changed>` · `WARN:<msg>` ·
 *           `DEVICES:<json>`
 *   stdin:  `q` · `mute-sys` · `unmute-sys` · `mute-mic` · `unmute-mic` · `set-sys <dev>` · `set-mic <dev|none>`
 *
 * `<changed>` names the source whose (re)open/loss produced the `DEVICE:` line: `sys`, `mic`,
 * `both` (the startup snapshot) or empty (unspecified). Older binaries emit only
 * `DEVICE:<sys>|<mic>` — parsed with `changed: null`.
 */
export type DeviceChange = CaptureSource | "both";

export type CaptureEvent =
	| { type: "chunk"; path: string }
	| { type: "level"; system: number; mic: number }
	| {
			type: "device";
			systemName: string | null;
			micName: string | null;
			/** Source that changed; `null` = unknown (legacy 2-field line / empty tag). */
			changed: DeviceChange | null;
	  }
	| { type: "warn"; message: string }
	| { type: "devices"; devices: AudioDevice[] };

const clampLevel = (raw: string | undefined): number => {
	const v = Number.parseFloat(raw ?? "");
	return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
};

const nameOrNull = (raw: string | undefined): string | null => {
	const v = raw?.trim();
	return v ? v : null;
};

const CHANGED_TAGS: Record<string, DeviceChange | null> = {
	sys: "system",
	mic: "mic",
	both: "both",
	"": null,
};

/** Parses one stdout line. Returns `null` for blank/unknown lines. Pure. */
export function parseCaptureLine(line: string): CaptureEvent | null {
	const text = line.replace(/\r$/, "");
	const colon = text.indexOf(":");
	if (colon <= 0) return null;
	const tag = text.slice(0, colon);
	const payload = text.slice(colon + 1);

	switch (tag) {
		case "CHUNK": {
			const path = payload.trim();
			return path ? { type: "chunk", path } : null;
		}
		case "LEVEL": {
			const [sys, mic] = payload.split(",");
			return { type: "level", system: clampLevel(sys), mic: clampLevel(mic) };
		}
		case "DEVICE": {
			const fields = payload.split("|");
			const last = fields.length >= 3 ? fields.at(-1)?.trim() : undefined;
			const tagged = last !== undefined && Object.hasOwn(CHANGED_TAGS, last);
			const sys = fields[0] ?? "";
			const mic = (tagged ? fields.slice(1, -1) : fields.slice(1)).join("|");
			return {
				type: "device",
				systemName: nameOrNull(sys),
				micName: nameOrNull(mic),
				changed: tagged ? (CHANGED_TAGS[last] ?? null) : null,
			};
		}
		case "WARN":
			return { type: "warn", message: payload.trim() };
		case "DEVICES": {
			try {
				const parsed: unknown = JSON.parse(payload);
				return Array.isArray(parsed) ? { type: "devices", devices: parsed as AudioDevice[] } : null;
			} catch {
				return null;
			}
		}
		default:
			return null;
	}
}

/**
 * Splits a stream into complete lines, keeping the trailing partial line buffered. Buffers are
 * decoded as a UTF-8 stream, so a multi-byte character split across reads stays intact.
 */
export class LineSplitter {
	private buffer = "";
	private readonly decoder = new StringDecoder("utf8");

	push(data: string | Buffer): string[] {
		this.buffer += typeof data === "string" ? data : this.decoder.write(data);
		const lines = this.buffer.split("\n");
		this.buffer = lines.pop() ?? "";
		return lines;
	}

	flush(): string[] {
		const rest = this.buffer + this.decoder.end();
		this.buffer = "";
		return rest ? [rest] : [];
	}
}

/** Longest accepted device id (friendly names are far shorter). */
export const MAX_DEVICE_ID_LENGTH = 512;

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Device ids travel inside newline-delimited stdin commands and argv: a control character
 * (CR/LF, NUL, …) could inject another command (e.g. `q`). Throws `ValidationError` — naming
 * `field` when given (HTTP 400 at the API) — and returns the id unchanged otherwise.
 */
export function assertDeviceId(device: string, field = "Nome de dispositivo"): string {
	if (CONTROL_CHARS.test(device)) {
		throw new ValidationError(`${field} contém caracteres inválidos`);
	}
	if (device.length > MAX_DEVICE_ID_LENGTH) throw new ValidationError(`${field} muito longo`);
	return device;
}

function deviceArgs(devices: CaptureDevices, micVolume?: number): string[] {
	const args = ["--device", assertDeviceId(devices.system)];
	if (devices.mic) args.push("--mic", assertDeviceId(devices.mic));
	// Always sent, so a mic added live later (`set-mic`) is mixed at the configured volume.
	args.push("--mic-volume", String(micVolume ?? DEFAULT_MIC_VOLUME));
	return args;
}

/** argv for a recording run of the native binary. Pure. */
export function buildCaptureArgs(opts: CaptureOptions): string[] {
	return [
		"--output-dir",
		opts.outputDir,
		"--prefix",
		opts.filenamePrefix,
		"--chunk-seconds",
		String(opts.chunkSeconds),
		"--sample-rate",
		String(opts.sampleRate),
		"--channels",
		String(opts.channels),
		...deviceArgs(opts.devices, opts.micVolume),
	];
}

/** argv for a level meter (no files written). Pure. */
export function buildMeterArgs(devices: CaptureDevices): string[] {
	const args = ["--meter-only", "--device", assertDeviceId(devices.system)];
	if (devices.mic) args.push("--mic", assertDeviceId(devices.mic));
	return args;
}

/** argv for the test tone; strips a legacy " (Loopback)" display suffix. Pure. */
export function buildToneArgs(device: string): string[] {
	const id = assertDeviceId(device)
		.replace(/\s*\(Loopback\)$/i, "")
		.trim();
	return id ? ["--play-tone", "--device", id] : ["--play-tone"];
}

/** stdin command toggling a source's mute. */
export function muteCommand(source: CaptureSource, muted: boolean): string {
	return `${muted ? "mute" : "unmute"}-${source === "mic" ? "mic" : "sys"}`;
}

/** stdin command swapping a source live; `null` = remove the source. Throws on control chars. */
export function switchCommand(source: CaptureSource, device: string | null): string {
	const target = device === null ? "none" : assertDeviceId(device);
	return source === "mic" ? `set-mic ${target}` : `set-sys ${target}`;
}
