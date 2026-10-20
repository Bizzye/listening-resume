interface SwitchProps {
	checked: boolean;
	onChange: (next: boolean) => void;
	label: string;
	testId?: string;
	disabled?: boolean;
}

/** Design toggle (`.sw`). */
export function Switch({ checked, onChange, label, testId, disabled }: SwitchProps) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={label}
			data-testid={testId}
			disabled={disabled}
			className={checked ? "sw on" : "sw"}
			onClick={() => onChange(!checked)}
		>
			<span className="sw-k" />
		</button>
	);
}
