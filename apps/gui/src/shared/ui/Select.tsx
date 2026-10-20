import type { CSSProperties } from "react";

export interface SelectOption {
	value: string;
	label: string;
}

interface SelectProps {
	value: string;
	options: SelectOption[];
	onChange: (value: string) => void;
	label: string;
	className?: string;
	style?: CSSProperties;
	testId?: string;
	disabled?: boolean;
	onFocus?: () => void;
}

/** Native select styled as the design input (`.inp`). `label` is the accessible name. */
export function Select({
	value,
	options,
	onChange,
	label,
	className,
	style,
	testId,
	disabled,
	onFocus,
}: SelectProps) {
	return (
		<select
			className={className ? `inp ${className}` : "inp"}
			style={style}
			value={value}
			aria-label={label}
			data-testid={testId}
			disabled={disabled}
			onChange={(e) => onChange(e.target.value)}
			onFocus={onFocus}
		>
			{options.map((o) => (
				<option key={o.value} value={o.value}>
					{o.label}
				</option>
			))}
		</select>
	);
}
