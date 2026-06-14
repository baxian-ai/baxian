export interface PeriodicTaskRunnerOptions {
  name: string;
  intervalMs: number;
  run: () => Promise<void> | void;
  onError?: (err: unknown) => void;
  onOverlap?: () => void;
}

const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 2_147_483_647;

export class PeriodicTaskRunner {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private intervalMs: number;

  constructor(private readonly opts: PeriodicTaskRunnerOptions) {
    this.intervalMs = validateIntervalMs(opts.intervalMs);
  }

  start(options: { runImmediately?: boolean } = {}): void {
    if (this.intervalId) return;
    if (options.runImmediately) this.runScheduled();
    this.intervalId = setInterval(() => this.runScheduled(), this.intervalMs);
  }

  stop(): void {
    if (!this.intervalId) return;
    clearInterval(this.intervalId);
    this.intervalId = null;
  }

  getIntervalMs(): number {
    return this.intervalMs;
  }

  reschedule(intervalMs: number): void {
    const next = validateIntervalMs(intervalMs);
    if (next === this.intervalMs) return;
    this.intervalMs = next;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = setInterval(() => this.runScheduled(), this.intervalMs);
    }
  }

  async runOnce(): Promise<void> {
    if (this.running) {
      this.opts.onOverlap?.();
      return;
    }
    this.running = true;
    try {
      await this.opts.run();
    } finally {
      this.running = false;
    }
  }

  private runScheduled(): void {
    void this.runOnce().catch((err) => {
      try {
        if (this.opts.onError) {
          this.opts.onError(err);
          return;
        }
        console.error(`[${this.opts.name}] periodic task failed:`, err);
      } catch (handlerErr) {
        console.error(`[${this.opts.name}] onError handler failed:`, handlerErr);
      }
    });
  }
}

function validateIntervalMs(intervalMs: number): number {
  if (
    !Number.isInteger(intervalMs)
    || intervalMs < MIN_INTERVAL_MS
    || intervalMs > MAX_INTERVAL_MS
  ) {
    throw new RangeError(
      `PeriodicTaskRunner intervalMs must be an integer in [${MIN_INTERVAL_MS}, ${MAX_INTERVAL_MS}]`,
    );
  }
  return intervalMs;
}
