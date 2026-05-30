import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SlidingWindowLimiter } from "../../../src/utils/rate-limiter.js";

describe("SlidingWindowLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows requests within limits", async () => {
    const limiter = new SlidingWindowLimiter({
      requestsPerMinute: 5,
      audioSecondsPerHour: 3600,
    });

    // Should not block
    const start = Date.now();
    await limiter.waitForSlot(30);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100);
  });

  it("tracks request count within window", async () => {
    const limiter = new SlidingWindowLimiter({
      requestsPerMinute: 2,
      audioSecondsPerHour: 36000,
    });

    await limiter.waitForSlot(10);
    await limiter.waitForSlot(10);

    // Third request should wait
    const waitPromise = limiter.waitForSlot(10);

    // Advance time past the 1-minute window
    await vi.advanceTimersByTimeAsync(61000);
    await waitPromise;
  });

  it("tracks audio seconds within hour window", async () => {
    const limiter = new SlidingWindowLimiter({
      requestsPerMinute: 100,
      audioSecondsPerHour: 60,
    });

    await limiter.waitForSlot(30);
    await limiter.waitForSlot(25);

    // Next request would exceed 60s total, should wait
    const waitPromise = limiter.waitForSlot(10);

    // Advance time past the 1-hour window
    await vi.advanceTimersByTimeAsync(3601000);
    await waitPromise;
  });
});
