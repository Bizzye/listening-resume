import type { SessionStatus } from "../api/types";
import { statusBadge } from "../lib/status";

export function StatusBadge({ status }: { status: SessionStatus }) {
	const b = statusBadge(status);
	return (
		<span className={b.cls} data-testid="status-badge" data-status={status}>
			<span className={b.dotCls} />
			{b.label}
		</span>
	);
}
