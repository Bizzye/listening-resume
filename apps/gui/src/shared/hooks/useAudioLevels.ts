import { useEffect, useRef, useState } from "react";
import { type CaptureWarning, type LevelsStreamOptions, openLevelsStream } from "../api/sse";
import type { AudioLevels, ResolvedDevices } from "../api/types";
import { useLatest } from "./useLatest";

/** Levels older than this are treated as silence (stream stalled / reconnecting). */
export const STALE_LEVELS_MS = 500;

export interface UseAudioLevelsOptions {
	system?: string;
	mic?: string | null;
	enabled?: boolean;
	onDevices?: (devices: ResolvedDevices) => void;
	/** `event: ended` — the recording followed by this stream stopped (stream is closed). */
	onEnded?: () => void;
	/** `event: warning` — non-fatal capture problem (e.g. device fallback). */
	onWarning?: (warning: CaptureWarning) => void;
	streamOptions?: LevelsStreamOptions;
}

export interface AudioLevelsHandle {
	/** Latest levels — read from animation frames; never triggers a React render. */
	read: () => AudioLevels;
	connected: boolean;
	/** True once the stream has been open at least once (distinguishes reconnect from connect). */
	hasConnected: boolean;
	/** Set when the server reports `event: unavailable` (no levels on this stream). */
	unavailable: string | null;
	/** The server ended the stream (`event: ended`). */
	ended: boolean;
}

const SILENT: AudioLevels = { system: 0, mic: 0 };

/**
 * Live audio levels over SSE (`GET /audio/levels`). Levels are kept in a ref so 20 updates per
 * second do not re-render; only the connection flags are React state.
 */
export function useAudioLevels(opts: UseAudioLevelsOptions): AudioLevelsHandle {
	const { system, mic, enabled = true } = opts;
	const levels = useRef<{ value: AudioLevels; at: number }>({ value: SILENT, at: 0 });
	const [connected, setConnected] = useState(false);
	const [hasConnected, setHasConnected] = useState(false);
	const [unavailable, setUnavailable] = useState<string | null>(null);
	const [ended, setEnded] = useState(false);
	const onDevices = useLatest(opts.onDevices);
	const onEnded = useLatest(opts.onEnded);
	const onWarning = useLatest(opts.onWarning);
	const streamOptions = useLatest(opts.streamOptions);

	useEffect(() => {
		if (!enabled) return;
		const close = openLevelsStream(
			{ system, mic },
			{
				onLevels: (value) => {
					levels.current = { value, at: Date.now() };
				},
				onDevices: (d) => onDevices.current?.(d),
				onStatus: (open) => {
					setConnected(open);
					if (open) {
						setHasConnected(true);
						setUnavailable(null); // the server re-sends it on a fresh stream if it still applies
					}
				},
				onUnavailable: setUnavailable,
				onWarning: (w) => onWarning.current?.(w),
				onEnded: () => {
					setEnded(true);
					onEnded.current?.();
				},
			},
			streamOptions.current,
		);
		return () => {
			close();
			levels.current = { value: SILENT, at: 0 };
			setConnected(false);
			setHasConnected(false);
			setUnavailable(null);
			setEnded(false);
		};
	}, [system, mic, enabled, onDevices, onEnded, onWarning, streamOptions]);

	const read = useRef(() =>
		Date.now() - levels.current.at > STALE_LEVELS_MS ? SILENT : levels.current.value,
	).current;
	return { read, connected, hasConnected, unavailable, ended };
}
