import { describe, expect, it } from "vitest";
import { ProcessRegistry, run, tail } from "../../../src/utils/process.js";

const node = process.execPath;
const script = (code: string) => ["-e", code];

describe("run", () => {
	it("collects stdout, stderr and the exit code", async () => {
		const result = await run(
			node,
			script("process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"),
		);
		expect(result).toEqual({ code: 3, stdout: "out", stderr: "err", timedOut: false });
	});

	it("decodes multi-byte UTF-8 split across writes", async () => {
		// "ção" = c3 a7 c3 a3 o — split in the middle of a character.
		const result = await run(
			node,
			script(
				"const b = Buffer.from('ação'); process.stdout.write(b.subarray(0, 2)); setTimeout(() => process.stdout.write(b.subarray(2)), 30)",
			),
		);
		expect(result.stdout).toBe("ação");
	});

	it("keeps the head of stdout and the tail of stderr past maxOutput", async () => {
		const result = await run(
			node,
			script("process.stdout.write('0123456789'); process.stderr.write('abcdefghij')"),
			{ maxOutput: 4 },
		);
		expect(result.stdout).toBe("0123");
		expect(result.stderr).toBe("ghij");
	});

	it("kills a process exceeding timeoutMs and reports timedOut", async () => {
		const result = await run(node, script("setTimeout(() => {}, 10000)"), { timeoutMs: 150 });
		expect(result.timedOut).toBe(true);
		expect(result.code).not.toBe(0);
	});

	it("accepts the legacy numeric timeout argument", async () => {
		const result = await run(node, script("setTimeout(() => {}, 10000)"), 150);
		expect(result.timedOut).toBe(true);
	});

	it("does not time out with timeoutMs 0", async () => {
		const result = await run(node, script("setTimeout(() => console.log('done'), 50)"), {
			timeoutMs: 0,
		});
		expect(result).toMatchObject({ code: 0, stdout: "done\n", timedOut: false });
	});

	it("rejects when the command cannot be spawned", async () => {
		await expect(run("definitely-not-a-real-binary-xyz", [])).rejects.toThrow(/ENOENT/);
	});

	it("tracks running children in a registry and untracks them on exit", async () => {
		const registry = new ProcessRegistry();
		const pending = run(node, script("setTimeout(() => {}, 10000)"), {
			timeoutMs: 0,
			registry,
		});
		expect(registry.size).toBe(1);
		expect(registry.killAll()).toBe(1);
		const result = await pending;
		expect(result.timedOut).toBe(false);
		expect(result.code).not.toBe(0);
		expect(registry.size).toBe(0);
		expect(registry.killAll()).toBe(0);
	});

	it("untracks a child that failed to spawn", async () => {
		const registry = new ProcessRegistry();
		await expect(run("definitely-not-a-real-binary-xyz", [], { registry })).rejects.toThrow();
		expect(registry.size).toBe(0);
	});
});

describe("tail", () => {
	it("joins the last non-empty lines", () => {
		expect(tail("a\n\nb\r\nc\nd\n", 2)).toBe("c | d");
		expect(tail("")).toBe("");
	});
});
