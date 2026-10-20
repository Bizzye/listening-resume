import type {
	AudioCapturePort,
	AudioLevels,
	CaptureDevices,
	LevelMeter,
	ResolvedDevices,
} from "@listening-resume/core";
import type { Logger } from "../deps.js";

export const DEFAULT_METER_STALL_MS = 5000;

export interface MeterSubscriber {
	onLevels(levels: AudioLevels): void;
	onDevices(devices: ResolvedDevices): void;
	/** The shared meter died (process exited / stopped emitting). Not called on unsubscribe. */
	onDead(error: string): void;
}

interface Entry {
	key: string;
	ready: Promise<LevelMeter>;
	meter: LevelMeter | null;
	subs: Set<MeterSubscriber>;
	lastDevices: ResolvedDevices | null;
	lastLevelAt: number;
	watchdog: ReturnType<typeof setInterval> | null;
	offs: Array<() => void>;
	closed: boolean;
}

/**
 * One `LevelMeter` per (system, mic) pair, shared by every SSE client asking for it and
 * stopped when the last one leaves. Meters only emit levels (no exit event), so a meter that
 * stays silent for `stallMs` is treated as dead: its subscribers get `onDead` and the next
 * subscriber starts a fresh one.
 */
export class MeterPool {
	private entries = new Map<string, Entry>();

	constructor(
		private capture: Pick<AudioCapturePort, "startMeter">,
		private logger: Logger,
		private stallMs = DEFAULT_METER_STALL_MS,
	) {}

	/** Number of live meters (tests). */
	get size(): number {
		return this.entries.size;
	}

	/**
	 * Join (or start) the meter for `devices`. Resolves with an unsubscribe function; rejects
	 * when the meter cannot start.
	 */
	async subscribe(devices: CaptureDevices, sub: MeterSubscriber): Promise<() => void> {
		const key = JSON.stringify([devices.system, devices.mic]);
		let entry = this.entries.get(key);
		if (!entry) entry = this.start(key, devices);
		entry.subs.add(sub);
		const e = entry;
		try {
			await e.ready;
		} catch (err) {
			e.subs.delete(sub);
			throw err;
		}
		if (e.closed) {
			e.subs.delete(sub);
			throw new Error("Medidor encerrado");
		}
		if (e.lastDevices) sub.onDevices(e.lastDevices);
		let done = false;
		return () => {
			if (done) return;
			done = true;
			e.subs.delete(sub);
			if (e.subs.size === 0) void this.close(e);
		};
	}

	private start(key: string, devices: CaptureDevices): Entry {
		const entry: Entry = {
			key,
			ready: this.capture.startMeter(devices),
			meter: null,
			subs: new Set(),
			lastDevices: null,
			lastLevelAt: Date.now(),
			watchdog: null,
			offs: [],
			closed: false,
		};
		this.entries.set(key, entry);
		entry.ready.then(
			(meter) => {
				entry.meter = meter;
				if (entry.closed || entry.subs.size === 0) {
					void this.close(entry);
					return;
				}
				entry.lastLevelAt = Date.now();
				entry.offs.push(
					meter.onLevels((l) => {
						entry.lastLevelAt = Date.now();
						for (const s of entry.subs) s.onLevels(l);
					}),
					meter.onDeviceChange((d) => {
						entry.lastDevices = d;
						for (const s of entry.subs) s.onDevices(d);
					}),
				);
				entry.watchdog = setInterval(
					() => {
						if (Date.now() - entry.lastLevelAt > this.stallMs) this.kill(entry);
					},
					Math.max(50, Math.floor(this.stallMs / 4)),
				);
				entry.watchdog.unref?.();
			},
			() => {
				// The subscribers' awaits report the failure; just forget the entry.
				entry.closed = true;
				if (this.entries.get(key) === entry) this.entries.delete(key);
			},
		);
		return entry;
	}

	private kill(entry: Entry): void {
		if (entry.closed) return;
		this.logger.warn(`[levels] meter stopped emitting levels for ${entry.key}`);
		const subs = [...entry.subs];
		void this.close(entry);
		for (const s of subs) s.onDead("O medidor de áudio parou de responder");
	}

	private async close(entry: Entry): Promise<void> {
		if (entry.closed && entry.meter === null) return;
		entry.closed = true;
		if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
		if (entry.watchdog) clearInterval(entry.watchdog);
		for (const off of entry.offs.splice(0)) off();
		const meter = entry.meter;
		entry.meter = null;
		entry.subs.clear();
		if (meter) await meter.stop().catch(() => {});
	}

	/** Stop every meter (graceful shutdown). */
	async stopAll(): Promise<void> {
		const entries = [...this.entries.values()];
		await Promise.all(
			entries.map(async (e) => {
				await e.ready.catch(() => {});
				await this.close(e);
			}),
		);
	}
}
