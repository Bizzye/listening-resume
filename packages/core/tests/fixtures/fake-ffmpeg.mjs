// Stand-in for `ffmpeg -f pulse … -t <s> -y <out.wav>`: writes a valid WAV right away (so a
// killed process still leaves audio behind, like ffmpeg's progressive writes), then "records"
// until -t elapses. Run as: node fake-ffmpeg.mjs <ffmpeg args...>
import fs from "node:fs";

const args = process.argv.slice(2);
const flag = (name) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};

if (args.includes("-version")) {
	process.stdout.write("ffmpeg version fake\n");
	process.exit(0);
}

// The first `-i` is the system source.
if (flag("-i") === "explode") {
	process.stderr.write("explode: No such device\n");
	process.exit(1);
}

const out = args.at(-1);
const seconds = Number(flag("-t") ?? 60);
const sampleRate = Number(flag("-ar") ?? 16000);
const channels = Number(flag("-ac") ?? 1);
const dataBytes = Math.round(0.25 * sampleRate) * channels * 2;
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
fs.writeFileSync(out, buf);

if (process.env.FAKE_FFMPEG_LOG) {
	fs.appendFileSync(process.env.FAKE_FFMPEG_LOG, `${JSON.stringify(args)}\n`);
}
setTimeout(() => process.exit(0), seconds * 1000);
