import path from "node:path";

/** Decode the `X-Filename` header (clients may percent-encode non-ASCII names). */
export function decodeFilenameHeader(raw: string | string[] | undefined): string {
	const value = Array.isArray(raw) ? raw[0] : raw;
	if (!value) return "";
	let decoded = value;
	try {
		decoded = decodeURIComponent(value);
	} catch {
		// not percent-encoded — use as-is
	}
	// Strip any client-side directory components (C:\fakepath\x.mp3, ../x.mp3).
	return path.win32.basename(path.posix.basename(decoded.replace(/\\/g, "/"))).trim();
}

/** Lowercase extension without the dot (`"mp4"`), or `""`. */
export function fileExtension(filename: string): string {
	const ext = path.extname(filename).toLowerCase().replace(/^\./, "");
	return /^[a-z0-9]{1,10}$/.test(ext) ? ext : "";
}

/** Session title derived from an imported filename (no extension, separators → spaces). */
export function titleFromFilename(filename: string): string {
	const base = filename.slice(0, filename.length - path.extname(filename).length);
	const title = base.replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
	return title.slice(0, 200) || "Arquivo importado";
}
