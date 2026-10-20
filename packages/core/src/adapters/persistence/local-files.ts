import { existsSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { FileStoragePort } from "../../ports/file-storage.js";

/** Session files under `<dataDir>/sessions/<id>/`. */
export class LocalFileStorage implements FileStoragePort {
	constructor(private readonly baseDir: string) {}

	async ensureDir(dirPath: string): Promise<void> {
		await fs.mkdir(dirPath, { recursive: true });
	}

	getSessionDir(sessionId: string): string {
		return path.join(this.baseDir, "sessions", sessionId);
	}

	getAudioDir(sessionId: string): string {
		return path.join(this.getSessionDir(sessionId), "audio");
	}

	async listAudioFiles(sessionId: string): Promise<string[]> {
		const dir = this.getAudioDir(sessionId);
		try {
			const names = await fs.readdir(dir);
			return names
				.filter((n) => n.toLowerCase().endsWith(".wav"))
				.sort()
				.map((n) => path.join(dir, n));
		} catch {
			return [];
		}
	}

	async removeSessionDir(sessionId: string): Promise<void> {
		await fs.rm(this.getSessionDir(sessionId), { recursive: true, force: true });
	}

	exists(filePath: string): boolean {
		return existsSync(filePath);
	}

	async removeFile(filePath: string): Promise<void> {
		await fs.rm(filePath, { force: true });
	}

	modifiedAt(filePath: string): number | null {
		try {
			return statSync(filePath).mtimeMs;
		} catch {
			return null;
		}
	}
}
