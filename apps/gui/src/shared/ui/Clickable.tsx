import type { CSSProperties, KeyboardEvent, MouseEvent, ReactNode } from "react";

interface ClickableCardProps {
	className: string;
	onActivate: () => void;
	label: string;
	children: ReactNode;
	style?: CSSProperties;
	testId?: string;
}

/**
 * A card that behaves like a button (click, Enter, Space) with block content inside (which a
 * real <button> cannot hold). It must NOT contain other interactive elements — cards with
 * inner controls (session cards) use a plain container plus a title button instead.
 */
export function ClickableCard({
	className,
	onActivate,
	label,
	children,
	style,
	testId,
}: ClickableCardProps) {
	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		if (e.target !== e.currentTarget) return;
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			onActivate();
		}
	};
	const onClick = (e: MouseEvent<HTMLDivElement>) => {
		if (e.defaultPrevented) return;
		onActivate();
	};
	return (
		// biome-ignore lint/a11y/useSemanticElements: contains nested buttons, so it cannot be a <button>
		<div
			role="button"
			tabIndex={0}
			aria-label={label}
			className={className}
			style={style}
			data-testid={testId}
			onClick={onClick}
			onKeyDown={onKeyDown}
		>
			{children}
		</div>
	);
}
