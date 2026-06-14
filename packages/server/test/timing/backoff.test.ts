import { describe, it, expect } from 'vitest';
import { computeBackoffMs } from '../../src/timing/backoff.js';

describe('computeBackoffMs', () => {
  it('returns base delay for the first attempt', () => {
    expect(computeBackoffMs(1, { baseMs: 1000, maxMs: 30_000 })).toBe(1000);
  });

  it('doubles per attempt with the default factor', () => {
    expect(computeBackoffMs(2, { baseMs: 1000, maxMs: 30_000 })).toBe(2000);
    expect(computeBackoffMs(3, { baseMs: 1000, maxMs: 30_000 })).toBe(4000);
    expect(computeBackoffMs(4, { baseMs: 1000, maxMs: 30_000 })).toBe(8000);
  });

  it('caps growth at maxMs', () => {
    expect(computeBackoffMs(10, { baseMs: 1000, maxMs: 15_000 })).toBe(15_000);
  });

  it('honors a custom factor', () => {
    expect(computeBackoffMs(2, { baseMs: 1000, maxMs: 30_000, factor: 3 })).toBe(3000);
  });

  it('treats attempts below 1 as the first attempt', () => {
    expect(computeBackoffMs(0, { baseMs: 1000, maxMs: 30_000 })).toBe(1000);
    expect(computeBackoffMs(-5, { baseMs: 1000, maxMs: 30_000 })).toBe(1000);
  });

  it('subtracts up to jitter fraction using the injected random (never exceeds the cap)', () => {
    const base = { baseMs: 1000, maxMs: 30_000, jitter: 0.2 };
    expect(computeBackoffMs(1, { ...base, random: () => 0 })).toBe(1000);
    expect(computeBackoffMs(1, { ...base, random: () => 1 })).toBe(800);
    expect(computeBackoffMs(1, { ...base, random: () => 0.5 })).toBe(900);
  });

  it('applies jitter relative to the capped value', () => {
    expect(
      computeBackoffMs(10, { baseMs: 1000, maxMs: 10_000, jitter: 0.5, random: () => 1 }),
    ).toBe(5000);
  });

  it('clamps jitter into [0,1] and ignores non-finite jitter (no negative / NaN delays)', () => {
    // jitter > 1 clamps to 1 → with random()=1 the delay floors at 0, never negative
    expect(computeBackoffMs(1, { baseMs: 1000, maxMs: 30_000, jitter: 5, random: () => 1 })).toBe(0);
    // negative jitter clamps to 0 → no reduction
    expect(computeBackoffMs(1, { baseMs: 1000, maxMs: 30_000, jitter: -1, random: () => 1 })).toBe(1000);
    // NaN jitter is ignored → no reduction
    expect(computeBackoffMs(1, { baseMs: 1000, maxMs: 30_000, jitter: NaN, random: () => 1 })).toBe(1000);
  });
});
