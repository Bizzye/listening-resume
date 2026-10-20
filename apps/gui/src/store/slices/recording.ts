import { ApiError, api, errorMessage } from "../../shared/api/client";
import {
	type CaptureSource,
	type ResolvedDevices,
	SYSTEM_DEFAULT_DEVICE,
} from "../../shared/api/types";
import { type DeviceKind, deviceLabel } from "../../shared/lib/devices";
import { setTrayRecording } from "../../shared/lib/tauri";
import type { SliceCreator } from "../types";
import { EXPECT_BUSY_MS } from "./sessions";

export interface ActiveRecording {
	sessionId: string;
	/** Epoch ms from the server — the timer is derived from it. */
	startTime: number;
	chunks: number;
	devices: ResolvedDevices | null;
	muted: Record<CaptureSource, boolean>;
}

export interface RecordingSlice {
	recording: ActiveRecording | null;
	recordingPending: boolean;
	/** Mirrors GET /recording/status. `force` also runs while a start/stop is pending. */
	syncRecording: (opts?: { force?: boolean }) => Promise<void>;
	startRecording: () => Promise<void>;
	stopRecording: () => Promise<void>;
	discardRecording: () => Promise<void>;
	toggleRecording: () => void;
	toggleMute: (source: CaptureSource) => Promise<void>;
	switchCaptureDevice: (kind: DeviceKind, value: string | null) => Promise<void>;
	setLiveDevices: (devices: ResolvedDevices) => void;
	/** The levels stream said the recording ended (`event: ended`). */
	recordingEnded: () => Promise<void>;
}

/** The server answers 409 when there is no active recording (or one already running). */
const isConflict = (err: unknown) => err instanceof ApiError && err.status === 409;

