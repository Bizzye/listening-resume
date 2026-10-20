import { type RefObject, useEffect, useRef, useState } from "react";
import { useStore } from "../../store";

/** Editable path input that commits on blur / Enter (Escape reverts). */
export function DirInput({
	value,
	onCommit,
	testId,
	label,
	inputRef,
}: {
	value: string;
	onCommit: (v: string) => void;
	testId: string;
	label: string;
	inputRef?: RefObject<HTMLInputElement | null>;
}) {
	const [draft, setDraft] = useState(value);
	useEffect(() => setDraft(value), [value]);
	const commit = () => {
		const v = draft.trim();
		if (v && v !== value) onCommit(v);
		else setDraft(value);
	};
	return (
		<input
			ref={inputRef}
			className="inp mono"
			style={{ flex: 1, fontSize: 12 }}
			aria-label={label}
			data-testid={testId}
			value={draft}
			onChange={(e) => setDraft(e.target.value)}
			onBlur={commit}
			onKeyDown={(e) => {
				if (e.key === "Enter") e.currentTarget.blur();
				if (e.key === "Escape") setDraft(value);
			}}
		/>
	);
}

/**
 * "Escolher pasta…": the shell has no native folder dialog wired yet (needs
 * tauri-plugin-dialog), so this focuses the path field for typing/pasting.
 */
export function usePickFolder() {
	const ref = useRef<HTMLInputElement>(null);
	const pop = useStore((s) => s.pop);
	const pick = () => {
		ref.current?.focus();
		ref.current?.select();
		pop("Digite ou cole o caminho da pasta no campo ao lado", "ac");
	};
	return { ref, pick };
}
