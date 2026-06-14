import { describe, it, expect, vi } from 'vitest';
import { ReconnectScheduler } from '../../src/stores/reconnect-scheduler.ts';

describe('ReconnectScheduler', () => {
  it('schedules reconnects with capped backoff and prevents duplicate timers', () => {
    vi.useFakeTimers();
    const reconnect = vi.fn();
    const scheduler = new ReconnectScheduler({
      delaysMs: [10, 20],
      reconnect,
    });

    scheduler.schedule();
    scheduler.schedule();
    vi.advanceTimersByTime(10);
    expect(reconnect).toHaveBeenCalledTimes(1);

    scheduler.schedule();
    vi.advanceTimersByTime(20);
    expect(reconnect).toHaveBeenCalledTimes(2);

    scheduler.schedule();
    vi.advanceTimersByTime(20);
    expect(reconnect).toHaveBeenCalledTimes(3);

    vi.useRealTimers();
  });

  it('can reset attempts and cancel pending reconnect', () => {
    vi.useFakeTimers();
    const reconnect = vi.fn();
    const scheduler = new ReconnectScheduler({
      delaysMs: [10, 20],
      reconnect,
    });

    scheduler.schedule();
    vi.advanceTimersByTime(10);
    scheduler.reset();
    scheduler.schedule();
    vi.advanceTimersByTime(10);
    expect(reconnect).toHaveBeenCalledTimes(2);

    scheduler.schedule();
    scheduler.cancel();
    vi.advanceTimersByTime(20);
    expect(reconnect).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });
});
