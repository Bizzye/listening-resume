/** Updates the tray icon/tooltip when running inside the Tauri shell; no-op in a browser. */
export function setTrayRecording(recording: boolean): void {
	if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
	import("@tauri-apps/api/core")
		.then(({ invoke }) => invoke("set_tray_recording", { recording }))
		.catch(() => {
			// tray is cosmetic
		});
}
