import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
	RecordingScreen,
	recordingSourceLabel,
} from "../../src/features/recording/RecordingScreen";
import {
	deviceLabel,
	deviceOptions,
	displayDeviceName,
	fallbackDeviceName,
} from "../../src/shared/lib/devices";
import { DeviceSelect } from "../../src/shared/ui/DeviceSelect";
import { ToastHost } from "../../src/shared/ui/Toast";
import { useStore } from "../../src/store";
import type { ActiveRecording } from "../../src/store/slices/recording";
import {
	DEVICES,
	FakeEventSource,
	installFakeEventSource,
	installManualRaf,
	makeHealth,
	makeSettings,
	mockFetch,
} from "./helpers";

describe("device options", () => {
	it("puts 'Padrão do sistema (<atual>)' first, then devices, then 'Sem microfone'", () => {
		// Labels drop WASAPI's " (Loopback)" suffix; values stay the real ids.
		expect(deviceOptions(DEVICES, "system")).toEqual([
			{ value: "@default", label: "Padrão do sistema (Alto-falantes (Realtek))" },
			{ value: "Alto-falantes (Realtek) (Loopback)", label: "Alto-falantes (Realtek)" },
			{ value: "Fone Bluetooth (Loopback)", label: "Fone Bluetooth" },
		]);
		expect(deviceOptions(DEVICES, "system", "Fone Bluetooth (Loopback)")[0].label).toBe(
			"Padrão do sistema (Fone Bluetooth)",
		);
		const mic = deviceOptions(DEVICES, "mic", "Headset");
		expect(mic[0]).toEqual({ value: "@default", label: "Padrão do sistema (Headset)" });
		expect(mic.at(-1)).toEqual({ value: "none", label: "Sem microfone" });
		expect(deviceOptions([], "system")[0].label).toBe("Padrão do sistema");
	});
	it("labels values for toasts", () => {
		expect(deviceLabel(DEVICES, null)).toBe("Sem microfone");
		expect(deviceLabel(DEVICES, "@default")).toBe("Padrão do sistema");
		expect(deviceLabel(DEVICES, "Microfone USB")).toBe("Microfone USB");
		expect(deviceLabel(DEVICES, "Fone Bluetooth (Loopback)")).toBe("Fone Bluetooth");
		expect(displayDeviceName("Saída (Loopback)")).toBe("Saída");
		expect(displayDeviceName("Loopback")).toBe("Loopback");
	});
});

describe("fallbackDeviceName", () => {
	it("returns the live name only when a named device is not the one open", () => {
		expect(fallbackDeviceName("Fone Bluetooth (Loopback)", "Alto-falantes (Realtek)")).toBe(
			"Alto-falantes (Realtek)",
		);
		expect(fallbackDeviceName("Microfone USB", "Microfone (Realtek) (Loopback)")).toBe(
			"Microfone (Realtek)",
		);
	});

	it("is null for the requested device (any case / Loopback suffix), @default, no mic or unknown", () => {
		expect(fallbackDeviceName("Fone Bluetooth (Loopback)", "fone bluetooth")).toBeNull();
		expect(fallbackDeviceName("@default", "Alto-falantes")).toBeNull();
		expect(fallbackDeviceName(null, "Microfone USB")).toBeNull();
		expect(fallbackDeviceName(undefined, undefined)).toBeNull();
		expect(fallbackDeviceName("Microfone USB", null)).toBeNull();
	});
});

describe("DeviceSelect", () => {
	it("renders the options and maps 'Sem microfone' to null", () => {
		const onChange = vi.fn();
		render(
			<DeviceSelect
				kind="mic"
				label="Microfone"
				devices={DEVICES}
				value="@default"
				onChange={onChange}
				testId="sel"
			/>,
		);
		const sel = screen.getByTestId("sel") as HTMLSelectElement;
		const labels = Array.from(sel.options).map((o) => o.text);
		expect(labels).toEqual([
			"Padrão do sistema (Microfone USB)",
			"Microfone USB",
			"Microfone interno",
			"Sem microfone",
		]);
		expect(sel.value).toBe("@default");
		fireEvent.change(sel, { target: { value: "none" } });
		expect(onChange).toHaveBeenLastCalledWith(null);
		fireEvent.change(sel, { target: { value: "Microfone interno" } });
		expect(onChange).toHaveBeenLastCalledWith("Microfone interno");
	});
	it("re-enumerates devices when focused (hot-plug), throttled", async () => {
		const f = mockFetch([["GET", "/devices", { devices: DEVICES }]]);
		render(
			<DeviceSelect
				kind="system"
				label="Saída"
				devices={[]}
				value="@default"
				onChange={vi.fn()}
				testId="sel"
			/>,
		);
		const sel = screen.getByTestId("sel");
		fireEvent.focus(sel);
		fireEvent.focus(sel);
		await vi.waitFor(() => expect(useStore.getState().devices).toEqual(DEVICES));
		expect(f.to("GET", "/devices")).toHaveLength(1);
	});

	it("keeps an unknown current device selectable", () => {
		render(
			<DeviceSelect
				kind="system"
				label="Saída"
				devices={DEVICES}
				value="Velho"
				onChange={vi.fn()}
				testId="sel"
			/>,
		);
		expect((screen.getByTestId("sel") as HTMLSelectElement).value).toBe("Velho");
	});
});

