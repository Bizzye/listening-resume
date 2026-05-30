export class SlidingWindowLimiter {
  private timestamps: number[] = [];
  private audioSeconds: { time: number; value: number }[] = [];
  private maxRpm: number;
  private maxAudioSecondsPerHour: number;

  constructor(opts: {
    requestsPerMinute: number;
    audioSecondsPerHour: number;
  }) {
    this.maxRpm = opts.requestsPerMinute;
    this.maxAudioSecondsPerHour = opts.audioSecondsPerHour;
  }

  async waitForSlot(audioDurationSeconds: number): Promise<void> {
    while (true) {
      const now = Date.now();
      this.cleanup(now);

      const rpmOk = this.timestamps.length < this.maxRpm;
      const totalAudio = this.audioSeconds.reduce((sum, e) => sum + e.value, 0);
      const audioOk =
        totalAudio + audioDurationSeconds <= this.maxAudioSecondsPerHour;

      if (rpmOk && audioOk) {
        this.timestamps.push(now);
        this.audioSeconds.push({ time: now, value: audioDurationSeconds });
        return;
      }

      const waitMs = rpmOk ? 1000 : this.getWaitTime(now);
      await sleep(waitMs);
    }
  }

  private cleanup(now: number): void {
    const oneMinAgo = now - 60_000;
    const oneHourAgo = now - 3_600_000;
    this.timestamps = this.timestamps.filter((t) => t > oneMinAgo);
    this.audioSeconds = this.audioSeconds.filter((e) => e.time > oneHourAgo);
  }

  private getWaitTime(now: number): number {
    if (this.timestamps.length > 0) {
      const oldest = this.timestamps[0];
      return Math.max(100, oldest + 60_000 - now);
    }
    return 1000;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