export const createRecordingSlice: SliceCreator<RecordingSlice> = (set, get) => {
	/** Bumped whenever a recording starts or finishes: older status answers are discarded. */
	let epoch = 0;
	/** Mute / device mutations in flight, and a counter of every mutation ever started. */
	let inFlight = 0;
	let mutations = 0;
	/** Latest request per control: older answers are ignored (no out-of-order apply). */
	const muteToken: Record<CaptureSource, number> = { system: 0, mic: 0 };
	const switchToken: Record<DeviceKind, number> = { system: 0, mic: 0 };

	const begin = () => {
		inFlight += 1;
		mutations += 1;
	};
	const end = () => {
		inFlight = Math.max(0, inFlight - 1);
	};

	const finish = () => {
		epoch += 1;
		set({ recording: null });
		setTrayRecording(false);
	};

	/** Recording ended elsewhere (crash, other client): resync and say so. */
	const lost = async () => {
		await get().syncRecording({ force: true });
		if (!get().recording) {
			get().pop("A gravação já não está ativa", "err");
			void get().loadSessions();
		}
	};

	const patchRecording = (patch: Partial<ActiveRecording>) =>
		set((s) => (s.recording ? { recording: { ...s.recording, ...patch } } : {}));

	return {
		recording: null,
		recordingPending: false,

		syncRecording: async (opts = {}) => {
			if (get().recordingPending && !opts.force) return;
			const startEpoch = epoch;
			const startMutations = mutations;
			try {
				const st = await api.recordingStatus();
				// A start/stop/discard happened meanwhile: this answer is outdated.
				if (startEpoch !== epoch || (get().recordingPending && !opts.force)) return;
				if (!st.recording) {
					if (get().recording) finish();
					return;
				}
				const cur = get().recording;
				// Keep optimistic mute/device state while a mutation is (or was) in flight.
				const keepLocal = !!cur && (inFlight > 0 || startMutations !== mutations);
				set({
					recording: {
						sessionId: st.sessionId,
						startTime: st.startTime,
						chunks: st.chunks,
						devices: keepLocal ? cur.devices : (st.devices ?? cur?.devices ?? null),
						muted: keepLocal ? cur.muted : (st.muted ?? { system: false, mic: false }),
					},
				});
				if (!cur) {
					epoch += 1;
					setTrayRecording(true);
				}
			} catch {
				// transient — keep current state
			}
		},

		startRecording: async () => {
			if (get().recording || get().recordingPending) return;
			set({ recordingPending: true });
			try {
				const res = await api.startRecording({});
				epoch += 1;
				set({
					recording: {
						sessionId: res.session.id,
						startTime: res.startTime,
						chunks: 0,
						devices: res.devices,
						muted: { system: false, mic: false },
					},
				});
				setTrayRecording(true);
				void get().loadDevices();
			} catch (err) {
				if (isConflict(err)) await get().syncRecording({ force: true });
				else get().pop(`Não foi possível iniciar a gravação: ${errorMessage(err)}`, "err");
			} finally {
				set({ recordingPending: false });
			}
		},

		stopRecording: async () => {
			if (!get().recording || get().recordingPending) return;
			set({ recordingPending: true });
			try {
				const { session } = await api.stopRecording();
				finish();
				const auto = get().settings?.autoTranscribe ?? true;
				// Trust the server status: auto-transcription may only start right after this answer,
				// so keep polling the session for a while.
				get().addSession(session);
				if (auto) {
					set((s) => ({
						expectBusyUntil: { ...s.expectBusyUntil, [session.id]: Date.now() + EXPECT_BUSY_MS },
					}));
				}
				get().openSession(session.id, "t");
				get().pop(auto ? "Gravação salva — transcrevendo…" : "Gravação salva", "ac");
				void get().loadSessions();
			} catch (err) {
				if (isConflict(err)) await lost();
				else {
					get().pop(`Não foi possível parar a gravação: ${errorMessage(err)}`, "err");
					void get().syncRecording({ force: true });
				}
			} finally {
				set({ recordingPending: false });
			}
		},

		discardRecording: async () => {
			if (!get().recording || get().recordingPending) return;
			set({ recordingPending: true });
			try {
				await api.discardRecording();
				finish();
				get().go("dash");
				get().pop("Gravação descartada", "err");
				void get().loadSessions();
			} catch (err) {
				if (isConflict(err)) await lost();
				else get().pop(`Não foi possível descartar: ${errorMessage(err)}`, "err");
			} finally {
				set({ recordingPending: false });
			}
		},

		toggleRecording: () => {
			if (get().recording) void get().stopRecording();
			else void get().startRecording();
		},

		toggleMute: async (source) => {
			const rec = get().recording;
			if (!rec) return;
			const muted = !rec.muted[source];
			const token = ++muteToken[source];
			const apply = (value: boolean) =>
				set((s) =>
					s.recording
						? { recording: { ...s.recording, muted: { ...s.recording.muted, [source]: value } } }
						: {},
				);
			apply(muted);
			begin();
			try {
				const res = await api.setMute(source, muted);
				if (token === muteToken[source]) apply(res.muted);
			} catch (err) {
				if (token !== muteToken[source]) return;
				apply(!muted);
				if (isConflict(err)) await lost();
				else get().pop(`Não foi possível alterar o mudo: ${errorMessage(err)}`, "err");
			} finally {
				end();
			}
		},

		switchCaptureDevice: async (kind, value) => {
			const rec = get().recording;
			if (!rec) return;
			const token = ++switchToken[kind];
			const prevDevices = rec.devices;
			const base: ResolvedDevices = prevDevices ?? {
				system: SYSTEM_DEFAULT_DEVICE,
				mic: null,
				systemName: null,
				micName: null,
			};
			const optimistic: ResolvedDevices =
				kind === "system"
					? { ...base, system: value ?? SYSTEM_DEFAULT_DEVICE, systemName: null }
					: { ...base, mic: value, micName: null };
			patchRecording({ devices: optimistic });
			begin();
			try {
				const res = await api.switchDevices(
					kind === "system" ? { device: value ?? SYSTEM_DEFAULT_DEVICE } : { micDevice: value },
				);
				if (token !== switchToken[kind]) return; // a newer choice superseded this one
				patchRecording({ devices: res.devices });
				const label = deviceLabel(get().devices, value);
				get().pop(
					kind === "mic"
						? `Microfone trocado: ${label} — sem interromper a gravação`
						: `Captura trocada: ${label} — sem interromper a gravação`,
					"ac",
				);
			} catch (err) {
				if (token !== switchToken[kind]) return;
				patchRecording({ devices: prevDevices });
				if (isConflict(err)) await lost();
				else get().pop(`Não foi possível trocar o dispositivo: ${errorMessage(err)}`, "err");
			} finally {
				end();
			}
		},

		setLiveDevices: (devices) => patchRecording({ devices }),

		recordingEnded: async () => {
			// Our own stop/discard is already handling it.
			if (get().recordingPending || !get().recording) return;
			await lost();
		},
	};
};