const baseRec = (over: Partial<ActiveRecording> = {}): ActiveRecording => ({
	sessionId: "r1",
	startTime: Date.now() - 65_000,
	chunks: 2,
	devices: {
		system: "@default",
		mic: "@default",
		systemName: "Alto-falantes (Realtek) (Loopback)",
		micName: "Microfone USB",
	},
	muted: { system: false, mic: false },
	...over,
});

function setup(rec = baseRec(), settings = makeSettings()) {
	installFakeEventSource();
	const raf = installManualRaf();
	const f = mockFetch([
		["POST", "/recording/mute", (c) => c.body],
		[
			"POST",
			"/recording/stop",
			{
				session: { id: "r1", status: "stopped", title: null, createdAt: "2026-10-11T10:00:00" },
				chunks: 3,
			},
		],
		["POST", "/recording/discard", { ok: true }],
		[
			"POST",
			"/recording/devices",
			(c) => ({
				devices: {
					...rec.devices,
					mic: (c.body as { micDevice: string }).micDevice,
					micName: "Microfone interno",
				},
			}),
		],
		["GET", "/recording/status", { recording: true, ...rec }],
		["GET", /^\/sessions\?/, { sessions: [] }],
		["GET", "/devices", { devices: DEVICES }],
	]);
	useStore.setState({ settings, devices: DEVICES, recording: rec });
	const Wrapper = () => {
		const r = useStore((s) => s.recording);
		return (
			<>
				{r ? <RecordingScreen recording={r} /> : <div>idle</div>}
				<ToastHost />
			</>
		);
	};
	render(<Wrapper />);
	return { f, raf };
}

