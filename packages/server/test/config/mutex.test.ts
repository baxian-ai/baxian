import { describe, it, expect } from 'vitest';
import { withConfigLock } from '../../src/config/mutex.js';

describe('withConfigLock', () => {
  it('runs single fn and returns its result', async () => {
    const result = await withConfigLock(async () => 42);
    expect(result).toBe(42);
  });

  it('serializes concurrent calls — second sees first completed', async () => {
    let counter = 0;
    const tasks = [0, 1, 2, 3, 4].map(() =>
      withConfigLock(async () => {
        const before = counter;
        await new Promise(r => setTimeout(r, 10));
        counter += 1;
        return { before, after: counter };
      }),
    );
    const results = await Promise.all(tasks);
    expect(results.map(r => r.before)).toEqual([0, 1, 2, 3, 4]);
  });

  it('error in one fn does not block subsequent calls', async () => {
    const fail = withConfigLock(async () => { throw new Error('boom'); });
    await expect(fail).rejects.toThrow('boom');

    const ok = await withConfigLock(async () => 'recovered');
    expect(ok).toBe('recovered');
  });

  it('preserves return type via generic', async () => {
    const result: number = await withConfigLock<number>(async () => 7);
    expect(result).toBe(7);
  });
});
