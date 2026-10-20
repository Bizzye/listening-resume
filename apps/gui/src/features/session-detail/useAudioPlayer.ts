import { useCallback, useEffect, useState } from "react";

export interface AudioPlayer {
	/** Callback ref for the <audio> element (it may mount after the hook's owner). */
	audioRef: (el: HTMLAudioElement | null) => void;
	playing: boolean;
	time: number;
	duration: number;
	toggle: () => void;
	/** Seeks to `t` seconds and (by default) starts playing — design `scrubTap` / `seek`. */
	seek: (t: number, play?: boolean) => void;
	/** The audio could not be loaded/decoded. */
	error: boolean;
}

/**
 * State around a real <audio> element (src = /sessions/:id/audio, served with HTTP Range).
 * Owned by the detail page, so playback and position survive switching tabs.
 */
export function useAudioPlayer(fallbackDuration: number): AudioPlayer {
	const [audio, setAudio] = useState<HTMLAudioElement | null>(null);
	const [playing, setPlaying] = useState(false);
	const [time, setTime] = useState(0);
	const [mediaDuration, setMediaDuration] = useState(0);
	const [error, setError] = useState(false);

	useEffect(() => {
		const a = audio;
		if (!a) return;
		const onTime = () => setTime(a.currentTime);
		const onPlay = () => setPlaying(true);
		const onPause = () => setPlaying(false);
		const onMeta = () => {
			setMediaDuration(Number.isFinite(a.duration) ? a.duration : 0);
			setError(false);
		};
		const onError = () => {
			setError(true);
			setPlaying(false);
		};
		a.addEventListener("timeupdate", onTime);
		a.addEventListener("seeked", onTime);
		a.addEventListener("play", onPlay);
		a.addEventListener("pause", onPause);
		a.addEventListener("ended", onPause);
		a.addEventListener("loadedmetadata", onMeta);
		a.addEventListener("durationchange", onMeta);
		a.addEventListener("error", onError);
		return () => {
			a.pause();
			a.removeEventListener("timeupdate", onTime);
			a.removeEventListener("seeked", onTime);
			a.removeEventListener("play", onPlay);
			a.removeEventListener("pause", onPause);
			a.removeEventListener("ended", onPause);
			a.removeEventListener("loadedmetadata", onMeta);
			a.removeEventListener("durationchange", onMeta);
			a.removeEventListener("error", onError);
		};
	}, [audio]);

	const play = useCallback(() => {
		if (!audio || error) return;
		const p = audio.play();
		if (p && typeof p.catch === "function") p.catch(() => setPlaying(false));
	}, [audio, error]);

	const toggle = useCallback(() => {
		if (!audio) return;
		if (audio.paused) play();
		else audio.pause();
	}, [audio, play]);

	const seek = useCallback(
		(t: number, andPlay = true) => {
			if (!audio || error) return;
			const target = Math.max(0, t);
			audio.currentTime = target;
			setTime(target);
			if (andPlay) play();
		},
		[audio, error, play],
	);

	return {
		audioRef: setAudio,
		playing,
		time,
		duration: mediaDuration || fallbackDuration,
		toggle,
		seek,
		error,
	};
}
