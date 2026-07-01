import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  GitHubPoller,
  computePollerHealth,
  type PollerOptions,
} from '../../src/github/poller.js';
import type { CommandRunner } from '../../src/agent/runner.js';

const REPO = 'user/repo';
const PROJECT_ID = 'test-proj';

type ManagedPrOverrides = {
  number?: number;
  html_url?: string;
  ref?: string;
  sha?: string;
  updated_at?: string;
};

function managedPr(o: ManagedPrOverrides = {}): Record<string, unknown> {
  const number = o.number ?? 42;
  return {
    number,
    html_url: o.html_url ?? `https://github.com/u/r/pull/${number}`,
    head: { ref: o.ref ?? `bx/task-${number}`, sha: o.sha ?? 'a'.repeat(40), repo: { full_name: REPO } },
    base: { repo: { full_name: REPO } },
    state: 'open',
    merged_at: null,
    updated_at: o.updated_at ?? '2026-05-12T00:00:00Z',
  };
}

function managedPrListJson(...prs: ManagedPrOverrides[]): string {
  return JSON.stringify(prs.map(managedPr));
}

function okRunner(): CommandRunner {
  return {
    exec: vi.fn(async (cmd: string) => {
      const slurped = cmd.includes('--slurp');
      return {
        stdout: slurped ? '[[]]' : '[]',
        stderr: '',
        exitCode: 0,
      };
    }),
  };
}

function throwingRunner(message: string): CommandRunner {
  return {
    exec: vi.fn(async () => {
      throw new Error(message);
    }),
  };
}

function nonZeroExitRunner(stderr: string): CommandRunner {
  return {
    exec: vi.fn(async () => ({ stdout: '', stderr, exitCode: 1 })),
  };
}

function badJsonRunner(stdout: string): CommandRunner {
  return {
    exec: vi.fn(async () => ({ stdout, stderr: '', exitCode: 0 })),
  };
}

function makePoller(runner: CommandRunner): GitHubPoller {
  const opts: PollerOptions = { runner, onEvent: () => undefined };
  return new GitHubPoller(opts);
}

function suppressConsole(): void {
  let errSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    errSpy.mockRestore();
    warnSpy.mockRestore();
  });
}

describe('computePollerHealth', () => {
  it('returns unknown when never polled and no failure', () => {
    expect(computePollerHealth(0, undefined)).toBe('unknown');
  });
  it('returns healthy when successful at least once and no consecutive failure', () => {
    expect(computePollerHealth(0, '2026-05-12T00:00:00Z')).toBe('healthy');
  });
  it('returns degraded at first failure', () => {
    expect(computePollerHealth(1, '2026-05-12T00:00:00Z')).toBe('degraded');
    expect(computePollerHealth(2, '2026-05-12T00:00:00Z')).toBe('degraded');
  });
  it('returns failed when 3+ consecutive failures', () => {
    expect(computePollerHealth(3, '2026-05-12T00:00:00Z')).toBe('failed');
    expect(computePollerHealth(99, undefined)).toBe('failed');
  });
});

