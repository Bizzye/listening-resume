import { useStore } from "../../store";

/** "Nova gravação" (dashboard / sessões header). */
export function NewRecordingButton() {
	const start = useStore((s) => s.startRecording);
	const pending = useStore((s) => s.recordingPending);
	return (
		<button
			type="button"
			className="btn"
			data-testid="new-recording-button"
			disabled={pending}
			onClick={() => void start()}
		>
			<span className="recdot" style={{ background: "#fff" }} />
			Nova gravação
		</button>
	);
}
