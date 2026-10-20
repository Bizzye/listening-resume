// tauri-build (run by every cargo build/test of the src-tauri crate) fails when the bundle
// resources declared in tauri*.conf.json don't exist yet. They are generated artifacts
// (build:server, download-deps, build:wasapi), so on a fresh clone or CI runner create
// placeholders only where nothing is there. Real builds overwrite them.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tauriDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src-tauri");

const resourcesDir = path.join(tauriDir, "resources");
fs.mkdirSync(resourcesDir, { recursive: true });
if (fs.readdirSync(resourcesDir).length === 0) {
	fs.writeFileSync(path.join(resourcesDir, ".placeholder"), "");
	console.log("created src-tauri/resources/.placeholder");
}

const binary = path.join(tauriDir, "binaries", "wasapi-capture.exe");
if (!fs.existsSync(binary)) {
	fs.mkdirSync(path.dirname(binary), { recursive: true });
	fs.writeFileSync(binary, "");
	console.log("created empty src-tauri/binaries/wasapi-capture.exe placeholder");
}
