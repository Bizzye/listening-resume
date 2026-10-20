import type { CSSProperties, ReactNode } from "react";

export function Spinner() {
	return <span className="spin" aria-hidden="true" />;
}

export function Skeleton({
	width,
	height = 13,
}: {
	width: CSSProperties["width"];
	height?: number;
}) {
	return <div className="sk" style={{ width, height }} />;
}

export function ProgressBar() {
	return (
		<div className="prog" role="progressbar" aria-busy="true">
			<div className="prog-f" />
		</div>
	);
}

/** Dashed empty state (`.empty`). */
export function EmptyState({
	title,
	children,
	action,
	style,
	testId,
}: {
	title: string;
	children?: ReactNode;
	action?: ReactNode;
	style?: CSSProperties;
	testId?: string;
}) {
	return (
		<div className="empty" style={style} data-testid={testId}>
			<span className="fw6 fs14" style={{ color: "var(--tx)" }}>
				{title}
			</span>
			{children ? <span className="fs13">{children}</span> : null}
			{action}
		</div>
	);
}
