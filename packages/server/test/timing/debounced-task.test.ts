import { describe, it, expect, vi } from 'vitest';
import { DebouncedTask } from '../../src/timing/debounced-task.js';

describe('DebouncedTask', () => {
  it('coalesces repeated schedules into one delayed action', () => {
    vi.useFakeTimers();
    const action = vi.fn();
    const task = new DebouncedTask(100, action);

    task.schedule();
    vi.advanceTimersByTime(50);
    task.schedule();
    vi.advanceTimersByTime(99);
    expect(action).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(action).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it('cancels a pending action', () => {
    vi.useFakeTimers();
    const action = vi.fn();
    const task = new DebouncedTask(100, action);

    task.schedule();
    task.cancel();
    vi.advanceTimersByTime(100);

    expect(action).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
