const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/** Absolute http(s)/mailto URL, or null (relative links, javascript:, file:… are refused). */
export function safeExternalUrl(href: string | undefined): string | null {
	if (!href) return null;
	try {
		const url = new URL(href);
		return SAFE_PROTOCOLS.has(url.protocol) ? url.href : null;
	} catch {
		return null;
	}
}

/**
 * Opens a link outside the app — never navigates the SPA/webview away. Inside Tauri it asks the
 * shell plugin to open the system browser; if that is not permitted it falls back to a new
 * window (the webview hands it to the OS).
 */
export async function openExternal(href: string): Promise<void> {
	const url = safeExternalUrl(href);
	if (!url) return;
	if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
		try {
			const { invoke } = await import("@tauri-apps/api/core");
			await invoke("plugin:shell|open", { path: url });
			return;
		} catch {
			// shell:allow-open not granted — fall through
		}
	}
	window.open(url, "_blank", "noopener,noreferrer");
}
