export class DebouncedTask {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly delayMs: number,
    private readonly action: () => void,
  ) {}

  schedule(): void {
    this.cancel();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.action();
    }, this.delayMs);
  }

  cancel(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
