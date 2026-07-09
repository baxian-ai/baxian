import { describe, it, expect } from 'vitest';
import { mapWithConcurrency } from '../../src/shared/concurrency.js';

describe('mapWithConcurrency', () => {
  it('returns [] for empty input without invoking fn', async () => {
    let calls = 0;
    const out = await mapWithConcurrency([], 5, async (x: number) => { calls++; return x; });
    expect(out).toEqual([]);
    expect(calls).toBe(0);
  });

  it('preserves input order even when later items resolve first', async () => {
    const out = await mapWithConcurrency([30, 10, 20], 3, async (ms, i) => {
      await new Promise(r => setTimeout(r, ms));
      return `${i}:${ms}`;
    });
    expect(out).toEqual(['0:30', '1:10', '2:20']);
  });

  it('never runs more than `limit` tasks at once and saturates the pool', async () => {
    let active = 0;
    let maxActive = 0;
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 3, async (x) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 1));
      active--;
      return x;
    });
    expect(maxActive).toBe(3);
  });

  it('caps worker count at item count when limit exceeds it', async () => {
    let active = 0;
    let maxActive = 0;
    const out = await mapWithConcurrency([1, 2], 10, async (x) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 1));
      active--;
      return x * 2;
    });
    expect(out).toEqual([2, 4]);
    expect(maxActive).toBe(2);
  });

  it('processes every item exactly once', async () => {
    const seen = new Set<number>();
    const items = Array.from({ length: 50 }, (_, i) => i);
    const out = await mapWithConcurrency(items, 8, async (x) => { seen.add(x); return x; });
    expect(out).toEqual(items);
    expect(seen.size).toBe(50);
  });
});
