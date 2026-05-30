import { spawn } from "node:child_process";
import type {
  TranscriberPort,
  TranscribeOptions,
  TranscribeResult,
} from "../../ports/transcriber.js";
import { TranscriptionError } from "../../domain/errors.js";

export class WhisperCppAdapter implements TranscriberPort {
  readonly provider = "whisper-cpp";
  readonly model: string;
  private binaryPath: string;
  private modelPath: string;

  constructor(binaryPath = "whisper-cpp", modelPath: string, model = "small") {
    this.binaryPath = binaryPath;
    this.modelPath = modelPath;
    this.model = model;
  }

  async transcribe(
    audioPath: string,
    options?: TranscribeOptions,
  ): Promise<TranscribeResult> {
    return new Promise((resolve, reject) => {
      const args = [
        "-m",
        this.modelPath,
        "-f",
        audioPath,
        "--output-json",
        "-l",
        options?.language ?? "auto",
      ];

      const proc = spawn(this.binaryPath, args);
      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data) => {
        stdout += data.toString();
      });
      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (code !== 0) {
          reject(
            new TranscriptionError(
              `whisper.cpp failed (code ${code}): ${stderr}`,
            ),
          );
          return;
        }
        try {
          const result = JSON.parse(stdout);
          const segments = (result.transcription ?? []).map(
            (seg: { offsets: { from: number; to: number }; text: string }) => ({
              start: seg.offsets.from / 1000,
              end: seg.offsets.to / 1000,
              text: seg.text.trim(),
            }),
          );
          const fullText = segments
            .map((s: { text: string }) => s.text)
            .join(" ");
          resolve({
            segments,
            fullText,
            language: options?.language ?? "auto",
            duration:
              segments.length > 0 ? segments[segments.length - 1].end : 0,
          });
        } catch (e) {
          reject(
            new TranscriptionError(`Failed to parse whisper.cpp output: ${e}`),
          );
        }
      });

      proc.on("error", () => {
        reject(
          new TranscriptionError(
            `whisper.cpp binary not found at: ${this.binaryPath}`,
          ),
        );
      });
    });
  }
}
