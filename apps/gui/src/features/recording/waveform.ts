import type { AudioLevels } from "../../shared/api/types";

export const WAVE_BARS = 72;
/** Mixed level below this counts as silence. */
export const SILENCE_LEVEL = 0.04;
/** Frames (50 ms each) of silence before the warning shows — ~3 s. */
export const SILENCE_FRAMES = 60;

/** Bar height in px for the big recording waveform (design `loop`). */
export function waveBarHeight(level: number, i: number): number {
	return 4 + level * 150 * (0.8 + 0.2 * Math.sin(i * 1.7));
}

/** Small onboarding meters: same shape, capped at `max` px. */
export function meterBarHeight(level: number, i: number, max: number): number {
	return Math.min(max, 3 + level * max * (0.8 + 0.2 * Math.sin(i * 1.7)));
}

/** One level for the waveform: the louder of mic and (slightly attenuated) system audio. */
export function mixLevels(l: AudioLevels): number {
	return Math.max(l.mic, l.system * 0.85);
}

/**
 * Level for the "neutral" waveform (backend cannot measure levels): a gentle, mid-height
 * breathing so the screen still reads as "recording" without pretending to show real audio.
 */
export function neutralLevel(nowMs: number): number {
	return 0.26 + 0.07 * Math.sin(nowMs / 450);
}

export function nextQuietFrames(quiet: number, level: number): number {
	return level < SILENCE_LEVEL ? quiet + 1 : 0;
}
