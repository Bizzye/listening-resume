import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import type {
  AudioCapturePort,
  AudioDevice,
  CaptureOptions,
  ChunkInfo,
} from "../../ports/audio-capture.js";
import { AudioCaptureError } from "../../domain/errors.js";

export class FFmpegPulseAdapter
  extends EventEmitter
  implements AudioCapturePort
{
  constructor() {
    super();
    if (process.platform === "win32") {
      throw new AudioCaptureError(
        "FFmpegPulseAdapter is not supported on Windows. Use FFmpegWasapiAdapter instead.",
      );
    }
  }

  private process: ChildProcess | null = null;
  private chunks: ChunkInfo[] = [];
  private chunkIndex = 0;
  private currentChunkPath: string | null = null;
  private options: CaptureOptions | null = null;
  private chunkCallback: ((info: ChunkInfo) => void) | null = null;
  private recording = false;
  private micMuted = false;
  private systemMuted = false;

  /**
   * Mute/unmute an input source for recording only (does not affect system audio).
   * Restarts the current chunk with updated volume settings for immediate effect.
   */
  async setInputMute(target: "mic" | "system", muted: boolean): Promise<void> {
    if (target === "mic") {
      this.micMuted = muted;
    } else {
      this.systemMuted = muted;
    }

    // Restart current chunk so new volume takes effect immediately
    if (this.process && this.recording) {
      this.process.kill("SIGINT");
    }
  }

  getInputMuteState(): { mic: boolean; system: boolean } {
    return { mic: this.micMuted, system: this.systemMuted };
  }

  async listDevices(): Promise<AudioDevice[]> {
    // Try pactl first, fallback to pw-cli (PipeWire)
    try {
      return await this.listWithPactl();
    } catch {
      return await this.listWithPwCli();
    }
  }

  private listWithPactl(): Promise<AudioDevice[]> {
    return new Promise((resolve, reject) => {
      const proc = spawn("pactl", ["list", "sinks", "short"]);
      let output = "";
      proc.stdout.on("data", (data) => {
        output += data.toString();
      });
      proc.stderr.on("data", () => {});
      proc.on("close", (code) => {
        if (code !== 0) {
          reject(new AudioCaptureError("pactl failed"));
          return;
        }
        const devices: AudioDevice[] = output
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const parts = line.split("\t");
            const name = parts[1] ?? "unknown";
            return {
              id: `${name}.monitor`,
              name: name,
              isMonitor: true,
              isDefault: name.includes("default") || parts[0] === "0",
              type: "monitor" as const,
            };
          });

        // Also list microphones (sources that are not monitors)
        this.listMicWithPactl()
          .then((mics) => {
            resolve([...devices, ...mics]);
          })
          .catch(() => {
            resolve(devices);
          });
      });
      proc.on("error", () => reject(new AudioCaptureError("pactl not found")));
    });
  }

  private listMicWithPactl(): Promise<AudioDevice[]> {
    return new Promise((resolve, reject) => {
      const proc = spawn("pactl", ["list", "sources", "short"]);
      let output = "";
      proc.stdout.on("data", (data) => {
        output += data.toString();
      });
      proc.stderr.on("data", () => {});
      proc.on("close", (code) => {
        if (code !== 0) {
          reject(new AudioCaptureError("pactl sources failed"));
          return;
        }
        const devices: AudioDevice[] = output
          .trim()
          .split("\n")
          .filter(Boolean)
          .filter((line) => !line.includes(".monitor"))
          .map((line) => {
            const parts = line.split("\t");
            const name = parts[1] ?? "unknown";
            return {
              id: name,
              name: name.replace(/^alsa_input\./, "").replace(/\./g, " "),
              isMonitor: false,
              isDefault: parts[0] === "0",
              type: "microphone" as const,
            };
          });
        resolve(devices);
      });
      proc.on("error", () => reject(new AudioCaptureError("pactl not found")));
    });
  }

  private listWithPwCli(): Promise<AudioDevice[]> {
    return new Promise((resolve, reject) => {
      const proc = spawn("pw-cli", ["list-objects", "Node"]);
      let output = "";
      proc.stdout.on("data", (data) => {
        output += data.toString();
      });
      proc.stderr.on("data", () => {});
      proc.on("close", (code) => {
        if (code !== 0) {
          reject(
            new AudioCaptureError(
              "Failed to list audio devices. Install pactl or pw-cli.",
            ),
          );
          return;
        }
        const devices: AudioDevice[] = [];
        const blocks = output.split(/(?=id \d+)/);
        for (const block of blocks) {
          const nameMatch = block.match(/node\.name\s*=\s*"([^"]+)"/);
          const classMatch = block.match(/media\.class\s*=\s*"([^"]+)"/);
          const nickMatch = block.match(/node\.nick\s*=\s*"([^"]+)"/);
          const descMatch = block.match(/node\.description\s*=\s*"([^"]+)"/);
          if (nameMatch && classMatch && classMatch[1]?.includes("Sink")) {
            const name = nameMatch[1];
            const displayName = descMatch?.[1] ?? nickMatch?.[1] ?? name;
            devices.push({
              id: `${name}.monitor`,
              name: displayName,
              isMonitor: true,
              isDefault: devices.length === 0,
              type: "monitor",
            });
          }
          if (nameMatch && classMatch && classMatch[1] === "Audio/Source") {
            const name = nameMatch[1];
            const displayName =
              descMatch?.[1] ??
              nickMatch?.[1] ??
              name.replace(/^alsa_input\./, "").replace(/\./g, " ");
            devices.push({
              id: name,
              name: displayName,
              isMonitor: false,
              isDefault: false,
              type: "microphone",
            });
          }
        }
        if (devices.length === 0) {
          // Fallback: return default device
          devices.push({
            id: "default.monitor",
            name: "default",
            isMonitor: true,
            isDefault: true,
            type: "monitor",
          });
        }
        resolve(devices);
      });
      proc.on("error", () => {
        reject(
          new AudioCaptureError(
            "Neither pactl nor pw-cli found. Install pulseaudio-utils or pipewire.",
          ),
        );
      });
    });
  }

  async startCapture(options: CaptureOptions): Promise<void> {
    this.options = options;
    this.chunks = [];
    this.chunkIndex = 0;
    this.recording = true;
    this.recordNextChunk();
  }

  private recordNextChunk(): void {
    if (!this.recording || !this.options) return;

    const pad = String(this.chunkIndex).padStart(4, "0");
    const chunkPath = path.join(
      this.options.outputDir,
      `${this.options.filenamePrefix}_${pad}.wav`,
    );
    this.currentChunkPath = chunkPath;

    const args: string[] = [];

    if (this.options.micDevice) {
      // Dual-input: system audio + microphone → single mixed output
      // Thread queue size prevents buffer underruns between inputs
      args.push(
        "-thread_queue_size",
        "1024",
        "-f",
        "pulse",
        "-i",
        this.options.device,
        "-thread_queue_size",
        "1024",
        "-f",
        "pulse",
        "-i",
        this.options.micDevice,
      );

      // Filter: mix both inputs into one output
      const micVol = this.micMuted ? 0 : (this.options.micVolume ?? 1.2);
      const sysVol = this.systemMuted ? 0 : 1.0;
      args.push(
        "-filter_complex",
        `[0:a]aresample=async=1,volume=${sysVol}[sys];[1:a]aresample=async=1,volume=${micVol}[mic];[sys][mic]amix=inputs=2:duration=first:dropout_transition=3,alimiter=limit=0.95:attack=5:release=50[mixed]`,
      );

      args.push(
        "-map",
        "[mixed]",
        "-ac",
        String(this.options.channels),
        "-ar",
        String(this.options.sampleRate),
        "-t",
        String(this.options.chunkSeconds),
        "-y",
        chunkPath,
      );
    } else {
      // Single input: system audio only
      args.push("-f", "pulse", "-i", this.options.device);
      if (this.systemMuted) {
        args.push("-af", "volume=0");
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
    }

    this.process = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });

    this.process.on("close", () => {
      if (this.currentChunkPath) {
        const info: ChunkInfo = {
          path: this.currentChunkPath,
          index: this.chunkIndex,
        };
        this.chunks.push(info);
        this.chunkCallback?.(info);
        this.chunkIndex++;
        if (this.recording) {
          this.recordNextChunk();
        }
      }
    });

    this.process.on("error", (err) => {
      this.emit("error", new AudioCaptureError(`FFmpeg error: ${err.message}`));
    });
  }

  async stopCapture(): Promise<ChunkInfo[]> {
    this.recording = false;
    if (this.process) {
      // SIGINT makes ffmpeg finalize the output file gracefully
      this.process.kill("SIGINT");
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          this.process?.kill("SIGTERM");
          resolve();
        }, 5000);
        this.process!.on("close", () => {
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
