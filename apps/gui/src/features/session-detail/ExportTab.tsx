import { useState } from "react";
import type { ExportFormat, SessionSummary } from "../../shared/api/types";
import { DirInput, usePickFolder } from "../../shared/ui/DirInput";
import { useStore } from "../../store";

const CARDS: { format: ExportFormat; mk: string; name: string; desc: string }[] = [
	{
		format: "md",
		mk: "MD",
		name: "Markdown",
		desc: "Transcrição + análises em um único .md, pronto para o Obsidian.",
	},
	{
		format: "pdf",
		mk: "PDF",
		name: "PDF",
		desc: "Documento formatado com timestamps e seções da análise.",
	},
	{ format: "docx", mk: "DOCX", name: "Word", desc: "Ata editável para compartilhar com o time." },
];

export function ExportTab({ s }: { s: SessionSummary }) {
	const globalDir = useStore((st) => st.settings?.exportDir ?? "");
	const { setSessionExportDir, exportSession } = useStore.getState();
	const [busy, setBusy] = useState<ExportFormat | null>(null);
	const folder = usePickFolder();
	const override = !!s.exportDir;
	const dir = s.exportDir || globalDir;

	return (
		<>
			<div
				className="card"
				style={{
					padding: "16px 18px",
					marginBottom: 14,
					display: "flex",
					flexDirection: "column",
					gap: 12,
				}}
			>
				<div
					style={{
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						gap: 12,
					}}
				>
					<div style={{ display: "flex", alignItems: "center", gap: 10 }}>
						<span className="fw6 fs13">Destino do export</span>
						{override ? (
							<span className="bdg st-ac" data-testid="export-dir-badge">
								Só nesta sessão
							</span>
						) : (
							<span className="bdg st-n" data-testid="export-dir-badge">
								Padrão global
							</span>
						)}
					</div>
					{override ? (
						<button
							type="button"
							className="ghost"
							style={{ fontSize: 12 }}
							data-testid="export-dir-reset"
							onClick={() => void setSessionExportDir(s.id, null)}
						>
							Voltar ao padrão global
						</button>
					) : null}
				</div>
				<div style={{ display: "flex", gap: 8 }}>
					<DirInput
						value={dir}
						label="Pasta de export desta sessão"
						testId="export-dir-input"
						inputRef={folder.ref}
						onCommit={(v) => void setSessionExportDir(s.id, v === globalDir ? null : v)}
					/>
					<button
						type="button"
						className="btn2"
						style={{ padding: "8px 12px" }}
						data-testid="export-dir-pick"
						onClick={folder.pick}
					>
						Escolher pasta…
					</button>
				</div>
				<span className="hint">
					Alterar aqui sobrescreve a pasta padrão só para esta sessão. O padrão global fica em
					Configurações → Export.
				</span>
			</div>
			<div className="grid2">
				{CARDS.map((c) => (
					<div key={c.format} className="card exp">
						<div className="exp-mk">{c.mk}</div>
						<div>
							<div className="fw6 fs14">{c.name}</div>
							<div className="set-d">{c.desc}</div>
						</div>
						<button
							type="button"
							className="btn2"
							data-testid={`export-${c.format}`}
							disabled={busy !== null}
							onClick={async () => {
								setBusy(c.format);
								await exportSession(s.id, c.format);
								setBusy(null);
							}}
						>
							{busy === c.format ? "Exportando…" : `Exportar .${c.format}`}
						</button>
					</div>
				))}
				<div className="card exp">
					<div className="exp-mk">APKG</div>
					<div>
						<div className="fw6 fs14">Anki</div>
						<div className="set-d">Flashcards desta sessão, prontos para importar no Anki.</div>
					</div>
					<button type="button" className="btn2" disabled data-testid="export-apkg">
						Em breve
					</button>
				</div>
			</div>
		</>
	);
}
