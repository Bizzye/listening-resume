const SMALL = [7, 13, 17, 10, 6];
const LARGE = [10, 20, 28, 16, 8];

/** Brand mark (`.lmark` with five `.lb` bars). */
export function Logo({ large = false }: { large?: boolean }) {
	const bars = large ? LARGE : SMALL;
	return (
		<div
			className="lmark"
			aria-hidden="true"
			style={large ? { width: 46, height: 46, borderRadius: 13, gap: 3 } : undefined}
		>
			{bars.map((h, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: static decoration
				<span key={i} className="lb" style={{ height: h }} />
			))}
		</div>
	);
}