describe('GitHubPoller.snapshots()', () => {
  suppressConsole();

  it('returns one snapshot per added entry with initial unknown health', () => {
    const p = makePoller(okRunner());
    p.add({ projectId: PROJECT_ID, repo: REPO });
    p.add({ projectId: 'p2', repo: 'a/b' });
    const snaps = p.snapshots();
    expect(snaps).toHaveLength(2);
    expect(snaps[0].repo).toBe(REPO);
    expect(snaps[0].projectId).toBe(PROJECT_ID);
    expect(snaps[0].intervalMs).toBe(0);
    expect(snaps[0].isPolling).toBe(false);
    expect(snaps[0].consecutiveFailures).toBe(0);
    expect(snaps[0].health).toBe('unknown');
    expect(snaps[0].lastPollStartedAt).toBeUndefined();
    expect(snaps[0].lastPollEndedAt).toBeUndefined();
    expect(snaps[0].lastErrorAt).toBeUndefined();
    expect(snaps[1].repo).toBe('a/b');
  });

  it('after successful poll(): entry is healthy, lastPollEndedAt set, no error', async () => {
    const p = makePoller(okRunner());
    p.add({ projectId: PROJECT_ID, repo: REPO });
    await p.poll();
    const snap = p.snapshots()[0];
    expect(snap.health).toBe('healthy');
    expect(snap.consecutiveFailures).toBe(0);
    expect(snap.lastPollStartedAt).toBeDefined();
    expect(snap.lastPollEndedAt).toBeDefined();
    expect(snap.lastPollDurationMs).toBeGreaterThanOrEqual(0);
    expect(snap.lastErrorMessage).toBeUndefined();
  });

  it('after failed poll(): entry is degraded, lastErrorMessage captured', async () => {
    const p = makePoller(throwingRunner('network down'));
    p.add({ projectId: PROJECT_ID, repo: REPO });
    await p.poll();
    const snap = p.snapshots()[0];
    expect(snap.health).toBe('degraded');
    expect(snap.consecutiveFailures).toBe(1);
    expect(snap.lastErrorMessage).toBe('network down');
    expect(snap.lastErrorAt).toBeDefined();
    expect(snap.lastPollEndedAt).toBeDefined();
  });

  it('escalates to failed after 3 consecutive failures', async () => {
    const p = makePoller(throwingRunner('boom'));
    p.add({ projectId: PROJECT_ID, repo: REPO });
    await p.poll();
    expect(p.snapshots()[0].health).toBe('degraded');
    await p.poll();
    expect(p.snapshots()[0].health).toBe('degraded');
    await p.poll();
    expect(p.snapshots()[0].health).toBe('failed');
    expect(p.snapshots()[0].consecutiveFailures).toBe(3);
  });

  it.each([
    ['gh exit code != 0', nonZeroExitRunner('gh: not authenticated'), /pollPullRequests failed.*gh: not authenticated/],
    ['stdout JSON parse failure', badJsonRunner('not valid json {'), /JSON parse failed/],
    ['response not an array', badJsonRunner('{"message":"unauthorized"}'), /expected array, got object/],
  ])('%s → cycle counted as failure (degraded, error captured)', async (_label, runner, pattern) => {
    const p = makePoller(runner);
    p.add({ projectId: PROJECT_ID, repo: REPO });
    await p.poll();
    const snap = p.snapshots()[0];
    expect(snap.health).toBe('degraded');
    expect(snap.consecutiveFailures).toBe(1);
    expect(snap.lastErrorMessage).toMatch(pattern);
  });

  it('3 consecutive gh exit != 0 cycles escalate to failed health', async () => {
    const p = makePoller(nonZeroExitRunner('rate limited'));
    p.add({ projectId: PROJECT_ID, repo: REPO });
    await p.poll();
    await p.poll();
    await p.poll();
    expect(p.snapshots()[0].health).toBe('failed');
    expect(p.snapshots()[0].consecutiveFailures).toBe(3);
  });

  it('list-PR succeeds but all sub-polls fail → cycle counted as degraded', async () => {
    const prData = managedPrListJson({ number: 42, ref: 'bx/task-something' });
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes('/pulls?')) {
          return { stdout: prData, stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: 'rate limited', exitCode: 1 };
      }),
    };
    const p = new GitHubPoller({ runner, onEvent: () => undefined });
    p.add({ projectId: PROJECT_ID, repo: REPO });
    await p.poll();
    const snap = p.snapshots()[0];
    expect(snap.health).toBe('degraded');
    expect(snap.consecutiveFailures).toBe(1);
    expect(snap.lastErrorMessage).toMatch(/pollPullRequests: \d+ failure/);
    expect(snap.lastErrorMessage).toMatch(/rate limited/);
  });

  it('onEvent throw on pr.created → cycle counted as degraded; cursor not stamped', async () => {
    const prData = managedPrListJson({ number: 700, ref: 'bx/task-emit' });
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes('/pulls?')) return { stdout: prData, stderr: '', exitCode: 0 };
        return { stdout: cmd.includes('--slurp') ? '[[]]' : '[]', stderr: '', exitCode: 0 };
      }),
    };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let emitCalls = 0;
    const p = new GitHubPoller({
      runner,
      onEvent: async () => {
        emitCalls += 1;
        throw new Error('event sink down');
      },
    });
    p.add({ projectId: PROJECT_ID, repo: REPO });
    await p.poll();
    const snap = p.snapshots()[0];
    expect(snap.health).toBe('degraded');
    expect(snap.consecutiveFailures).toBe(1);
    expect(snap.lastErrorMessage).toMatch(/event sink down/);
    expect(emitCalls).toBe(1);
    errSpy.mockRestore();
  });

  it('onEvent throw inside sub-poll (review.submitted) → cycle counted as degraded', async () => {
    const prData = managedPrListJson({ number: 701, ref: 'bx/task-review-emit' });
    const reviewData = JSON.stringify([{ id: 9000, state: 'APPROVED' }]);
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes('/pulls?')) return { stdout: prData, stderr: '', exitCode: 0 };
        if (cmd.includes('/pulls/701/reviews')) return { stdout: `[${reviewData}]`, stderr: '', exitCode: 0 };
        return { stdout: cmd.includes('--slurp') ? '[[]]' : '[]', stderr: '', exitCode: 0 };
      }),
    };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const p = new GitHubPoller({
      runner,
      onEvent: async (_pid, e) => {
        if (e.type === 'review.submitted') throw new Error('handler wedged');
      },
    });
    p.add({ projectId: PROJECT_ID, repo: REPO });
    await p.poll();
    const snap = p.snapshots()[0];
    expect(snap.health).toBe('degraded');
    expect(snap.consecutiveFailures).toBe(1);
    expect(snap.lastErrorMessage).toMatch(/review event emit/);
    errSpy.mockRestore();
  });

  it('legacy adoption confirm + sub-poll exit≠0 → cycle counted as degraded', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'baxian-poller-legacy-status-'));
    const statePath = join(dir, 'cursor.json');
    try {
      const sha = 'a'.repeat(40);
      await writeFile(statePath, JSON.stringify({
        pullsByHead: { 'bx/task-legacy': '2026-04-30T00:00:00Z' },
        legacyAdoptionPending: { 'bx/task-legacy': sha },
        reviews: [],
        reviewComments: [],
        issueComments: [],
        mergedPrs: [],
      }));
      const prData = JSON.stringify([{
        number: 300,
        head: { ref: 'bx/task-legacy', sha, repo: { full_name: REPO } },
        base: { repo: { full_name: REPO } },
        html_url: 'https://github.com/u/r/pull/300',
        state: 'open',
        merged_at: null,
        updated_at: '2026-05-04T00:00:00Z',
      }]);
      const runner: CommandRunner = {
        exec: vi.fn(async (cmd: string) => {
          if (cmd.includes('/pulls?')) {
            return { stdout: prData, stderr: '', exitCode: 0 };
          }
          return { stdout: '', stderr: 'rate limited', exitCode: 1 };
        }),
      };
      const p = new GitHubPoller({ runner, onEvent: () => undefined });
      p.add({ projectId: PROJECT_ID, repo: REPO, statePath });
      await p.poll();
      const snap = p.snapshots()[0];
      expect(snap.health).toBe('degraded');
      expect(snap.consecutiveFailures).toBe(1);
      expect(snap.lastErrorMessage).toMatch(/pollPullRequests: \d+ failure/);
      expect(snap.lastErrorMessage).toMatch(/rate limited/);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('sub-poll failure does not block sibling sub-polls for the same PR or other PRs', async () => {
    const prData = managedPrListJson(
      { number: 1, html_url: 'u1', ref: 'bx/a', sha: 'a'.repeat(40) },
      { number: 2, html_url: 'u2', ref: 'bx/b', sha: 'b'.repeat(40) },
    );
    let reviewsForPr1Call = 0;
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes('/pulls?')) return { stdout: prData, stderr: '', exitCode: 0 };
        if (cmd.includes('/pulls/1/reviews')) {
          reviewsForPr1Call++;
          return { stdout: '', stderr: 'rate limited', exitCode: 1 };
        }
        const slurped = cmd.includes('--slurp');
        return { stdout: slurped ? '[[]]' : '[]', stderr: '', exitCode: 0 };
      }),
    };
    const events: Array<{ type: string }> = [];
    const p = new GitHubPoller({
      runner,
      onEvent: (_pid, e) => { events.push(e); },
    });
    p.add({ projectId: PROJECT_ID, repo: REPO });
    await p.poll();
    expect(reviewsForPr1Call).toBe(1);
    const created = events.filter(e => e.type === 'pr.created');
    expect(created).toHaveLength(2);
    expect(p.snapshots()[0].health).toBe('degraded');
  });

  it('preserves lastErrorMessage across recovery (historical reference)', async () => {
    const p = makePoller(throwingRunner('rate limited'));
    p.add({ projectId: PROJECT_ID, repo: REPO });
    await p.poll();
    expect(p.snapshots()[0].lastErrorMessage).toBe('rate limited');
    expect(p.snapshots()[0].consecutiveFailures).toBe(1);

    (p as unknown as { runner: CommandRunner }).runner = okRunner();
    await p.poll();
    const snap = p.snapshots()[0];
    expect(snap.health).toBe('healthy');
    expect(snap.consecutiveFailures).toBe(0);
    expect(snap.lastErrorMessage).toBe('rate limited');
    expect(snap.lastErrorAt).toBeDefined();
  });

  it('one failing repo does not contaminate another entry status', async () => {
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes('repo-bad')) {
          throw new Error('rate limited');
        }
        const slurped = cmd.includes('--slurp');
        return { stdout: slurped ? '[[]]' : '[]', stderr: '', exitCode: 0 };
      }),
    };
    const p = makePoller(runner);
    p.add({ projectId: 'p1', repo: 'user/repo-good' });
    p.add({ projectId: 'p2', repo: 'user/repo-bad' });
    await p.poll();
    const snaps = p.snapshots();
    const good = snaps.find(s => s.repo === 'user/repo-good')!;
    const bad = snaps.find(s => s.repo === 'user/repo-bad')!;
    expect(good.health).toBe('healthy');
    expect(good.consecutiveFailures).toBe(0);
    expect(good.lastErrorMessage).toBeUndefined();
    expect(bad.health).toBe('degraded');
    expect(bad.consecutiveFailures).toBe(1);
    expect(bad.lastErrorMessage).toBe('rate limited');
  });
});

