import { useState } from "react";
import { sessionTitle } from "../../shared/lib/session";
import { Modal } from "../../shared/ui/Modal";
import { useStore } from "../../store";

export function DeleteSessionModal() {
	const deleteId = useStore((s) => s.deleteId);
	const session = useStore((s) => (s.deleteId ? s.findSession(s.deleteId) : undefined));
	const { cancelDelete, deleteSession } = useStore.getState();
	const [busy, setBusy] = useState(false);
	if (!deleteId || !session) return null;

	return (
		<Modal
			title="Apagar sessão?"
			onClose={cancelDelete}
			style={{ width: 430 }}
			testId="delete-modal"
		>
			<p className="sub" style={{ marginTop: 8 }}>
				“{sessionTitle(session)}” — áudio, transcrição e análises serão removidos deste computador.
				Não dá para desfazer.
			</p>
			<div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 22 }}>
				<button type="button" className="btn2" data-testid="delete-cancel" onClick={cancelDelete}>
					Cancelar
				</button>
				<button
					type="button"
					className="btn"
					style={{ background: "var(--red)", boxShadow: "none" }}
					data-testid="delete-confirm"
					disabled={busy}
					onClick={async () => {
						setBusy(true);
						await deleteSession(deleteId);
						setBusy(false);
					}}
				>
					Apagar sessão
				</button>
			</div>
		</Modal>
	);
}
