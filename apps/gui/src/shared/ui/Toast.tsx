import { useStore } from "../../store";

/** Single toast at the bottom-right (design `.toast`). */
export function ToastHost() {
	const toast = useStore((s) => s.toast);
	if (!toast) return null;
	return (
		<div
			key={toast.id}
			className="toast"
			role="status"
			aria-live="polite"
			data-testid="toast"
			data-kind={toast.kind}
		>
			<span className={`tdot k-${toast.kind}`} />
			{toast.msg}
		</div>
	);
}
