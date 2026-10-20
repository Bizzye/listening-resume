import type { CSSProperties } from "react";
import { useStore } from "../../store";
import type { AudioDevice } from "../api/types";
import { type DeviceKind, deviceOptions, fromSelectValue, toSelectValue } from "../lib/devices";
import { Select } from "./Select";

interface DeviceSelectProps {
	kind: DeviceKind;
	devices: AudioDevice[];
	/** Device id, SYSTEM_DEFAULT_DEVICE, or null (= no mic). */
	value: string | null;
	onChange: (value: string | null) => void;
	/** Name `@default` currently resolves to (live, from the capture), if known. */
	liveDefaultName?: string | null;
	label: string;
	className?: string;
	style?: CSSProperties;
	testId?: string;
	disabled?: boolean;
}

/**
 * Device picker with "Padrão do sistema (<atual>)" first and "Sem microfone" for mics.
 * Focusing it re-enumerates devices (throttled), so hot-plugged ones show up.
 */
export function DeviceSelect({
	kind,
	devices,
	value,
	onChange,
	liveDefaultName,
	label,
	className,
	style,
	testId,
	disabled,
}: DeviceSelectProps) {
	const refreshDevices = useStore((s) => s.refreshDevices);
	const options = deviceOptions(devices, kind, liveDefaultName);
	const current = toSelectValue(value);
	// Keep an unknown current value (device unplugged / list not loaded yet) selectable.
	if (!options.some((o) => o.value === current)) options.push({ value: current, label: current });
	return (
		<Select
			value={current}
			options={options}
			onChange={(v) => onChange(fromSelectValue(v))}
			label={label}
			className={className}
			style={style}
			testId={testId}
			disabled={disabled}
			onFocus={refreshDevices}
		/>
	);
}
