import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { useStore } from "../../src/store";

const initialState = useStore.getState();

// jsdom does not implement media playback: fake play/pause/paused.
const playing = new WeakSet<HTMLMediaElement>();
Object.defineProperty(HTMLMediaElement.prototype, "paused", {
	configurable: true,
	get(this: HTMLMediaElement) {
		return !playing.has(this);
	},
});
Object.defineProperty(HTMLMediaElement.prototype, "play", {
	configurable: true,
	writable: true,
	value: vi.fn(function (this: HTMLMediaElement) {
		playing.add(this);
		this.dispatchEvent(new Event("play"));
		return Promise.resolve();
	}),
});
Object.defineProperty(HTMLMediaElement.prototype, "pause", {
	configurable: true,
	writable: true,
	value: vi.fn(function (this: HTMLMediaElement) {
		playing.delete(this);
		this.dispatchEvent(new Event("pause"));
	}),
});

beforeEach(() => {
	useStore.setState(initialState, true);
});

afterEach(() => {
	cleanup();
	useStore.getState().dismissToast();
	vi.unstubAllGlobals();
	vi.useRealTimers();
	try {
		localStorage.clear();
	} catch {
		// ignore
	}
});
