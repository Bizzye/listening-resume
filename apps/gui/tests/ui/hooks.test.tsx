import { act, render, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
	meterBarHeight,
	mixLevels,
	nextQuietFrames,
	SILENCE_LEVEL,
	waveBarHeight,
} from "../../src/features/recording/waveform";
import { useAudioLevels } from "../../src/shared/hooks/useAudioLevels";
import { matchesHotkey, useHotkey } from "../../src/shared/hooks/useHotkey";
import { usePolling } from "../../src/shared/hooks/usePolling";
import { LevelBars, pushHistory } from "../../src/shared/ui/LevelBars";
import { FakeEventSource, installFakeEventSource, installManualRaf } from "./helpers";

describe("waveform math", () => {
	it("bar height follows the design formula", () => {
		expect(waveBarHeight(0, 0)).toBe(4);
		expect(waveBarHeight(1, 0)).toBeCloseTo(4 + 150 * 0.8);
		const i = 3;
		expect(waveBarHeight(0.5, i)).toBeCloseTo(4 + 0.5 * 150 * (0.8 + 0.2 * Math.sin(i * 1.7)));
	});
	it("meter bars are capped", () => {
		expect(meterBarHeight(0, 0, 34)).toBe(3);
		expect(meterBarHeight(1, 1, 22)).toBeLessThanOrEqual(22);
	});
	it("mixes the louder source (system attenuated)", () => {
		expect(mixLevels({ system: 1, mic: 0 })).toBeCloseTo(0.85);
		expect(mixLevels({ system: 0.1, mic: 0.5 })).toBe(0.5);
	});
	it("counts quiet frames and resets on sound", () => {
		expect(nextQuietFrames(5, SILENCE_LEVEL - 0.01)).toBe(6);
		expect(nextQuietFrames(5, SILENCE_LEVEL)).toBe(0);
	});
	it("history scrolls right to left", () => {
		const h = [1, 2, 3];
		pushHistory(h, 4);
		expect(h).toEqual([2, 3, 4]);
	});
});

describe("LevelBars", () => {
	it("writes bar heights from the level history on animation frames (throttled to 50 ms)", () => {
		const raf = installManualRaf();
		let level = 0.5;
		const onFrame = vi.fn();
		const { getByTestId } = render(
			<LevelBars
				count={4}
				getLevel={() => level}
				height={(l) => l * 100}
				gap={2}
				onFrame={onFrame}
				testId="bars"
			/>,
		);
		const bars = Array.from(getByTestId("bars").children) as HTMLElement[];
		expect(bars).toHaveLength(4);
		raf.step(0);
		expect(bars.map((b) => b.style.height)).toEqual(["0px", "0px", "0px", "50px"]);
		level = 1;
		raf.step(20); // throttled
		expect(bars[3].style.height).toBe("50px");
		raf.step(60);
		expect(bars.map((b) => b.style.height)).toEqual(["0px", "0px", "50px", "100px"]);
		expect(onFrame).toHaveBeenLastCalledWith(1);
	});
});

describe("useAudioLevels", () => {
	it("opens the SSE stream with query params and exposes the latest levels without re-rendering", () => {
		installFakeEventSource();
		let renders = 0;
		const onDevices = vi.fn();
		const { result, unmount } = renderHook(() => {
			renders++;
			return useAudioLevels({ system: "@default", mic: null, onDevices });
		});
		const es = FakeEventSource.last;
		expect(es.url).toContain("system=%40default&mic=none");
		act(() => es.open());
		expect(result.current.connected).toBe(true);
		const before = renders;
		es.emit({ system: 0.3, mic: 0.6 });
		es.emit({ system: 0.4, mic: 0.7 });
		expect(renders).toBe(before);
		expect(result.current.read()).toEqual({ system: 0.4, mic: 0.7 });
		es.emitEvent("devices", { system: "@default", mic: null, systemName: "Fone", micName: null });
		expect(onDevices).toHaveBeenCalled();
		unmount();
		expect(es.closed).toBe(true);
	});

	it("treats stale levels as silence", () => {
		installFakeEventSource();
		vi.useFakeTimers();
		const { result } = renderHook(() => useAudioLevels({}));
		FakeEventSource.last.emit({ system: 0.9, mic: 0.9 });
		expect(result.current.read().system).toBe(0.9);
		vi.advanceTimersByTime(600);
		expect(result.current.read()).toEqual({ system: 0, mic: 0 });
	});

	it("does not connect when disabled and reconnects when devices change", () => {
		installFakeEventSource();
		const { rerender } = renderHook((p: { mic: string; enabled: boolean }) => useAudioLevels(p), {
			initialProps: { mic: "a", enabled: false },
		});
		expect(FakeEventSource.instances).toHaveLength(0);
		rerender({ mic: "a", enabled: true });
		expect(FakeEventSource.instances).toHaveLength(1);
		rerender({ mic: "b", enabled: true });
		expect(FakeEventSource.instances).toHaveLength(2);
		expect(FakeEventSource.instances[0].closed).toBe(true);
	});
});

describe("useHotkey / usePolling", () => {
	it("matches Ctrl+Shift+R (and Cmd) only", () => {
		const spec = { key: "r", ctrl: true, shift: true };
		expect(
			matchesHotkey(
				new KeyboardEvent("keydown", { key: "R", ctrlKey: true, shiftKey: true }),
				spec,
			),
		).toBe(true);
		expect(
			matchesHotkey(
				new KeyboardEvent("keydown", { key: "R", metaKey: true, shiftKey: true }),
				spec,
			),
		).toBe(true);
		expect(matchesHotkey(new KeyboardEvent("keydown", { key: "r", ctrlKey: true }), spec)).toBe(
			false,
		);
	});
	it("fires the handler once per press and prevents the browser default", () => {
		const fn = vi.fn();
		renderHook(() => useHotkey({ key: "r", ctrl: true, shift: true }, fn));
		const e = new KeyboardEvent("keydown", {
			key: "R",
			ctrlKey: true,
			shiftKey: true,
			cancelable: true,
		});
		window.dispatchEvent(e);
		window.dispatchEvent(
			new KeyboardEvent("keydown", { key: "R", ctrlKey: true, shiftKey: true, repeat: true }),
		);
		expect(fn).toHaveBeenCalledTimes(1);
		expect(e.defaultPrevented).toBe(true);
	});
	it("polls only while enabled", async () => {
		vi.useFakeTimers();
		const fn = vi.fn();
		const { rerender } = renderHook((p: { on: boolean }) => usePolling(fn, 100, p.on), {
			initialProps: { on: true },
		});
		await vi.advanceTimersByTimeAsync(250);
		expect(fn).toHaveBeenCalledTimes(2);
		rerender({ on: false });
		await vi.advanceTimersByTimeAsync(500);
		expect(fn).toHaveBeenCalledTimes(2);
	});
});
