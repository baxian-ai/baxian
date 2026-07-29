import { describe, it, expect } from 'vitest';
import { LocalRunner } from '../../src/agent/runner.js';
import { raceDeadline } from '../../src/agent/pane-streamer-manager.js';

describe('geometry settle deadline over a real LocalRunner', () => {
  it('SIGTERM-immune child: the race settles at its deadline while the raw exec settles later via SIGKILL', async () => {
    const runner = new LocalRunner();
    const raw = runner.exec("trap '' TERM; sleep 30", { timeout: 100 });
    let rawSettledAt = 0;
    const started = Date.now();
    const observed = raw.then(
      () => { rawSettledAt = Date.now() - started; },
      () => { rawSettledAt = Date.now() - started; },
    );

    await expect(raceDeadline(raw, 1000, () => undefined)).rejects.toThrow(/deadline/);
    const racedAt = Date.now() - started;
    expect(racedAt).toBeLessThan(1900);
    expect(rawSettledAt).toBe(0);

    await observed;
    expect(rawSettledAt).toBeGreaterThanOrEqual(1900);
    expect(rawSettledAt).toBeLessThan(15000);
  }, 20000);

  it('no-timeout exec with a grandchild holding stdout: raw close is unbounded, the race still settles on time', async () => {
    const runner = new LocalRunner();
    const raw = runner.exec('sleep 8 & exit 0');
    let rawSettled = false;
    const observed = raw.then(() => { rawSettled = true; }, () => { rawSettled = true; });

    const started = Date.now();
    await expect(raceDeadline(raw, 1000, () => undefined)).rejects.toThrow(/deadline/);
    expect(Date.now() - started).toBeLessThan(1900);
    expect(rawSettled).toBe(false);
    void observed;
  }, 20000);
});
