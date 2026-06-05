import { type ChildProcess, execSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import { AudioCaptureError } from "../../domain/errors.js";
import type {
	AudioCapturePort,
	AudioDevice,
	CaptureOptions,
	ChunkInfo,
} from "../../ports/audio-capture.js";

/**
 * Audio capture adapter for Windows.
 *
 * Uses two strategies (in priority order):
 * 1. Native WASAPI loopback via bundled `wasapi-capture` binary — captures directly
 *    from output devices without requiring "Stereo Mix" or any virtual audio cable.
 * 2. FFmpeg + DirectShow (dshow) — fallback when the native binary is not available,
 *    requires "Stereo Mix" or similar loopback recording device to be enabled.
 */
export class FFmpegWasapiAdapter extends EventEmitter implements AudioCapturePort {
	private process: ChildProcess | null = null;
	private chunks: ChunkInfo[] = [];
	private chunkIndex = 0;
	private options: CaptureOptions | null = null;
	private chunkCallback: ((info: ChunkInfo) => void) | null = null;
	private recording = false;
	private useNativeCapture = false;
	private nativeBinaryPath: string | null = null;
	private micMuted = false;
	private systemMuted = false;

	/** Known names for loopback/monitor devices across different audio drivers */
	private static readonly LOOPBACK_KEYWORDS = [
		"stereo mix",
		"loopback",
		"what u hear",
		"what you hear",
		"wave out mix",
		"mono mix",
		"virtual cable",
		"vb-audio",
		"cable output",
		"voicemeeter",
	];

	constructor() {
		super();
		this.nativeBinaryPath = this.findNativeBinary();
		this.useNativeCapture = this.nativeBinaryPath !== null;
	}

	/** True when the native WASAPI binary is available (Windows render/capture). */
	get hasNativeBinary(): boolean {
		return this.nativeBinaryPath !== null;
	}

	/**
	 * Play a short test tone on a specific render (output) device via the native
	 * WASAPI binary — the only way to target a non-default device without ffplay.
	 * `device` should be the friendly name without any "(Loopback)" suffix.
	 */
	playTestTone(device: string): Promise<void> {
		return new Promise((resolve, reject) => {
			if (!this.nativeBinaryPath) {
				reject(new AudioCaptureError("Native WASAPI binary not available"));
				return;
			}
			const args = ["--play-tone"];
			if (device) args.push("--device", device);
			const proc = spawn(this.nativeBinaryPath, args, { stdio: ["ignore", "ignore", "pipe"] });
			let stderr = "";
			proc.stderr?.on("data", (d) => {
				stderr += d.toString();
			});
			proc.on("error", (err) => reject(new AudioCaptureError(`Test tone failed: ${err.message}`)));
			proc.on("close", (code) => {
				if (code === 0) resolve();
				else reject(new AudioCaptureError(`Test tone exited ${code}: ${stderr.trim()}`));
			});
		});
	}

	/**
	 * Mute/unmute a recording input live. The native binary reads the command on stdin
	 * and zeroes that source in the mix on the next frame (no chunk restart). Affects the
	 * recording only — system playback and the physical mic are untouched.
	 */
	async setInputMute(target: "mic" | "system", muted: boolean): Promise<void> {
		if (target === "mic") this.micMuted = muted;
		else this.systemMuted = muted;

		const prefix = target === "mic" ? "mic" : "sys";
		const cmd = `${muted ? "mute" : "unmute"}-${prefix}\n`;
		// Only the native capture path supports live mute; the dshow fallback can't.
		this.process?.stdin?.write(cmd);
	}

	getInputMuteState(): { mic: boolean; system: boolean } {
		return { mic: this.micMuted, system: this.systemMuted };
	}

	private findNativeBinary(): string | null {
		const nodeDir = path.dirname(process.execPath);
		const candidates = [
			// Tauri NSIS layout: node at resources/bin/node.exe → binary at ../../binaries/
			path.join(nodeDir, "..", "..", "binaries", "wasapi-capture.exe"),
			// Tauri sidecar: next to main exe
			path.join(nodeDir, "wasapi-capture.exe"),
			// Tauri sidecar in binaries/ next to node
			path.join(nodeDir, "binaries", "wasapi-capture.exe"),
			// One level up (resources/)
			path.join(nodeDir, "..", "wasapi-capture.exe"),
			path.join(nodeDir, "..", "binaries", "wasapi-capture.exe"),
			// Resources subfolder
			path.join(nodeDir, "..", "resources", "wasapi-capture.exe"),
			// Development: current working directory
			path.join(process.cwd(), "wasapi-capture.exe"),
			path.join(process.cwd(), "src-tauri", "binaries", "wasapi-capture.exe"),
			// Development: monorepo siblings (running from apps/cli, packages/core, or workspace root)
			path.join(process.cwd(), "..", "gui", "src-tauri", "binaries", "wasapi-capture.exe"),
			path.join(process.cwd(), "apps", "gui", "src-tauri", "binaries", "wasapi-capture.exe"),
		];

		// Also check PATH
		try {
			const where = execSync("where wasapi-capture", {
				encoding: "utf-8",
				timeout: 3000,
				stdio: ["pipe", "pipe", "pipe"],
			}).trim();
			if (where) candidates.unshift(where.split("\n")[0].trim());
		} catch {
			// Not in PATH
		}

		for (const candidate of candidates) {
			if (existsSync(candidate)) {
				return candidate;
			}
		}
		return null;
	}

	private isLoopbackDevice(name: string): boolean {
		const lower = name.toLowerCase();
		return FFmpegWasapiAdapter.LOOPBACK_KEYWORDS.some((kw) => lower.includes(kw));
	}

	async listDevices(): Promise<AudioDevice[]> {
		// Prefer native binary for device listing (shows output devices for loopback)
		if (this.useNativeCapture && this.nativeBinaryPath) {
			try {
				const devices = await this.listWithNativeBinary();
				if (devices.length > 0) return devices;
			} catch {
				// Fall through to dshow
			}
		}

		// Fallback: ffmpeg dshow (shows input/recording devices)
		let devices = await this.listWithDshow();
		if (devices.length === 0) {
			devices = await this.listWithPowerShell();
		}

		// If no loopback device found with dshow, try to enable Stereo Mix
		const hasLoopback = devices.some((d) => d.isMonitor);
		if (!hasLoopback && !this.useNativeCapture) {
			const enabled = await this.tryEnableStereoMix();
			if (enabled) {
				devices = await this.listWithDshow();
			}
		}

		if (!devices.some((d) => d.isMonitor) && !this.useNativeCapture) {
			devices.push({
				id: "__no_loopback__",
				name: "⚠ No loopback device found — enable Stereo Mix in Sound settings",
				isMonitor: false,
				isDefault: devices.length === 0,
				type: "monitor",
			});
		}

		return devices;
	}

	private listWithNativeBinary(): Promise<AudioDevice[]> {
		return new Promise((resolve, reject) => {
			const proc = spawn(this.nativeBinaryPath!, ["--list-devices"], {
				stdio: ["pipe", "pipe", "pipe"],
			});
			let stdout = "";
			proc.stdout.on("data", (data) => {
				stdout += data.toString();
			});
			proc.stderr.on("data", () => {});
			proc.on("close", () => {
				const line = stdout.split("\n").find((l) => l.startsWith("DEVICES:"));
				if (line) {
					try {
						const devices: AudioDevice[] = JSON.parse(line.slice(8));
						resolve(devices);
						return;
					} catch {
						/* fall through */
					}
				}
				reject(new AudioCaptureError("Failed to parse native device list"));
			});
			proc.on("error", () => reject(new AudioCaptureError("Native binary not found")));
		});
	}

	private listWithDshow(): Promise<AudioDevice[]> {
		return new Promise((resolve, reject) => {
			const proc = spawn("ffmpeg", ["-list_devices", "true", "-f", "dshow", "-i", "dummy"], {
				stdio: ["pipe", "pipe", "pipe"],
			});
			let stderr = "";
			proc.stderr.on("data", (data) => {
				stderr += data.toString();
			});
			proc.on("close", () => {
				const devices: AudioDevice[] = [];
				const lines = stderr.split("\n");
				let isAudioSection = false;
				for (const line of lines) {
					if (line.includes("DirectShow audio devices")) {
						isAudioSection = true;
						continue;
					}
					if (line.includes("DirectShow video devices")) {
						isAudioSection = false;
						continue;
					}
					if (isAudioSection) {
						const match = line.match(/"([^"]+)"/);
						if (match && !line.includes("Alternative name")) {
							const name = match[1];
							const isLoopback = this.isLoopbackDevice(name);
							devices.push({
								id: name,
								name,
								isMonitor: isLoopback,
								isDefault: isLoopback,
								type: isLoopback ? "monitor" : "microphone",
							});
						}
					}
				}
				resolve(devices);
			});
			proc.on("error", () => {
				reject(new AudioCaptureError("FFmpeg not found. Install FFmpeg and ensure it is in PATH."));
			});
		});
	}

	private listWithPowerShell(): Promise<AudioDevice[]> {
		return new Promise((resolve, reject) => {
			try {
				const output = execSync(
					'powershell -Command "Get-WmiObject Win32_SoundDevice | Select-Object Name, Status | ConvertTo-Json"',
					{ timeout: 5000, encoding: "utf-8" },
				);
				const parsed = JSON.parse(output);
				const items = Array.isArray(parsed) ? parsed : [parsed];
				const devices: AudioDevice[] = items
					.filter((d: { Status: string }) => d.Status === "OK")
					.map((d: { Name: string }) => {
						const isLoopback = this.isLoopbackDevice(d.Name);
						return {
							id: d.Name,
							name: d.Name,
							isMonitor: isLoopback,
							isDefault: isLoopback,
							type: isLoopback ? ("monitor" as const) : ("microphone" as const),
						};
					});
				resolve(devices);
			} catch {
				reject(new AudioCaptureError("Failed to list audio devices via PowerShell"));
			}
		});
	}

	private async tryEnableStereoMix(): Promise<boolean> {
		try {
			const script = `
        $devices = Get-PnpDevice -Class AudioEndpoint -Status OK, Error, Degraded 2>$null |
          Where-Object { $_.FriendlyName -match 'Stereo Mix|Wave Out Mix|Mono Mix' }
        if ($devices) {
          foreach ($dev in $devices) {
            Enable-PnpDevice -InstanceId $dev.InstanceId -Confirm:$false 2>$null
          }
          Write-Output "enabled"
        } else {
          Write-Output "not_found"
        }
      `;
			const result = execSync(`powershell -NoProfile -Command "${script.replace(/\n/g, " ")}"`, {
				timeout: 10000,
				encoding: "utf-8",
			}).trim();
			return result === "enabled";
		} catch {
			return false;
		}
	}

	async startCapture(options: CaptureOptions): Promise<void> {
		if (options.device === "__no_loopback__") {
			throw new AudioCaptureError(
				'No loopback audio device available. Enable "Stereo Mix" in Windows Sound settings: ' +
					"Right-click speaker icon → Sounds → Recording tab → Right-click → Show Disabled Devices → Enable Stereo Mix",
			);
		}
		this.options = options;
		this.chunks = [];
		this.chunkIndex = 0;
		this.recording = true;
		this.micMuted = false;
		this.systemMuted = false;

		if (this.useNativeCapture && this.nativeBinaryPath) {
			this.startNativeCapture(options);
		} else {
			this.startFfmpegCapture();
		}
	}

	private startNativeCapture(options: CaptureOptions): void {
		const args = [
			"--output-dir",
			options.outputDir,
			"--prefix",
			options.filenamePrefix,
			"--chunk-seconds",
			String(options.chunkSeconds),
			"--sample-rate",
			String(options.sampleRate),
			"--channels",
			String(options.channels),
		];
		if (options.device) {
			args.push("--device", options.device);
		}
		if (options.micDevice) {
			args.push("--mic", options.micDevice);
			args.push("--mic-volume", String(options.micVolume ?? 1.2));
		}

		this.process = spawn(this.nativeBinaryPath!, args, {
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stdoutBuffer = "";
		this.process.stdout?.on("data", (data) => {
			stdoutBuffer += data.toString();
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() || "";
			for (const line of lines) {
				if (line.startsWith("CHUNK:")) {
					const chunkPath = line.slice(6).trim();
					const info: ChunkInfo = { path: chunkPath, index: this.chunkIndex };
					this.chunks.push(info);
					this.chunkCallback?.(info);
					this.chunkIndex++;
				}
			}
		});

		this.process.stderr?.on("data", (data) => {
			const msg = data.toString().trim();
			if (msg) console.error(`[wasapi-capture] ${msg}`);
		});

		this.process.on("close", (code) => {
			if (code !== 0 && code !== null && this.recording) {
				this.emit("error", new AudioCaptureError(`wasapi-capture exited with code ${code}`));
			}
		});

		this.process.on("error", (err) => {
			this.emit("error", new AudioCaptureError(`wasapi-capture error: ${err.message}`));
		});
	}

	private startFfmpegCapture(): void {
		this.recordNextChunk();
	}

	private recordNextChunk(): void {
		if (!this.recording || !this.options) return;

		const chunkPath = path.join(
			this.options.outputDir,
			`${this.options.filenamePrefix}_${String(this.chunkIndex).padStart(4, "0")}.wav`,
		);

		const args: string[] = [];

		// Primary input: system audio (loopback/dshow)
		args.push("-f", "dshow", "-i", `audio=${this.options.device}`);

		if (this.options.micDevice) {
			// Secondary input: microphone
			args.push("-f", "dshow", "-i", `audio=${this.options.micDevice}`);

			// Mix both inputs: alimiter prevents clipping with near-zero latency
			const micVol = this.options.micVolume ?? 1.2;
			args.push(
				"-filter_complex",
				`[0:a]volume=1.0[sys];[1:a]volume=${micVol}[mic];[sys][mic]amix=inputs=2:duration=first:dropout_transition=3,alimiter=limit=0.95:attack=5:release=50`,
			);
		}

		args.push(
			"-ac",
			String(this.options.channels),
			"-ar",
			String(this.options.sampleRate),
			"-t",
			String(this.options.chunkSeconds),
			"-y",
			chunkPath,
		);

		this.process = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });

		this.process.on("close", (code) => {
			const info: ChunkInfo = { path: chunkPath, index: this.chunkIndex };
			if (code === 0) {
				this.chunks.push(info);
				this.chunkCallback?.(info);
				this.chunkIndex++;
				if (this.recording) {
					this.recordNextChunk();
				}
			} else if (!this.recording) {
				// Stopped by user — keep the partial chunk
				this.chunks.push(info);
				this.chunkCallback?.(info);
			} else {
				this.emit("error", new AudioCaptureError(`FFmpeg exited with code ${code}`));
			}
		});

		this.process.on("error", (err) => {
			this.emit("error", new AudioCaptureError(`FFmpeg error: ${err.message}`));
		});
	}

	async stopCapture(): Promise<ChunkInfo[]> {
		this.recording = false;
		if (this.process) {
			// Send 'q' + newline for graceful stop (works for both ffmpeg and wasapi-capture)
			this.process.stdin?.write("q\n");
			await new Promise<void>((resolve) => {
				const timeout = setTimeout(() => {
					this.process?.kill();
					resolve();
				}, 3000);
				this.process?.on("close", () => {
					clearTimeout(timeout);
					resolve();
				});
			});
			this.process = null;
		}
		return this.chunks;
	}

	onChunkReady(callback: (info: ChunkInfo) => void): void {
		this.chunkCallback = callback;
	}
}
