import { useRef } from "react";
import { Spinner } from "../../shared/ui/Feedback";
import { useStore } from "../../store";

/** "Importar arquivo": picks any audio/video file and posts it to /sessions/import. */
export function ImportButton() {
	const input = useRef<HTMLInputElement>(null);
	const importFile = useStore((s) => s.importFile);
	const importing = useStore((s) => s.importing);
	return (
		<>
			<button
				type="button"
				className="btn2"
				data-testid="import-button"
				disabled={importing}
				aria-busy={importing}
				onClick={() => input.current?.click()}
			>
				{importing ? (
					<>
						<Spinner />
						Importando…
					</>
				) : (
					"Importar arquivo"
				)}
			</button>
			<input
				ref={input}
				type="file"
				accept="audio/*,video/*"
				hidden
				data-testid="import-input"
				onChange={(e) => {
					const file = e.target.files?.[0];
					e.target.value = "";
					if (file) void importFile(file);
				}}
			/>
		</>
	);
}
