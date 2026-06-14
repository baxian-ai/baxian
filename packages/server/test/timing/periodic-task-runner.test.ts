import { describe, it, expect, vi } from 'vitest';
import { PeriodicTaskRunner } from '../../src/timing/periodic-task-runner.js';

describe('PeriodicTaskRunner', () => {
  it('starts immediately, ticks on interval, and stops cleanly', async () => {
    vi.useFakeTimers();
    const run = vi.fn().mockResolvedValue(undefined);
    const runner = new PeriodicTaskRunner({
      name: 'test-runner',
      intervalMs: 1000,
      run,
    });

    runner.start({ runImmediately: true });
    runner.start({ runImmediately: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);

    runner.stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(run).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('skips overlapping ticks and reports the skipped tick', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const firstRun = new Promise<void>((resolve) => { release = resolve; });
    const run = vi.fn()
      .mockReturnValueOnce(firstRun)
      .mockResolvedValue(undefined);
    const onOverlap = vi.fn();
    const runner = new PeriodicTaskRunner({
      name: 'test-runner',
      intervalMs: 1000,
      run,
      onOverlap,
    });

    const first = runner.runOnce();
    await vi.advanceTimersByTimeAsync(1000);
    await runner.runOnce();
    expect(run).toHaveBeenCalledTimes(1);
    expect(onOverlap).toHaveBeenCalledTimes(1);

    release();
    await first;
    await runner.runOnce();
    expect(run).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('isolates throwing onError handlers from scheduled runs', async () => {
    vi.useFakeTimers();
    const err = new Error('run failed');
    const handlerErr = new Error('handler failed');
    const onError = vi.fn(() => { throw handlerErr; });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const runner = new PeriodicTaskRunner({
      name: 'test-runner',
      intervalMs: 1000,
      run: vi.fn().mockRejectedValue(err),
      onError,
    });

    try {
      runner.start({ runImmediately: true });
      await vi.advanceTimersByTimeAsync(0);

      expect(onError).toHaveBeenCalledWith(err);
      expect(consoleSpy).toHaveBeenCalledWith('[test-runner] onError handler failed:', handlerErr);
    } finally {
      runner.stop();
      consoleSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('rejects intervals outside setInterval-safe poller bounds', () => {
    for (const intervalMs of [999, 1500.5, 2_147_483_648]) {
      expect(() => new PeriodicTaskRunner({
        name: 'test-runner',
        intervalMs,
        run: vi.fn(),
      })).toThrow(/intervalMs must be an integer in \[1000, 2147483647\]/);
    }
  });

  describe('reschedule', () => {
    it('updates cadence of an already-started runner', async () => {
      vi.useFakeTimers();
      const run = vi.fn().mockResolvedValue(undefined);
      const runner = new PeriodicTaskRunner({ name: 't', intervalMs: 1000, run });
      runner.start();

      await vi.advanceTimersByTimeAsync(1000);
      expect(run).toHaveBeenCalledTimes(1);

      runner.reschedule(3000);
      expect(runner.getIntervalMs()).toBe(3000);

      await vi.advanceTimersByTimeAsync(2999);
      expect(run).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(run).toHaveBeenCalledTimes(2);

      runner.stop();
      vi.useRealTimers();
    });

    it('no-ops when interval is unchanged (preserves the existing timer)', async () => {
      vi.useFakeTimers();
      const setIntervalSpy = vi.spyOn(global, 'setInterval');
      const run = vi.fn().mockResolvedValue(undefined);
      const runner = new PeriodicTaskRunner({ name: 't', intervalMs: 1000, run });
      runner.start();
      const initialCalls = setIntervalSpy.mock.calls.length;

      runner.reschedule(1000);
      expect(setIntervalSpy.mock.calls.length).toBe(initialCalls);

      runner.stop();
      setIntervalSpy.mockRestore();
      vi.useRealTimers();
    });

    it('updates intervalMs even before start so the next start uses it', async () => {
      vi.useFakeTimers();
      const run = vi.fn().mockResolvedValue(undefined);
      const runner = new PeriodicTaskRunner({ name: 't', intervalMs: 1000, run });
      runner.reschedule(5000);
      runner.start();

      await vi.advanceTimersByTimeAsync(4999);
      expect(run).toHaveBeenCalledTimes(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(run).toHaveBeenCalledTimes(1);

      runner.stop();
      vi.useRealTimers();
    });

    it('rejects invalid intervals', () => {
      const runner = new PeriodicTaskRunner({ name: 't', intervalMs: 1000, run: vi.fn() });
      expect(() => runner.reschedule(500))
        .toThrow(/intervalMs must be an integer/);
      expect(runner.getIntervalMs()).toBe(1000);
    });
  });
});
