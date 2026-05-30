import { describe, it, expect } from "vitest";
import { canTransition, assertTransition } from "../../../src/domain/states.js";

describe("Session State Machine", () => {
  it("allows valid transitions", () => {
    expect(canTransition("created", "recording")).toBe(true);
    expect(canTransition("recording", "stopped")).toBe(true);
    expect(canTransition("stopped", "transcribing")).toBe(true);
    expect(canTransition("transcribing", "analyzing")).toBe(true);
    expect(canTransition("analyzing", "completed")).toBe(true);
  });

  it("allows transition to failed from recording states", () => {
    expect(canTransition("recording", "failed")).toBe(true);
    expect(canTransition("stopped", "failed")).toBe(true);
    expect(canTransition("transcribing", "failed")).toBe(true);
    expect(canTransition("analyzing", "failed")).toBe(true);
  });

  it("rejects invalid transitions", () => {
    expect(canTransition("created", "completed")).toBe(false);
    expect(canTransition("completed", "recording")).toBe(false);
    expect(canTransition("failed", "recording")).toBe(false);
    expect(canTransition("recording", "analyzing")).toBe(false);
    expect(canTransition("created", "transcribing")).toBe(false);
  });

  it("assertTransition throws on invalid transition", () => {
    expect(() => assertTransition("created", "completed")).toThrow(
      "Invalid state transition",
    );
  });

  it("assertTransition does not throw on valid transition", () => {
    expect(() => assertTransition("created", "recording")).not.toThrow();
  });
});
