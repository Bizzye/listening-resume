import { type ChildProcess, spawn } from "node:child_process";

/** Resolves with the exit code once `proc` exits; kills it if it outlives `timeoutMs`. */
export function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<number | null> {
	if (proc.exitCode !== null || proc.signalCode !== null) {
		return Promise.resolve(proc.exitCode);
	}
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			proc.kill();
		}, timeoutMs);
		proc.once("close", (code) => {
			clearTimeout(timer);
			resolve(code);
		});
	});
}

/** Writes one line to a child's stdin, ignoring a closed pipe. */
export function writeLine(proc: ChildProcess | null, line: string): boolean {
	const stdin = proc?.stdin;
	if (!stdin || stdin.destroyed || !stdin.writable) return false;
	stdin.write(`${line}\n`);
	return true;
}

export interface RunResult {
	code: number | null;
	stdout: string;
	stderr: string;
	/** True when the process was killed for exceeding `timeoutMs`. */
	timedOut?: boolean;
}

/**
 * Children started by `run` that are still running, so a graceful shutdown can kill them all
 * (e.g. an ffmpeg import still converting when the server stops).
 */
export class ProcessRegistry {
	private readonly running = new Set<ChildProcess>();

	add(proc: ChildProcess): void {
		this.running.add(proc);
	}

	delete(proc: ChildProcess): void {
		this.running.delete(proc);
	}

	get size(): number {
		return this.running.size;
	}

	/** Kills every child still running. Returns how many were signalled. */
	killAll(): number {
		let killed = 0;
		for (const proc of this.running) {
			if (proc.exitCode === null && proc.signalCode === null) {
				proc.kill();
				killed++;
			}
		}
		return killed;
	}
}

export interface RunOptions {
	/** Kill the process after this long (reported as `timedOut`); `0` = no limit. Default 15 s. */
	timeoutMs?: number;
	/**
	 * Max characters kept per stream (default 1 MiB): stdout keeps its head, stderr its tail
	 * (ffmpeg prints the actual error last), so a chatty process can't grow memory unbounded.
	 */
	maxOutput?: number;
	/** Tracks the child while it runs (see `ProcessRegistry.killAll`). */
	registry?: ProcessRegistry;
}

/** Runs a command to completion (see `run`); injectable for tests. */
export type ProcessRunner = (
	command: string,
	args: string[],
	options?: RunOptions | number,
) => Promise<RunResult>;

const DEFAULT_RUN_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT = 1024 * 1024;

/**
 * Runs a command to completion, collecting its output (decoded as UTF-8 streams, so multi-byte
 * characters split across reads stay intact). Rejects only when it cannot start. A number as
 * the third argument is the timeout (backwards compatible).
 */
export const run: ProcessRunner = (command, args, options = {}) => {
	const opts: RunOptions = typeof options === "number" ? { timeoutMs: options } : options;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
	const maxOutput = opts.maxOutput ?? DEFAULT_MAX_OUTPUT;
	return new Promise((resolve, reject) => {
		const proc = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		opts.registry?.add(proc);
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		proc.stdout.setEncoding("utf8");
		proc.stderr.setEncoding("utf8");
		proc.stdout.on("data", (d: string) => {
			if (stdout.length < maxOutput) stdout = (stdout + d).slice(0, maxOutput);
		});
		proc.stderr.on("data", (d: string) => {
			stderr = (stderr + d).slice(-maxOutput);
		});
		const timer =
			timeoutMs > 0
				? setTimeout(() => {
						timedOut = true;
						proc.kill();
					}, timeoutMs)
				: null;
		const finish = () => {
			if (timer) clearTimeout(timer);
			opts.registry?.delete(proc);
		};
		proc.once("error", (err) => {
			finish();
			reject(err);
		});
		proc.once("close", (code) => {
			finish();
			resolve({ code, stdout, stderr, timedOut });
		});
	});
};

/** Last non-empty lines of a log, for error messages. */
export function tail(text: string, lines = 3): string {
	return text
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean)
		.slice(-lines)
		.join(" | ");
}
