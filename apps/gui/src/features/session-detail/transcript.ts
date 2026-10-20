import type { TranscriptSegment } from "../../shared/api/types";
import { isSilenceArtifact } from "../../shared/lib/core-shared";

export function meaningfulSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
	return segments.filter((s) => {
		const t = s.text.trim();
		return t.length > 0 && !isSilenceArtifact(t);
	});
}

/** Index of the segment playing at `time` (last one that started), or -1. */
export function activeSegmentIndex(segments: TranscriptSegment[], time: number): number {
	let idx = -1;
	for (let i = 0; i < segments.length; i++) {
		if (segments[i].start <= time) idx = i;
		else break;
	}
	return idx;
}

export interface SegmentView {
	seg: TranscriptSegment;
	cls: string;
	hit: boolean;
}

/** Design classes: `on` for the active segment (no search), `hit`/`dim` while searching. */
export function segmentViews(segments: TranscriptSegment[], time: number, query: string) {
	const q = query.trim().toLowerCase();
	const active = activeSegmentIndex(segments, time);
	let hits = 0;
	const views: SegmentView[] = segments.map((seg, i) => {
		const hit = !!q && seg.text.toLowerCase().includes(q);
		if (hit) hits++;
		let cls = "seg";
		if (i === active && !q) cls += " on";
		if (q) cls += hit ? " hit" : " dim";
		return { seg, cls, hit };
	});
	const count = q
		? `${hits} ${hits === 1 ? "trecho" : "trechos"}`
		: `${segments.length} ${segments.length === 1 ? "segmento" : "segmentos"}`;
	return { views, count };
}
