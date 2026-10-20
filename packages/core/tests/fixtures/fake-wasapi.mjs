// Stand-in for wasapi-capture.exe speaking the stdout/stdin protocol (CONTRACT §2).
// Run as: node fake-wasapi.mjs <binary args...>
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const args = process.argv.slice(2);
const flag = (name) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const has = (name) => args.includes(name);
const out = (line) => process.stdout.write(`${line}\n`);

// Lets tests inspect the exact argv the adapter passed.
if (process.env.FAKE_WASAPI_ARGS_FILE) {
	fs.writeFileSync(process.env.FAKE_WASAPI_ARGS_FILE, JSON.stringify(args));
}

if (has("--list-devices")) {
	out(
		`DEVICES:${JSON.stringify([
			{
				id: "Speakers",
				name: "Speakers (Loopback)",
				isMonitor: true,
				isDefault: true,
				type: "monitor",
			},
			{ id: "Mic", name: "Mic", isMonitor: false, isDefault: true, type: "microphone" },
		])}`,
	);
	process.exit(0);
}

if (has("--play-tone")) {
	if (flag("--device") === "bad") {
		process.stderr.write("render device not found\n");
		process.exit(3);
	}
	process.exit(0);
}

let sys = flag("--device") ?? "@default";
if (sys === "explode") {
	process.stderr.write("fatal: could not open device\n");
	process.exit(2);
}
let mic = flag("--mic") ?? null;
const resolve = (dev, fallback) => (dev === "@default" ? fallback : dev);
// FAKE_WASAPI_LEGACY=1: old 2-field `DEVICE:<sys>|<mic>` lines (no changed-source tag).
const legacy = process.env.FAKE_WASAPI_LEGACY === "1";
// FAKE_WASAPI_MIC_FIRST=1: on `set-sys`, the mic reopens first (e.g. its default changed),
// producing a `mic` line that still carries the OLD system name.
const micFirst = process.env.FAKE_WASAPI_MIC_FIRST === "1";
let sysName = resolve(sys, "Speakers");
let micName = mic ? resolve(mic, "Mic") : "";
const announce = (changed) => out(`DEVICE:${sysName}|${micName}${legacy ? "" : `|${changed}`}`);
// Like the real binary: a removed source is announced at once, a (re)opened one shortly after.
const reopen = (source, ms = 30) =>
	setTimeout(() => {
		if (source === "sys") sysName = resolve(sys, "Speakers");
		else micName = mic ? resolve(mic, "Mic") : "";
		announce(source);
	}, ms);

const meterOnly = has("--meter-only");
const outputDir = flag("--output-dir");
const prefix = flag("--prefix") ?? "chunk";
const sampleRate = Number(flag("--sample-rate") ?? 16000);
const channels = Number(flag("--channels") ?? 1);
const chunkSeconds = Number(flag("--chunk-seconds") ?? 120);
const muted = { sys: false, mic: false };
let index = 0;
let chunkStart = Date.now();

function writeChunk() {
	if (meterOnly) return;
	const seconds = Math.max(0.05, (Date.now() - chunkStart) / 1000);
	chunkStart = Date.now();
	const dataBytes = Math.round(seconds * sampleRate) * channels * 2;
	const buf = Buffer.alloc(44 + dataBytes);
	buf.write("RIFF", 0);
	buf.writeUInt32LE(36 + dataBytes, 4);
	buf.write("WAVEfmt ", 8);
	buf.writeUInt32LE(16, 16);
	buf.writeUInt16LE(1, 20);
	buf.writeUInt16LE(channels, 22);
	buf.writeUInt32LE(sampleRate, 24);
	buf.writeUInt32LE(sampleRate * channels * 2, 28);
	buf.writeUInt16LE(channels * 2, 32);
	buf.writeUInt16LE(16, 34);
	buf.write("data", 36);
	buf.writeUInt32LE(dataBytes, 40);
	const file = path.join(outputDir, `${prefix}_${String(index++).padStart(4, "0")}.wav`);
	fs.writeFileSync(file, buf);
	out(`CHUNK:${file}`);
}

announce("both");
if (sys === "dies") {
	setTimeout(() => {
		process.stderr.write("device lost\n");
		process.exit(7);
	}, 200);
}
const levels = setInterval(() => {
	const s = muted.sys ? 0 : 0.5;
	const m = !mic || muted.mic ? 0 : 0.25;
	out(`LEVEL:${s.toFixed(4)},${m.toFixed(4)}`);
}, 50);
const chunks = setInterval(writeChunk, chunkSeconds * 1000);

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (raw) => {
	const line = raw.trim();
	if (line === "q" && sys === "stubborn") return; // hangs on stop: the owner must kill it
	if (line === "q") {
		clearInterval(levels);
		clearInterval(chunks);
		writeChunk();
		process.exit(0);
	}
	const m = line.match(/^(mute|unmute)-(sys|mic)$/);
	if (m) muted[m[2]] = m[1] === "mute";
	const set = line.match(/^set-(sys|mic) (.+)$/);
	if (set) {
		const source = set[1];
		if (source === "sys") sys = set[2];
		else mic = set[2] === "none" ? null : set[2];
		if (set[2] === "Missing") {
			out(
				"WARN:could not open system audio 'Missing' (not found); falling back to the system default",
			);
			sys = "@default";
		}
		if (source === "mic" && mic === null) {
			micName = "";
			announce("mic");
		} else if (source === "sys" && micFirst) {
			announce("mic"); // stale for the system switch: old system name
			reopen("sys", 300);
		} else {
			reopen(source);
		}
	}
});
