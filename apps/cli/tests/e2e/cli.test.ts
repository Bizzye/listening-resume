import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const CLI_PATH = path.resolve(__dirname, "../../src/index.ts");
const TEST_DATA_DIR = path.join(os.tmpdir(), `lr-e2e-${Date.now()}`);

function runCli(args: string, env: Record<string, string> = {}): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  try {
    const stdout = execSync(`tsx ${CLI_PATH} ${args}`, {
      encoding: "utf-8",
      cwd: path.resolve(__dirname, "../.."),
      env: {
        ...process.env,
        LISTENING_RESUME_DATA_DIR: TEST_DATA_DIR,
        ...env,
      },
      timeout: 15000,
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      exitCode: e.status ?? 1,
    };
  }
}

describe("CLI E2E", () => {
  beforeAll(() => {
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  describe("--help", () => {
    it("shows help text", () => {
      const { stdout } = runCli("--help");
      expect(stdout).toContain("Record system audio");
      expect(stdout).toContain("Commands:");
    });

    it("shows version", () => {
      const { stdout } = runCli("--version");
      expect(stdout).toContain("0.1.0");
    });
  });

  describe("devices", () => {
    it("lists audio devices", () => {
      const { stdout, exitCode } = runCli("devices");
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Available audio devices");
    });
  });

  describe("templates", () => {
    it("lists available templates", () => {
      const { stdout, exitCode } = runCli("templates");
      expect(exitCode).toBe(0);
      expect(stdout).toContain("meeting-summary");
      expect(stdout).toContain("action-items");
    });
  });

  describe("list", () => {
    it("runs successfully with empty data dir", () => {
      const { stdout, exitCode } = runCli("list");
      expect(exitCode).toBe(0);
      // Either shows "No sessions found" or an empty sessions list
      expect(stdout).toMatch(/No sessions found|Sessions:/i);
    });
  });

  describe("show", () => {
    it("reports session not found for invalid id", () => {
      // First we need a DB to exist
      const { stdout, exitCode } = runCli("show nonexistent");
      // Either no db or session not found
      expect(stdout).toMatch(/not found|No database/i);
    });
  });

  describe("transcribe", () => {
    it("fails gracefully without GROQ_API_KEY", () => {
      const { stdout, exitCode } = runCli("transcribe fake-session-id", {
        GROQ_API_KEY: "",
      });
      expect(stdout).toMatch(/not found|not set|No database/i);
    });
  });

  describe("export", () => {
    it("fails gracefully for nonexistent session", () => {
      const { stdout, exitCode } = runCli("export nonexistent");
      expect(stdout).toMatch(/not found|No database/i);
    });
  });
});
