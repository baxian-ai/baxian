import type { DetectedState } from './manifest.js';

const IDLE_CONFIRMATION_THRESHOLD = 3;

export class WorkingToIdleDebounce {
  private confirmations = 0;

  apply(
    nextState: DetectedState,
    previousPublished: DetectedState,
    visibleIdle: boolean,
  ): DetectedState {
    const isWorkingToPlainIdle =
      previousPublished === 'working'
      && nextState === 'idle'
      && !visibleIdle;

    if (!isWorkingToPlainIdle) {
      this.confirmations = 0;
      return nextState;
    }

    this.confirmations++;
    if (this.confirmations >= IDLE_CONFIRMATION_THRESHOLD) {
      this.confirmations = 0;
      return 'idle';
    }
    return 'working';
  }

  reset(): void {
    this.confirmations = 0;
  }
}
