import type { ReactNode, SVGProps } from "react";

// Inline SVG icons copied from the design markup. Decorative: always aria-hidden.

export type IconName =
	| "dashboard"
	| "sessions"
	| "templates"
	| "settings"
	| "speaker"
	| "mic"
	| "pencil"
	| "transcribe"
	| "sparkle"
	| "download"
	| "trash"
	| "play"
	| "pause"
	| "check";

interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
	name: IconName;
	size?: number;
}

const STROKE = {
	fill: "none",
	stroke: "currentColor",
	strokeLinecap: "round",
	strokeLinejoin: "round",
} as const;

const PATHS: Record<IconName, { attrs: SVGProps<SVGSVGElement>; body: ReactNode }> = {
	dashboard: {
		attrs: { fill: "none", stroke: "currentColor", strokeWidth: 2 },
		body: (
			<>
				<rect x="3" y="3" width="7" height="7" rx="1.5" />
				<rect x="14" y="3" width="7" height="7" rx="1.5" />
				<rect x="3" y="14" width="7" height="7" rx="1.5" />
				<rect x="14" y="14" width="7" height="7" rx="1.5" />
			</>
		),
	},
	sessions: {
		attrs: { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" },
		body: <path d="M4 6h16M4 12h16M4 18h10" />,
	},
	templates: {
		attrs: { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" },
		body: (
			<>
				<rect x="4" y="3" width="16" height="18" rx="2" />
				<path d="M8 8h8M8 12h8M8 16h5" />
			</>
		),
	},
	settings: {
		attrs: { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" },
		body: (
			<>
				<path d="M4 7h8M18 7h2M4 17h2M12 17h8" />
				<circle cx="15" cy="7" r="2.5" />
				<circle cx="9" cy="17" r="2.5" />
			</>
		),
	},
	speaker: {
		attrs: { ...STROKE, strokeWidth: 1.8 },
		body: (
			<>
				<path d="M4 9.5v5h3.5L13 19V5L7.5 9.5H4z" />
				<path d="M16.5 9a5 5 0 0 1 0 6" />
			</>
		),
	},
	mic: {
		attrs: { ...STROKE, strokeWidth: 1.8 },
		body: (
			<>
				<rect x="9" y="3" width="6" height="11" rx="3" />
				<path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" />
			</>
		),
	},
	pencil: {
		attrs: { ...STROKE, strokeWidth: 2 },
		body: (
			<>
				<path d="M4 20h4L19 9l-4-4L4 16v4z" />
				<path d="M13.5 6.5l4 4" />
			</>
		),
	},
	transcribe: {
		attrs: { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" },
		body: <path d="M4 7h16M4 12h10M4 17h13" />,
	},
	sparkle: {
		attrs: { ...STROKE, strokeWidth: 2 },
		body: <path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" />,
	},
	download: {
		attrs: { ...STROKE, strokeWidth: 2 },
		body: <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />,
	},
	trash: {
		attrs: { ...STROKE, strokeWidth: 2 },
		body: <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />,
	},
	play: { attrs: { fill: "currentColor" }, body: <path d="M8 5v14l11-7z" /> },
	pause: {
		attrs: { fill: "currentColor" },
		body: (
			<>
				<rect x="6" y="5" width="4" height="14" rx="1" />
				<rect x="14" y="5" width="4" height="14" rx="1" />
			</>
		),
	},
	check: {
		attrs: { ...STROKE, strokeWidth: 2.5 },
		body: <path d="M4 12.5l5 5L20 6.5" />,
	},
};

export function Icon({ name, size = 16, ...rest }: IconProps) {
	const { attrs, body } = PATHS[name];
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			aria-hidden="true"
			focusable="false"
			{...attrs}
			{...rest}
		>
			{body}
		</svg>
	);
}
