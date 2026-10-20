import { type CSSProperties, useEffect, useRef } from "react";
import { useLatest } from "../hooks/useLatest";

/** Shifts the history left by one and appends `value` (design `loop`: push + shift). */
export function pushHistory(history: number[], value: number): void {
	history.push(value);
	history.shift();
}

interface LevelBarsProps {
	count: number;
	/** Called once per frame; must be cheap (reads a ref). Returns 0..1. */
	getLevel: () => number;
	/** Pixel height for a bar holding `level` at position `i`. */
	height: (level: number, i: number) => number;
	barWidth?: number;
	gap: number;
	frameMs?: number;
	onFrame?: (level: number) => void;
	style?: CSSProperties;
	testId?: string;
}

/**
 * Scrolling level history (right → left), animated with requestAnimationFrame. Bar heights are
 * written straight to the DOM through a ref — no React render per frame.
 */
export function LevelBars({
	count,
	getLevel,
	height,
	barWidth,
	gap,
	frameMs = 50,
	onFrame,
	style,
	testId,
}: LevelBarsProps) {
	const ref = useRef<HTMLDivElement>(null);
	const latest = useLatest({ getLevel, height, onFrame });

	useEffect(() => {
		const history = new Array<number>(count).fill(0);
		let raf = 0;
		let last = Number.NEGATIVE_INFINITY;
		const loop = (t: number) => {
			raf = requestAnimationFrame(loop);
			if (t - last < frameMs) return;
			last = t;
			const { getLevel: read, height: h, onFrame: frame } = latest.current;
			const lvl = Math.min(1, Math.max(0, read() || 0));
			pushHistory(history, lvl);
			const kids = ref.current?.children;
			if (kids) {
				for (let i = 0; i < kids.length; i++) {
					(kids[i] as HTMLElement).style.height = `${h(history[i], i).toFixed(1)}px`;
				}
			}
			frame?.(lvl);
		};
		raf = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(raf);
	}, [count, frameMs, latest]);

	return (
		<div
			ref={ref}
			data-testid={testId}
			aria-hidden="true"
			style={{ display: "flex", alignItems: "center", gap: `${gap}px`, ...style }}
		>
			{Array.from({ length: count }, (_, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: fixed-size, never reordered
				<span key={i} className="wbar2" style={barWidth ? { width: barWidth } : undefined} />
			))}
		</div>
	);
}
