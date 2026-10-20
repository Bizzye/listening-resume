import { sessionTitle } from "../../shared/lib/session";
import { Modal } from "../../shared/ui/Modal";
import { useStore } from "../../store";

/** "Transcrever de novo?" — shown before replacing an existing transcript. */
export function ConfirmTranscribeModal() {
	const id = useStore((s) => s.confirmTranscribeId);
	const session = useStore((s) =>
		s.confirmTranscribeId ? s.findSession(s.confirmTranscribeId) : undefined,
	);
	const { cancelTranscribe, confirmTranscribe } = useStore.getState();
	if (!id || !session) return null;

	return (
		<Modal
			title="Transcrever novamente?"
			onClose={cancelTranscribe}
			style={{ width: 430 }}
			testId="retranscribe-modal"
		>
			<p className="sub" style={{ marginTop: 8 }}>
				“{sessionTitle(session)}” já tem uma transcrição. Ela será substituída pela nova.
			</p>
			<div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 22 }}>
				<button
					type="button"
					className="btn2"
					data-testid="retranscribe-cancel"
					onClick={cancelTranscribe}
				>
					Cancelar
				</button>
				<button
					type="button"
					className="btn"
					data-testid="retranscribe-confirm"
					onClick={confirmTranscribe}
				>
					Transcrever de novo
				</button>
			</div>
		</Modal>
	);
}
