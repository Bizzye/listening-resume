import type { MouseEvent } from "react";
import { fmtDuration } from "../../shared/lib/format";
import { Icon } from "../../shared/ui/Icon";
import type { AudioPlayer } from "./useAudioPlayer";

/** Fraction (0..1) of the scrub track under the pointer. */
export function scrubFraction(clientX: number, rect: { left: number; width: number }): number {
	if (!rect.width) return 0;
	return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
}

/** The session's <audio> element — rendered once by the detail page, outside the tabs. */
export function SessionAudio({ player, src }: { player: AudioPlayer; src: string }) {
	return (
		// biome-ignore lint/a11y/useMediaCaption: speech recording; the transcript is the caption
		<audio ref={player.audioRef} src={src} preload="metadata" data-testid="session-audio" />
	);
}

/** Sticky player (design `.player`). */
export function PlayerBar({ player }: { player: AudioPlayer }) {
	const { playing, time, duration, toggle, seek, error } = player;
	const pct = duration > 0 ? Math.min(100, (time / duration) * 100) : 0;
	const onScrub = (e: MouseEvent<HTMLDivElement>) => {
		seek(scrubFraction(e.clientX, e.currentTarget.getBoundingClientRect()) * duration);
	};
	return (
		<div className="player card" data-testid="player">
			<button
				type="button"
				className="pbtn"
				aria-label={playing ? "Pausar" : "Reproduzir"}
				data-testid="play-toggle"
				disabled={error}
				onClick={toggle}
			>
				{playing ? (
					<Icon name="pause" size={13} />
				) : (
					<Icon name="play" size={13} style={{ marginLeft: 2 }} />
				)}
			</button>
			<span className="ptime" data-testid="player-time">
				{fmtDuration(time)}
			</span>
			{error ? (
				<span className="hint f1" role="alert" data-testid="player-error">
					Não foi possível carregar o áudio desta sessão.
				</span>
			) : (
				<div
					className="scrub"
					role="slider"
					tabIndex={0}
					aria-label="Posição do áudio"
					aria-valuemin={0}
					aria-valuemax={Math.round(duration)}
					aria-valuenow={Math.round(time)}
					aria-valuetext={fmtDuration(time)}
					data-testid="scrub"
					onClick={onScrub}
					onKeyDown={(e) => {
						if (e.key === "ArrowRight") seek(Math.min(duration, time + 5), playing);
						else if (e.key === "ArrowLeft") seek(Math.max(0, time - 5), playing);
					}}
				>
					<div className="scrub-t">
						<div className="scrub-f" style={{ width: `${pct.toFixed(2)}%` }} />
					</div>
				</div>
			)}
			<span className="ptime">{fmtDuration(duration)}</span>
		</div>
	);
}
