export const DEFAULT_RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 15000, 30000];

export interface ReconnectSchedulerOptions {
  reconnect: () => void;
  shouldReconnect?: () => boolean;
  delaysMs?: number[];
}

export class ReconnectScheduler {
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly delaysMs: number[];

  constructor(private readonly opts: ReconnectSchedulerOptions) {
    this.delaysMs = opts.delaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
  }

  schedule(): void {
    if (this.timer) return;
    if (!this.shouldReconnect()) return;
    const delay = this.delaysMs[Math.min(this.attempts, this.delaysMs.length - 1)];
    this.attempts += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.shouldReconnect()) return;
      this.opts.reconnect();
    }, delay);
  }

  cancel(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  reset(): void {
    this.attempts = 0;
  }

  private shouldReconnect(): boolean {
    return this.opts.shouldReconnect ? this.opts.shouldReconnect() : true;
  }
}
