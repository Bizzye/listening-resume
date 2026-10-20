export interface FileStoragePort {
	ensureDir(path: string): Promise<void>;
	getSessionDir(sessionId: string): string;
	/** `<sessionDir>/audio` — where capture writes the WAV chunks. */
	getAudioDir(sessionId: string): string;
	/** Absolute paths of the session's `.wav` files, sorted by name (= chunk order). */
	listAudioFiles(sessionId: string): Promise<string[]>;
	/** Deletes the session directory (audio + any side files). No-op when missing. */
	removeSessionDir(sessionId: string): Promise<void>;
	/** Whether a file exists (sync: used inside capture event handlers). */
	exists(filePath: string): boolean;
	/** Deletes one file. No-op when missing. */
	removeFile(filePath: string): Promise<void>;
	/** Last modification time (epoch ms), or `null` when the file is missing. */
	modifiedAt(filePath: string): number | null;
}
