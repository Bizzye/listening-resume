import {
	type CSSProperties,
	type KeyboardEvent,
	type ReactNode,
	useEffect,
	useId,
	useRef,
} from "react";

interface ModalProps {
	title: ReactNode;
	onClose: () => void;
	children: ReactNode;
	style?: CSSProperties;
	testId?: string;
	/** Rendered next to the title (e.g. a "Fechar" button). */
	headerAside?: ReactNode;
}

const FOCUSABLE =
	'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
	return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
}

/**
 * Design modal (`.mbg` backdrop + `.mdl card`). Focus moves into the dialog on open, Tab is
 * trapped inside it, Escape (handled on the dialog itself) and backdrop click close it, and
 * focus returns to whatever was focused before. Key events still bubble, so app-wide
 * shortcuts (Ctrl+Shift+R) keep working while it is open.
 */
export function Modal({ title, onClose, children, style, testId, headerAside }: ModalProps) {
	const titleId = useId();
	const dialog = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const previous = document.activeElement as HTMLElement | null;
		const el = dialog.current;
		if (el && !el.contains(document.activeElement)) {
			// Prefer a form field, else the first control, else the dialog itself.
			const first =
				el.querySelector<HTMLElement>("input:not([disabled]), textarea:not([disabled])") ??
				focusables(el)[0] ??
				el;
			first.focus();
		}
		return () => {
			if (previous?.isConnected) previous.focus();
		};
	}, []);

	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		if (e.key === "Escape") {
			e.preventDefault();
			onClose();
			return;
		}
		if (e.key !== "Tab" || !dialog.current) return;
		const items = focusables(dialog.current);
		if (!items.length) {
			e.preventDefault();
			return;
		}
		const first = items[0];
		const last = items[items.length - 1];
		const active = document.activeElement;
		if (e.shiftKey && (active === first || active === dialog.current)) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && active === last) {
			e.preventDefault();
			first.focus();
		}
	};

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-close; the dialog handles keys
		// biome-ignore lint/a11y/useKeyWithClickEvents: keyboard close is Escape on the dialog
		<div className="mbg" onClick={onClose}>
			<div
				ref={dialog}
				className="mdl card"
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				tabIndex={-1}
				data-testid={testId}
				style={style}
				onClick={(e) => e.stopPropagation()}
				onKeyDown={onKeyDown}
			>
				{headerAside ? (
					<div className="fx jb ac">
						<h2 className="h2" id={titleId} style={{ fontSize: 17 }}>
							{title}
						</h2>
						{headerAside}
					</div>
				) : (
					<h2 className="h2" id={titleId} style={{ fontSize: 17 }}>
						{title}
					</h2>
				)}
				{children}
			</div>
		</div>
	);
}
