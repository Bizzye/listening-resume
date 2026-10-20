import { memo, useMemo, useState } from "react";
import type { SessionDetail, SessionSummary, TranscriptSegment } from "../../shared/api/types";
import { DEFAULT_GROQ_WHISPER_MODEL } from "../../shared/lib/core-shared";
import { fmtDuration } from "../../shared/lib/format";
import { EmptyState, ProgressBar, Skeleton, Spinner } from "../../shared/ui/Feedback";
import { useStore } from "../../store";
import { PlayerBar } from "./PlayerBar";
import { meaningfulSegments, segmentViews } from "./transcript";
import type { AudioPlayer } from "./useAudioPlayer";

/** "whisper-large-v3-turbo · pt" / "medium · pt" — what is actually transcribing. */
export function transcribingHint(
	provider: "groq" | "whisper-cpp" | undefined,
	whisperModel: string | undefined,
	language: string | null | undefined,
): string {
	const lang = language?.trim() || "auto";
	return provider === "groq"
		? `${DEFAULT_GROQ_WHISPER_MODEL} · ${lang}`
		: `${whisperModel ?? "medium"} · ${lang}`;
}

function TranscribingCard({ s }: { s: SessionSummary }) {
	const provider = useStore((st) => st.settings?.transcriptionProvider);
	const whisperModel = useStore((st) => st.settings?.whisperModel);
	return (
		<div
			className="card"
			style={{ padding: 22, display: "flex", flexDirection: "column", gap: 14 }}
			data-testid="transcribing"
		>
			<div className="fx ac gap10">
				<Spinner />
				<span className="fw6 fs13">
					{provider === "groq" ? "Transcrevendo com Groq…" : "Transcrevendo com Whisper…"}
				</span>
				<span className="hint" data-testid="transcribing-hint">
					{transcribingHint(provider, whisperModel, s.language)}
				</span>
			</div>
			<ProgressBar />
			<div className="col gap10" style={{ marginTop: 6 }}>
				<Skeleton width="88%" />
				<Skeleton width="72%" />
				<Skeleton width="80%" />
				<Skeleton width="56%" />
			</div>
		</div>
	);
}

function FailedCard({ s }: { s: SessionSummary }) {
	const transcribe = useStore((st) => st.transcribe);
	return (
		<div className="errc" data-testid="transcription-failed">
			<span className="bdg st-err">
				<span className="dt" />
				Falhou
			</span>
			<span className="fw6 fs14">A transcrição falhou</span>
			<span className="fs13" style={{ color: "var(--tx2)", maxWidth: 420 }}>
				{s.lastError ||
					"Não foi possível transcrever este áudio. Verifique as configurações e tente novamente."}
			</span>
			<button
				type="button"
				className="btn2"
				style={{ marginTop: 6 }}
				data-testid="retry-transcription"
				onClick={() => void transcribe(s.id)}
			>
				Tentar novamente
			</button>
		</div>
	);
}

/** One transcript row. Memoized: playback only re-renders the rows whose class changes. */
const SegmentRow = memo(function SegmentRow({
	seg,
	cls,
	onSeek,
}: {
	seg: TranscriptSegment;
	cls: string;
	onSeek: (t: number) => void;
}) {
	return (
		<button type="button" className={cls} data-testid="segment" onClick={() => onSeek(seg.start)}>
			<span className="seg-t">{fmtDuration(seg.start)}</span>
			<span className="seg-x">{seg.text.trim()}</span>
		</button>
	);
});

function TranscriptView({
	segments,
	player,
}: {
	segments: TranscriptSegment[];
	player: AudioPlayer;
}) {
	const [query, setQuery] = useState("");
	const { views, count } = segmentViews(segments, player.time, query);
	const { seek } = player;
	return (
		<>
			<PlayerBar player={player} />
			<div className="fx ac gap10" style={{ margin: "18px 2px 8px" }}>
				<input
					className="inp f1"
					placeholder="Buscar na transcrição…"
					aria-label="Buscar na transcrição"
					data-testid="transcript-search"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
				/>
				<span className="hint mono nowrap" data-testid="segment-count">
					{count}
				</span>
			</div>
			<div className="col" data-testid="segments">
				{views.map(({ seg, cls }, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: segments may share start times; order is fixed
					<SegmentRow key={`${i}-${seg.start}`} seg={seg} cls={cls} onSeek={seek} />
				))}
			</div>
		</>
	);
}

export function TranscriptTab({
	s,
	detail,
	player,
}: {
	s: SessionSummary;
	detail: SessionDetail | undefined;
	/** Null when the session has no audio to play. */
	player: AudioPlayer | null;
}) {
	const requestTranscribe = useStore((st) => st.requestTranscribe);
	// Auto-transcription was requested on stop/import but the server has not picked it up yet.
	const starting = useStore(
		(st) =>
			s.status === "stopped" &&
			!s.lastError &&
			(s.chunks > 0 || s.duration > 0) &&
			!!st.settings?.autoTranscribe &&
			(st.expectBusyUntil[s.id] ?? 0) > Date.now(),
	);
	const transcript = detail?.transcript ?? null;
	const segments = useMemo(
		() => (transcript ? meaningfulSegments(transcript.segments) : []),
		[transcript],
	);

	if (s.status === "transcribing" || starting) return <TranscribingCard s={s} />;
	if (!detail) {
		return (
			<div className="col gap10" data-testid="detail-loading">
				<Skeleton width="80%" />
				<Skeleton width="64%" />
			</div>
		);
	}
	if (segments.length && player) return <TranscriptView segments={segments} player={player} />;
	if (s.status === "recording") {
		return (
			<EmptyState title="Gravação em andamento">
				A transcrição fica disponível quando a gravação terminar.
			</EmptyState>
		);
	}
	// Failed jobs: status "failed", or back to "stopped" with lastError (auto-transcribe).
	const failed = !transcript && (s.status === "failed" || !!s.lastError);
	return (
		<>
			{player ? <PlayerBar player={player} /> : null}
			{failed ? (
				<div style={{ marginTop: player ? 16 : 0 }}>
					<FailedCard s={s} />
				</div>
			) : transcript ? (
				<EmptyState title="Nenhuma fala detectada nesta gravação" style={{ marginTop: 16 }}>
					O áudio não contém conteúdo de voz identificável.
				</EmptyState>
			) : (
				<EmptyState
					title="Ainda não transcrita"
					style={{ marginTop: 16 }}
					testId="not-transcribed"
					action={
						<button
							type="button"
							className="btn"
							style={{ marginTop: 8 }}
							disabled={!player}
							onClick={() => requestTranscribe(s.id)}
						>
							Transcrever
						</button>
					}
				>
					{player
						? "Transcreva para ler, buscar e analisar esta sessão."
						: "Nenhum áudio capturado nesta sessão."}
				</EmptyState>
			)}
		</>
	);
}
