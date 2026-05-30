import fs from "node:fs/promises";
import path from "node:path";
import type { FileStoragePort } from "../../ports/file-storage.js";

export class LocalFileStorage implements FileStoragePort {
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  async ensureDir(dirPath: string): Promise<void> {
    await fs.mkdir(dirPath, { recursive: true });
  }

  getSessionDir(sessionId: string): string {
    return path.join(this.baseDir, "sessions", sessionId);
  }

  getChunkPath(sessionId: string, index: number): string {
    return path.join(
      this.getSessionDir(sessionId),
      "audio",
      `chunk_${String(index).padStart(4, "0")}.wav`,
    );
  }

  async writeText(filePath: string, content: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf-8");
  }

  async writeJson(filePath: string, data: unknown): Promise<void> {
    await this.writeText(filePath, JSON.stringify(data, null, 2));
  }

  async readText(filePath: string): Promise<string> {
    return fs.readFile(filePath, "utf-8");
  }

  async readJson<T>(filePath: string): Promise<T> {
    const content = await this.readText(filePath);
    return JSON.parse(content) as T;
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