describe("RecordingScreen", () => {
	it("shows the timer from the server start time, the chunk and the resolved sources", () => {
		setup();
		expect(screen.getByTestId("recording-timer")).toHaveTextContent("00:01:05");
		expect(screen.getByTestId("recording-chunk")).toHaveTextContent("03");
		expect(screen.getByText(/Alto-falantes \(Realtek\) \+ Microfone USB/)).toBeInTheDocument();
		expect(screen.getByTestId("waveform").children).toHaveLength(72);
	});

	it("subscribes to the levels SSE and drives the waveform bars from real levels", () => {
		const { raf } = setup();
		const es = FakeEventSource.last;
		expect(es.url).toBe("http://localhost:3456/api/audio/levels");
		es.emit({ system: 0, mic: 0.5 });
		act(() => raf.step(100));
		const bars = Array.from(screen.getByTestId("waveform").children) as HTMLElement[];
		expect(bars[71].style.height).toBe(
			`${(4 + 0.5 * 150 * (0.8 + 0.2 * Math.sin(71 * 1.7))).toFixed(1)}px`,
		);
		expect(bars[0].style.height).toBe("4px");
	});

	it("shows the silence warning after ~3 s of silence", () => {
		const { raf } = setup();
		act(() => FakeEventSource.last.open());
		expect(screen.queryByTestId("silence-warning")).toBeNull();
		act(() => {
			for (let i = 0; i <= 62; i++) raf.step(1000 + i * 50);
		});
		expect(screen.getByTestId("silence-warning")).toBeInTheDocument();
		FakeEventSource.last.emit({ system: 0.5, mic: 0 });
		act(() => raf.step(10_000));
		expect(screen.queryByTestId("silence-warning")).toBeNull();
	});

	it("levels unsupported (SSE `unavailable`): neutral waveform, no silence detection", () => {
		const { raf } = setup();
		const es = FakeEventSource.last;
		act(() => {
			es.open();
			es.emitEvent("unavailable", { reason: "levels-unsupported" });
		});
		act(() => {
			for (let i = 0; i <= 80; i++) raf.step(1000 + i * 50);
		});
		const wrap = screen.getByTestId("wavewrap");
		expect(wrap).toHaveAttribute("data-levels", "neutral");
		expect(wrap).not.toHaveClass("dead");
		expect(screen.queryByTestId("silence-warning")).toBeNull();
		expect(screen.getByTestId("levels-status")).toHaveTextContent(
			"Medidor de nível indisponível neste sistema",
		);
		// Gently animated, mid-height bars (not collapsed to the 4 px floor).
		const bars = Array.from(screen.getByTestId("waveform").children) as HTMLElement[];
		const heights = bars.map((b) => Number.parseFloat(b.style.height));
		expect(Math.min(...heights.slice(-20))).toBeGreaterThan(20);
	});

	it("levels unsupported per /health (capture.levels=false): neutral from the start", () => {
		useStore.setState({
			health: makeHealth({ capture: { backend: "pulse", ok: true, levels: false } }),
		});
		const { raf } = setup();
		act(() => FakeEventSource.last.open());
		act(() => {
			for (let i = 0; i <= 80; i++) raf.step(1000 + i * 50);
		});
		expect(screen.getByTestId("wavewrap")).toHaveAttribute("data-levels", "neutral");
		expect(screen.queryByTestId("silence-warning")).toBeNull();
	});

	it("a dropped stream is not silence: pauses detection and shows 'Reconectando…'", () => {
		const { raf } = setup();
		const es = FakeEventSource.last;
		act(() => es.open());
		expect(screen.queryByTestId("levels-status")).toBeNull();
		act(() => es.fail(false)); // network hiccup, EventSource retrying
		act(() => {
			for (let i = 0; i <= 80; i++) raf.step(1000 + i * 50);
		});
		expect(screen.getByTestId("wavewrap")).toHaveAttribute("data-levels", "reconnecting");
		expect(screen.getByTestId("levels-status")).toHaveTextContent("Reconectando ao medidor…");
		expect(screen.queryByTestId("silence-warning")).toBeNull();
		// Back online: measuring starts from zero again.
		act(() => es.open());
		expect(screen.queryByTestId("levels-status")).toBeNull();
		act(() => raf.step(10_000));
		expect(screen.queryByTestId("silence-warning")).toBeNull();
	});

	it("`event: ended` (stopped elsewhere) leaves the recording screen", async () => {
		installFakeEventSource();
		installManualRaf();
		mockFetch([
			["GET", "/recording/status", { recording: false }],
			["GET", /^\/sessions\?/, { sessions: [] }],
		]);
		useStore.setState({ settings: makeSettings(), devices: DEVICES, recording: baseRec() });
		const Wrapper = () => {
			const r = useStore((s) => s.recording);
			return (
				<>
					{r ? <RecordingScreen recording={r} /> : <div>idle</div>}
					<ToastHost />
				</>
			);
		};
		render(<Wrapper />);
		const es = FakeEventSource.last;
		act(() => {
			es.open();
			es.emitEvent("ended", {});
		});
		expect(await screen.findByText("idle")).toBeInTheDocument();
		expect(screen.getByTestId("toast")).toHaveTextContent("A gravação já não está ativa");
		expect(es.closed).toBe(true);
	});

	it("does not warn on silence when detection is off, but warns when every source is muted", () => {
		setup(
			baseRec({ muted: { system: true, mic: true } }),
			makeSettings({ silenceDetection: false }),
		);
		expect(screen.getByTestId("silence-warning")).toBeInTheDocument();
	});

	it("mute buttons call /recording/mute and update the labels", async () => {
		const { f } = setup();
		fireEvent.click(screen.getByTestId("mute-mic-button"));
		expect(await screen.findByText("Mic mudo")).toBeInTheDocument();
		expect(f.to("POST", "/recording/mute")[0].body).toEqual({ target: "mic", muted: true });
		fireEvent.click(screen.getByTestId("mute-system-button"));
		expect(await screen.findByText("Sistema mudo")).toBeInTheDocument();
		expect(screen.getByTestId("mute-system-button")).toHaveAttribute("aria-pressed", "true");
	});

	it("toasts capture warnings from the levels stream (fallback in red)", async () => {
		setup();
		const es = FakeEventSource.last;
		act(() => {
			es.open();
			es.emitEvent("warning", {
				message: "Dispositivo indisponível — usando o padrão do sistema",
				fallback: true,
			});
		});
		const toast = await screen.findByTestId("toast");
		expect(toast).toHaveTextContent("Dispositivo indisponível — usando o padrão do sistema");
		expect(useStore.getState().toast?.kind).toBe("err");
		act(() =>
			es.emitEvent("warning", { message: "Aviso da captura de áudio: x", fallback: false }),
		);
		expect(useStore.getState().toast).toMatchObject({
			msg: "Aviso da captura de áudio: x",
			kind: "ac",
		});
	});

	it("shows what is really recording when a named device fell back to the default", () => {
		setup(
			baseRec({
				devices: {
					system: "Fone Bluetooth (Loopback)",
					mic: "Microfone USB",
					systemName: "Alto-falantes (Realtek)",
					micName: "Microfone USB",
				},
			}),
		);
		expect(screen.getByTestId("system-device-fallback")).toHaveTextContent(
			"Indisponível — gravando de Alto-falantes (Realtek)",
		);
		expect(screen.queryByTestId("mic-device-fallback")).toBeNull();
		// The picker keeps the requested device (the capture switches back when it returns).
		expect(screen.getByTestId("recording-device-select")).toHaveValue("Fone Bluetooth (Loopback)");
		// The header names the device actually recording.
		expect(screen.getByText(/Alto-falantes \(Realtek\) \+ Microfone USB/)).toBeInTheDocument();
	});

	it("updates the fallback note live from `devices` events", () => {
		setup(
			baseRec({
				devices: {
					system: "@default",
					mic: "Microfone USB",
					systemName: "Alto-falantes (Realtek)",
					micName: "Microfone USB",
				},
			}),
		);
		expect(screen.queryByTestId("mic-device-fallback")).toBeNull();
		const es = FakeEventSource.last;
		act(() => {
			es.open();
			es.emitEvent("devices", {
				system: "@default",
				mic: "Microfone USB",
				systemName: "Alto-falantes (Realtek)",
				micName: "Microfone interno",
			});
		});
		expect(screen.getByTestId("mic-device-fallback")).toHaveTextContent(
			"Indisponível — gravando de Microfone interno",
		);
		act(() => {
			es.emitEvent("devices", {
				system: "@default",
				mic: "Microfone USB",
				systemName: "Alto-falantes (Realtek)",
				micName: "Microfone USB",
			});
		});
		expect(screen.queryByTestId("mic-device-fallback")).toBeNull();
	});

	it("switching the mic calls /recording/devices live and toasts", async () => {
		const { f } = setup();
		const sel = screen.getByTestId("mic-device-select") as HTMLSelectElement;
		expect(sel.options[0].text).toBe("Padrão do sistema (Microfone USB)");
		fireEvent.change(sel, { target: { value: "Microfone interno" } });
		expect(await screen.findByTestId("toast")).toHaveTextContent(
			"Microfone trocado: Microfone interno — sem interromper a gravação",
		);
		expect(f.to("POST", "/recording/devices")[0].body).toEqual({ micDevice: "Microfone interno" });
		expect(screen.getByTestId("recording-device-select")).toHaveValue("@default");
	});

	it("stop goes to the session; discard goes back", async () => {
		const { f } = setup();
		fireEvent.click(screen.getByTestId("stop-recording-button"));
		expect(await screen.findByText("idle")).toBeInTheDocument();
		expect(f.to("POST", "/recording/stop")).toHaveLength(1);
		expect(useStore.getState()).toMatchObject({ screen: "detail", detailId: "r1" });
	});

	it("discard calls /recording/discard", async () => {
		const { f } = setup();
		fireEvent.click(screen.getByTestId("discard-recording-button"));
		expect(await screen.findByText("idle")).toBeInTheDocument();
		expect(f.to("POST", "/recording/discard")).toHaveLength(1);
		expect(
			within(screen.getByTestId("toast")).getByText("Gravação descartada"),
		).toBeInTheDocument();
	});

	it("disables mic mute without a microphone", () => {
		setup(baseRec({ devices: { system: "x", mic: null, systemName: "Fone", micName: null } }));
		expect(screen.getByTestId("mute-mic-button")).toBeDisabled();
		expect(screen.getByTestId("mic-device-select")).toHaveValue("none");
	});

	it("source label falls back when nothing is resolved", () => {
		expect(recordingSourceLabel(baseRec({ devices: null }), (v) => String(v))).toBe(
			"Áudio do sistema",
		);
		expect(
			recordingSourceLabel(
				baseRec({ devices: { system: "a", mic: null, systemName: null, micName: null } }),
				(v) => `L:${v}`,
			),
		).toBe("L:a");
	});
});