describe('GitHubPoller lifecycle hook', () => {
  suppressConsole();

  it('fires twice per entry per cycle (start + end)', async () => {
    const p = makePoller(okRunner());
    p.add({ projectId: PROJECT_ID, repo: REPO });
    p.add({ projectId: 'p2', repo: 'a/b' });
    const fn = vi.fn();
    p.setLifecycleHook(fn);
    await p.poll();
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('hook still fires twice for an entry whose pollOne throws', async () => {
    const p = makePoller(throwingRunner('boom'));
    p.add({ projectId: PROJECT_ID, repo: REPO });
    const fn = vi.fn();
    p.setLifecycleHook(fn);
    await p.poll();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('thrown hook does not crash the cycle', async () => {
    const p = makePoller(okRunner());
    p.add({ projectId: PROJECT_ID, repo: REPO });
    p.setLifecycleHook(() => {
      throw new Error('hook is buggy');
    });
    await expect(p.poll()).resolves.toBeUndefined();
    expect(p.snapshots()[0].consecutiveFailures).toBe(0);
  });

  it('snapshots() inside hook reflect current entry status (isPolling=true mid-cycle)', async () => {
    const p = makePoller(okRunner());
    p.add({ projectId: PROJECT_ID, repo: REPO });
    const isPollingAt: boolean[] = [];
    p.setLifecycleHook(() => {
      isPollingAt.push(p.snapshots()[0].isPolling);
    });
    await p.poll();
    expect(isPollingAt).toEqual([true, false]);
  });
});

describe('GitHubPoller.start()', () => {
  suppressConsole();

  it('captures intervalMs in snapshots after start()', () => {
    const p = makePoller(okRunner());
    p.add({ projectId: PROJECT_ID, repo: REPO });
    p.start(45_000);
    expect(p.snapshots()[0].intervalMs).toBe(45_000);
    p.stop();
  });
});
