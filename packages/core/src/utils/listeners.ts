import { errorMessage } from "../domain/errors.js";
import { logger } from "./logger.js";

/** Minimal typed multi-listener set; `on` returns its own unsubscribe function. */
export class Listeners<T> {
	private readonly set = new Set<(value: T) => void>();

	on(cb: (value: T) => void): () => void {
		this.set.add(cb);
		return () => {
			this.set.delete(cb);
		};
	}

	emit(value: T): void {
		for (const cb of [...this.set]) {
			try {
				cb(value);
			} catch (err) {
				// A failing subscriber must not break the producer (or other subscribers).
				logger.warn(`Listener threw: ${errorMessage(err)}`);
			}
		}
	}

	get size(): number {
		return this.set.size;
	}

	clear(): void {
		this.set.clear();
	}
}
