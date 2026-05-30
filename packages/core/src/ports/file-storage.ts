export interface FileStoragePort {
  ensureDir(path: string): Promise<void>;
  getSessionDir(sessionId: string): string;
  getChunkPath(sessionId: string, index: number): string;
  writeText(path: string, content: string): Promise<void>;
  writeJson(path: string, data: unknown): Promise<void>;
  readText(path: string): Promise<string>;
  readJson<T>(path: string): Promise<T>;
  exists(path: string): Promise<boolean>;
}
