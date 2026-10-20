// Copies the freshly built installers into `<repo>/exe/` with a predictable name:
//   LR-<YYYY-MM-DD>-<version><suffix>   e.g. LR-2026-10-20-0.1.0-setup.exe / LR-2026-10-20-0.1.0.msi
// The date is the installer's build date (file mtime, local time) and the version comes from
// tauri.conf.json. Runs as the last step of build:windows / build:linux; can also be run alone.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const guiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(guiDir, "../..");
const bundleDir = path.join(guiDir, "src-tauri", "target", "release", "bundle");
const outDir = path.join(repoRoot, "exe");

const { version } = JSON.parse(
	fs.readFileSync(path.join(guiDir, "src-tauri", "tauri.conf.json"), "utf8"),
);

/** Bundle sub-dir → installer extension → suffix appended to the LR-<date>-<version> name. */
const TARGETS = [
	{ dir: "nsis", ext: ".exe", suffix: "-setup.exe" },
	{ dir: "msi", ext: ".msi", suffix: ".msi" },
	{ dir: "deb", ext: ".deb", suffix: ".deb" },
];

function localDate(d) {
	const pad = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Newest installer for this version in a bundle dir (Tauri names them "<product>_<version>_…"). */
function newestInstaller(dir, ext) {
	const full = path.join(bundleDir, dir);
	if (!fs.existsSync(full)) return null;
	const candidates = fs
		.readdirSync(full)
		.filter((f) => f.endsWith(ext) && f.includes(`_${version}_`))
		.map((f) => {
			const file = path.join(full, f);
			return { file, mtime: fs.statSync(file).mtime };
		})
		.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
	return candidates[0] ?? null;
}

fs.mkdirSync(outDir, { recursive: true });

let copied = 0;
for (const { dir, ext, suffix } of TARGETS) {
	const found = newestInstaller(dir, ext);
	if (!found) continue;
	const name = `LR-${localDate(found.mtime)}-${version}${suffix}`;
	const dest = path.join(outDir, name);
	fs.copyFileSync(found.file, dest);
	fs.utimesSync(dest, found.mtime, found.mtime);
	const mb = (fs.statSync(dest).size / 1024 / 1024).toFixed(1);
	console.log(`✓ ${path.relative(repoRoot, dest)} (${mb} MB)`);
	copied++;
}

if (copied === 0) {
	console.error(`✗ no installer for version ${version} found under ${bundleDir}`);
	process.exit(1);
}
