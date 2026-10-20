import { type AudioDevice, SYSTEM_DEFAULT_DEVICE } from "../api/types";

export type DeviceKind = "system" | "mic";

/** Select value for "no microphone" (maps to `null` on the wire). */
export const NO_MIC = "none";

export interface DeviceOption {
	value: string;
	label: string;
}

const LOOPBACK_SUFFIX = /\s*\(Loopback\)$/i;

/**
 * Human device name: WASAPI enumerates render endpoints as "<name> (Loopback)", while the
 * capture reports the plain friendly name — show both the same way.
 */
export function displayDeviceName(name: string): string {
	return name.replace(LOOPBACK_SUFFIX, "") || name;
}

export function devicesOfKind(devices: AudioDevice[], kind: DeviceKind): AudioDevice[] {
	return devices.filter((d) =>
		kind === "system" ? d.type === "monitor" : d.type === "microphone",
	);
}

export function defaultDeviceName(devices: AudioDevice[], kind: DeviceKind): string | null {
	const name = devicesOfKind(devices, kind).find((d) => d.isDefault)?.name;
	return name ? displayDeviceName(name) : null;
}

/** "Padrão do sistema (<nome atual>)" — or just "Padrão do sistema" when unknown. */
export function systemDefaultLabel(name: string | null | undefined): string {
	return name ? `Padrão do sistema (${displayDeviceName(name)})` : "Padrão do sistema";
}

/**
 * Options for a device picker: "Padrão do sistema (<current default>)" first, then the real
 * devices, then "Sem microfone" for the mic picker. `liveDefaultName` (the name the capture
 * actually resolved `@default` to) wins over the enumerated default when known.
 */
export function deviceOptions(
	devices: AudioDevice[],
	kind: DeviceKind,
	liveDefaultName?: string | null,
): DeviceOption[] {
	const list = devicesOfKind(devices, kind);
	const opts: DeviceOption[] = [
		{
			value: SYSTEM_DEFAULT_DEVICE,
			label: systemDefaultLabel(liveDefaultName || defaultDeviceName(devices, kind)),
		},
		...list.map((d) => ({ value: d.id, label: displayDeviceName(d.name) })),
	];
	if (kind === "mic") opts.push({ value: NO_MIC, label: "Sem microfone" });
	return opts;
}

/**
 * The device actually recording when it is NOT the one requested — a named device that is
 * missing/unplugged, so the capture fell back to the system default (it switches back by
 * itself when the device returns). `null` when the requested device (or `@default` / no mic)
 * is what is open, or nothing is known yet.
 */
export function fallbackDeviceName(
	requested: string | null | undefined,
	liveName: string | null | undefined,
): string | null {
	if (!requested || requested === SYSTEM_DEFAULT_DEVICE || !liveName) return null;
	const norm = (s: string) => displayDeviceName(s).trim().toLowerCase();
	return norm(requested) === norm(liveName) ? null : displayDeviceName(liveName);
}

export const toSelectValue = (v: string | null | undefined): string => v ?? NO_MIC;
export const fromSelectValue = (v: string): string | null => (v === NO_MIC ? null : v);

/** Short human label used in toasts ("Padrão do sistema", device name, "Sem microfone"). */
export function deviceLabel(devices: AudioDevice[], value: string | null): string {
	if (value === null) return "Sem microfone";
	if (value === SYSTEM_DEFAULT_DEVICE) return "Padrão do sistema";
	return displayDeviceName(devices.find((d) => d.id === value)?.name ?? value);
}
