import { afterEach, describe, expect, it } from 'vitest';
import {
  buildProjectDriver,
  buildProjectPromptContext,
  InvalidRepoClaimError,
  makeDriverExec,
  registerPlatformProvider,
  repoIdentityKey,
  resetPlatformProviders,
  resolveRepo,
} from '../../src/platform/driver-host.js';
import type { DriverExecResult, PlatformDriver } from '../../src/platform/types.js';
import type { CommandRunner, ExecOptions, ExecResult } from '../../src/agent/runner.js';
import type { ProjectConfig } from '../../src/shared/index.js';
import { scanCommentSourcesOnce } from '../../src/platform/feedback.js';
import {
  buildAckMarker, buildReviewTokenLine, rowAcks, rowBodyDigest, rowHasBody, rowTokens,
} from '../../src/platform/markers.js';
import { bodyDigest } from '../../src/platform/body-digest.js';
import { versionTimeOf } from '../../src/platform/row-schema.js';
import { makePlatformProvider } from '../helpers/fixtures.js';

const project: ProjectConfig = {
  id: 'p1',
  repo: 'git@github.com:owner/repo.git',
  merge: null,
  agent: [],
};
const NO_EXEC = () => Promise.reject(new Error('exec must not run during construction'));

const FAKE_DRIVER = {
  visibilityLagMs: 1,
  commentSources: [{ key: 'notes', category: 'top-level' }],
} as unknown as PlatformDriver;
const fakeProvider = makePlatformProvider({
  platform: 'git.corp.example',
  createDriver: () => FAKE_DRIVER,
});

afterEach(() => {
  resetPlatformProviders();
});

describe('buildProjectDriver', () => {
  it('builds the built-in GitHub driver for github.com repositories', () => {
    const first = buildProjectDriver(project, NO_EXEC);
    const second = buildProjectDriver(project, NO_EXEC);
    expect(first.commentSources.map(source => source.key))
      .toEqual(['issue-comments', 'inline-comments', 'reviews']);
    expect(first.visibilityLagMs).toBe(5_000);
    expect(second).not.toBe(first);
  });

  it('rejects repositories no installed platform recognizes', () => {
    expect(() => buildProjectDriver({ ...project, repo: 'https://gitlab.com/o/r.git' }, NO_EXEC))
      .toThrow(/no installed platform recognizes/);
  });
});

describe('platform provider registry', () => {
  it('routes repositories to the provider that claims them and keeps GitHub working', () => {
    registerPlatformProvider(fakeProvider);
    const corp = { ...project, repo: 'https://git.corp.example/group/sub/repo.git' };
    expect(buildProjectDriver(corp, NO_EXEC)).toMatchObject({ visibilityLagMs: 1 });
    expect(buildProjectDriver(project, NO_EXEC).visibilityLagMs).toBe(5_000);
    expect(buildProjectPromptContext(corp)).toEqual({
      repo: 'group/sub/repo',
      prompts: fakeProvider.prompts,
    });
  });

  it('namespaces identity keys by platform and falls back to the raw URL when unclaimed', () => {
    registerPlatformProvider(fakeProvider);
    expect(repoIdentityKey('https://git.corp.example/group/repo.git')).toBe('git.corp.example/group/repo');
    expect(repoIdentityKey('https://github.com/Owner/Repo.git')).toBe('github.com/owner/repo');
    expect(repoIdentityKey(' https://elsewhere.example/x.git ')).toBe('https://elsewhere.example/x.git');
    expect(resolveRepo('https://elsewhere.example/x.git')).toBeNull();
  });

  it('rejects duplicate platform names and providers returning empty slugs', () => {
    registerPlatformProvider(fakeProvider);
    expect(() => registerPlatformProvider(fakeProvider)).toThrow(/already registered/);
    expect(() => registerPlatformProvider({ ...fakeProvider, platform: 'github.com' }))
      .toThrow(/already registered/);

    registerPlatformProvider({
      ...fakeProvider,
      platform: 'empty.example',
      normalizeRepoUrl: url => (url.startsWith('https://empty.example/') ? '' : null),
    });
    expect(() => resolveRepo('https://empty.example/x')).toThrow(/invalid repo slug/);
  });

  it('keeps built-ins ahead of plugins so a broad matcher cannot take over github.com', () => {
    registerPlatformProvider({
      ...fakeProvider,
      platform: 'greedy.example',
      normalizeRepoUrl: url => (url.startsWith('https://') ? url.slice('https://'.length) : null),
    });
    expect(resolveRepo('https://github.com/o/r.git')).toMatchObject({ identityKey: 'github.com/o/r' });
    expect(resolveRepo('https://greedy.example/x')).toMatchObject({
      identityKey: 'greedy.example/greedy.example/x',
    });
  });

  it('fails loudly when multiple plugins claim the same repository URL instead of picking one', () => {
    registerPlatformProvider(fakeProvider);
    registerPlatformProvider({ ...fakeProvider, platform: 'mirror.example' });
    expect(() => resolveRepo('https://git.corp.example/group/repo.git'))
      .toThrow(/claimed by multiple platform plugins \(git\.corp\.example, mirror\.example\)/);
    expect(resolveRepo('https://github.com/o/r.git')).toMatchObject({ identityKey: 'github.com/o/r' });
  });

  it('restores the built-in-only registry on reset', () => {
    registerPlatformProvider(fakeProvider);
    resetPlatformProviders();
    expect(resolveRepo('https://git.corp.example/group/repo.git')).toBeNull();
    expect(resolveRepo('https://github.com/o/r.git')).not.toBeNull();
  });
});

describe('driver row validation boundary', () => {
  const SHA = 'a'.repeat(40);

  function singlePageComments(page: Record<string, unknown>[]) {
    return async (
      _source: unknown,
      _prNumber: number,
      projectPage?: (rows: Record<string, unknown>[]) => Record<string, unknown>[],
    ) => (projectPage === undefined ? page : projectPage(page));
  }

  function numericIdDriver(prRow: Record<string, unknown>, commentBody = 'x'): PlatformDriver {
    return {
      visibilityLagMs: 1,
      commentSources: [{ key: 'notes', category: 'top-level' }],
      runPreflightSteps: async () => [],
      projectView: async () => ({ defaultBranch: 'main' }),
      prView: async () => prRow,
      branchView: async (remoteProjectId: string) => ({ remoteProjectId }),
      listPrs: async () => [],
      listComments: singlePageComments([{
        id: 101, body: commentBody,
        createdAt: '2026-08-05T00:00:00Z', updatedAt: '2026-08-05T00:00:00Z',
      }]),
      postComment: async () => undefined,
      mergePr: async () => undefined,
      closePr: async () => undefined,
      deleteBranch: async () => undefined,
    } as unknown as PlatformDriver;
  }
  const GOOD_PR = {
    prUrl: 'https://num.example/pr/1', branch: 'b', headSha: SHA, state: 'open',
    draft: false, sourceProjectId: 7, targetProjectId: 7, targetBranch: 'main',
  };

  function buildOn(platform: string, driver: PlatformDriver): PlatformDriver {
    resetPlatformProviders();
    registerPlatformProvider(makePlatformProvider({ platform, createDriver: () => driver }));
    return buildProjectDriver({ ...project, repo: `https://${platform}/g/r.git` }, NO_EXEC);
  }

  const driverFor = (prRow: Record<string, unknown>, commentBody?: string): PlatformDriver =>
    buildOn('num.example', numericIdDriver(prRow, commentBody));

  it('normalizes plugin rows before any consumer, including each listComments page', async () => {
    const driver = driverFor(GOOD_PR);
    const pages: unknown[] = [];
    const rows = await driver.listComments({ key: 'notes', category: 'top-level' }, 1, pageRows => {
      pages.push(pageRows[0]);
      return pageRows;
    });
    expect(pages[0]).toMatchObject({ id: '101' });
    expect(rows[0]).toMatchObject({ id: '101' });
    await expect(driver.prView(1)).resolves.toMatchObject({
      sourceProjectId: '7',
      targetProjectId: '7',
      headSha: SHA,
    });
  });

  it('rejects plugin rows that violate the row schema instead of passing them through', async () => {
    const driver = driverFor({ ...GOOD_PR, state: 'merged' });
    await expect(driver.prView(1)).rejects.toThrow(/state.*must be 'open' \| 'closed'/);
  });

  it('rejects comment source keys the ack-marker grammar cannot parse back', () => {
    for (const key of ['merge_request_notes', 'review.comments', 'Notes', '1notes']) {
      const bad = { ...numericIdDriver(GOOD_PR), commentSources: [{ key, category: 'top-level' }] };
      expect(() => buildOn('badkey.example', bad as PlatformDriver))
        .toThrow(new RegExp(`platform 'badkey\\.example': comment source key '${key.replace(/[.]/g, '\\.')}' must match`));
    }
  });

  it('rejects non-finite or negative visibilityLagMs but accepts zero', () => {
    for (const lag of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(() => buildOn('badlag.example', { ...numericIdDriver(GOOD_PR), visibilityLagMs: lag } as PlatformDriver))
        .toThrow(/platform 'badlag\.example': visibilityLagMs must be a finite number >= 0/);
    }
    const driver = buildOn('zerolag.example', { ...numericIdDriver(GOOD_PR), visibilityLagMs: 0 } as PlatformDriver);
    expect(driver.visibilityLagMs).toBe(0);
  });

  it('rejects duplicate comment source keys and unknown categories', () => {
    const withSources = (commentSources: unknown): PlatformDriver =>
      ({ ...numericIdDriver(GOOD_PR), commentSources } as PlatformDriver);
    expect(() => buildOn('badsrc.example', withSources([
      { key: 'notes', category: 'top-level' },
      { key: 'notes', category: 'threaded' },
    ]))).toThrow(/comment source key 'notes' is declared more than once/);
    expect(() => buildOn('badsrc.example', withSources([{ key: 'reviews', category: 'review' }])))
      .toThrow(/invalid category 'review'/);
    expect(() => buildOn('badsrc.example', withSources('notes')))
      .toThrow(/platform 'badsrc\.example': commentSources must be an array/);
  });

  it('rejects sources whose key is missing or not a string before RegExp coercion can pass them', () => {
    const withSources = (commentSources: unknown): PlatformDriver =>
      ({ ...numericIdDriver(GOOD_PR), commentSources } as PlatformDriver);
    for (const sources of [
      [{ category: 'top-level' }],
      [{ key: null, category: 'top-level' }],
      ['notes'],
    ]) {
      expect(() => buildOn('badsrc.example', withSources(sources)))
        .toThrow(/comment source at index 0 must be an object with a string key/);
    }
  });

  it('requires at least one source but accepts a reviews-only platform', () => {
    const withSources = (commentSources: unknown): PlatformDriver =>
      ({ ...numericIdDriver(GOOD_PR), commentSources } as PlatformDriver);
    expect(() => buildOn('badsrc.example', withSources([])))
      .toThrow(/must declare at least one source/);
    const ok = buildOn('oksrc.example', withSources([{ key: 'reviews', category: 'reviews' }]));
    expect(ok.commentSources).toHaveLength(1);
  });

  it('vets the preflight result shape so a plugin violation names the field instead of a consumer TypeError', async () => {
    const withPreflight = (runPreflightSteps: unknown): PlatformDriver =>
      buildOn('pf.example', { ...numericIdDriver(GOOD_PR), runPreflightSteps } as PlatformDriver);
    const ok = withPreflight(async () => [{ step: 'auth', ok: true, message: 'signed in' }]);
    await expect(ok.runPreflightSteps()).resolves.toEqual([{ step: 'auth', ok: true, message: 'signed in' }]);
    const classified = withPreflight(async () => [{ step: 'auth', ok: false, message: 'log in', errorClass: 'ACCESS_DENIED' }]);
    await expect(classified.runPreflightSteps()).resolves.toEqual([
      { step: 'auth', ok: false, message: 'log in', errorClass: 'ACCESS_DENIED' },
    ]);
    const cases: Array<[unknown, RegExp]> = [
      [null, /runPreflightSteps must return an array \(got null\)/],
      ['ready', /runPreflightSteps must return an array \(got string\)/],
      [['auth ok'], /runPreflightSteps\[0\] must be an object/],
      [[{ step: 'auth', ok: true, message: 'x' }, { step: 7, ok: true, message: 'x' }], /runPreflightSteps\[1\]\.step must be a string/],
      [[{ step: 'auth', ok: 'false', message: 'x' }], /runPreflightSteps\[0\]\.ok must be a boolean/],
      [[{ step: 'auth', ok: true }], /runPreflightSteps\[0\]\.message must be a string/],
      [[{ step: 'auth', ok: false, message: 'x', errorClass: 401 }], /runPreflightSteps\[0\]\.errorClass must be a string when present/],
    ];
    for (const [result, expected] of cases) {
      await expect(withPreflight(async () => result).runPreflightSteps()).rejects.toThrow(expected);
    }
  });

  it('normalizes each listPrs page before the stop predicate sees it', async () => {
    const seen: unknown[] = [];
    const driver = buildOn('stoppr.example', {
      ...numericIdDriver(GOOD_PR),
      listPrs: async (shouldStop?: (pageRows: Record<string, unknown>[], page: number) => boolean) => {
        const page = [{
          ...GOOD_PR, prNumber: 1, updatedAt: '2026-08-05T00:00:00Z', versionTime: 0, sourceProjectId: 7,
        }];
        if (shouldStop?.(page, 0) === true) return page;
        return [...page, { ...GOOD_PR, prNumber: 2, updatedAt: '2026-08-06T00:00:00Z' }];
      },
    } as PlatformDriver);
    const rows = await driver.listPrs((pageRows) => {
      seen.push(pageRows[0]);
      return pageRows.some(r => typeof r.versionTime === 'number' && r.versionTime < 1);
    });
    expect(seen[0]).toMatchObject({ prNumber: 1, sourceProjectId: '7' });
    expect((seen[0] as Record<string, unknown>).versionTime).toBeUndefined();
    expect(rows).toHaveLength(2);
  });

  it('returns the callback-vetted rows even when the plugin ignores the callback return value', async () => {
    const driver = buildOn('agg.example', {
      ...numericIdDriver(GOOD_PR),
      listComments: async (
        _source: unknown,
        _prNumber: number,
        projectPage?: (rows: Record<string, unknown>[]) => Record<string, unknown>[],
      ) => {
        const raw = [{ id: 101, body: 'x', updatedAt: '2026-08-05T00:00:00Z', versionTime: 9e15 }];
        projectPage?.(raw.map(r => ({ ...r })));
        return raw;
      },
    } as PlatformDriver);
    const rows = await driver.listComments({ key: 'notes', category: 'top-level' }, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: '101' });
    expect(rows[0]!.versionTime).toBeUndefined();
  });

  it('fails the operation when a plugin swallows a page validation error and returns anyway', async () => {
    const driver = buildOn('swallow.example', {
      ...numericIdDriver(GOOD_PR),
      listComments: async (
        _source: unknown,
        _prNumber: number,
        projectPage?: (rows: Record<string, unknown>[]) => Record<string, unknown>[],
      ) => {
        try {
          projectPage?.([{ id: 101, state: 'weird' }]);
        } catch {
          // plugin ignores the failure and returns a clean-looking aggregate
        }
        return [{ id: 101, updatedAt: '2026-08-05T00:00:00Z' }];
      },
    } as PlatformDriver);
    await expect(driver.listComments({ key: 'notes', category: 'top-level' }, 1))
      .rejects.toThrow(/state.*must be 'open' \| 'closed'/);
  });

  it('strips a smuggled versionTime so raw rows cannot preempt timestamp parsing', async () => {
    const at = '2026-08-05T00:00:00Z';
    const pr = await driverFor({ ...GOOD_PR, updatedAt: at, versionTime: Number.NaN }).prView(1);
    expect(pr.versionTime).toBeUndefined();
    expect(versionTimeOf(pr)).toBe(Date.parse(at));

    const comments = buildOn('vt.example', {
      ...numericIdDriver(GOOD_PR),
      listComments: singlePageComments([{ id: 1, updatedAt: at, versionTime: 9e15 }]),
    } as PlatformDriver);
    const rows = await comments.listComments({ key: 'notes', category: 'top-level' }, 1);
    expect(rows[0]!.versionTime).toBeUndefined();
    expect(versionTimeOf(rows[0]!)).toBe(Date.parse(at));
  });

  it('rejects PR rows missing sourceProjectId but keeps the explicit-null fork semantics', async () => {
    const { sourceProjectId: _dropped, ...missing } = GOOD_PR;
    await expect(driverFor(missing).prView(1))
      .rejects.toThrow(/prView: row 0 field 'sourceProjectId': missing \(use null when the source repository is gone\)/);
    await expect(driverFor({ ...GOOD_PR, sourceProjectId: null }).prView(1))
      .resolves.toMatchObject({ sourceProjectId: null });
  });

  it('rejects threaded comment rows missing discussionId but accepts explicit null roots', async () => {
    const threadedDriver = (row: Record<string, unknown>): PlatformDriver => ({
      ...numericIdDriver(GOOD_PR),
      commentSources: [{ key: 'inline-notes', category: 'threaded' }],
      listComments: singlePageComments([row]),
    } as unknown as PlatformDriver);
    const baseRow = {
      id: 7, body: 'x',
      createdAt: '2026-08-05T00:00:00Z', updatedAt: '2026-08-05T00:00:00Z',
    };
    const source = { key: 'inline-notes', category: 'threaded' as const };

    await expect(buildOn('threaded.example', threadedDriver(baseRow)).listComments(source, 1))
      .rejects.toThrow(/listComments\[inline-notes\]: row 0 field 'discussionId': missing \(thread roots use null or their own id\)/);
    await expect(buildOn('threaded.example', threadedDriver({ ...baseRow, discussionId: null })).listComments(source, 1))
      .resolves.toMatchObject([{ id: '7', discussionId: null }]);
  });

  it('applies the threaded contract to plugin rows, not to the caller projection a stop predicate sees', async () => {
    const rawPage = [{
      id: 7, body: 'x', discussionId: null,
      createdAt: '2026-08-05T00:00:00Z', updatedAt: '2026-08-05T00:00:00Z',
    }];
    const stopPages: unknown[] = [];
    const threaded = {
      ...numericIdDriver(GOOD_PR),
      commentSources: [{ key: 'inline-notes', category: 'threaded' }],
      listComments: async (
        _source: unknown,
        _prNumber: number,
        projectPage?: (rows: Record<string, unknown>[]) => Record<string, unknown>[],
        shouldStop?: (rows: Record<string, unknown>[], page: number) => boolean,
      ) => {
        const projected = projectPage === undefined ? rawPage : projectPage(rawPage);
        shouldStop?.(projected, 1);
        return projected;
      },
    } as unknown as PlatformDriver;
    const driver = buildOn('threadedstop.example', threaded);
    const rows = await driver.listComments(
      { key: 'inline-notes', category: 'threaded' },
      1,
      pageRows => pageRows.map(r => ({ id: r.id })),
      pageRows => {
        stopPages.push(pageRows);
        return false;
      },
    );
    expect(rows).toMatchObject([{ id: '7' }]);
    expect(stopPages).toHaveLength(1);
  });

  it('treats an undefined claim as unclaimed but rejects malformed slugs with a typed error', () => {
    registerPlatformProvider(makePlatformProvider({
      platform: 'sloppy.example',
      normalizeRepoUrl: url =>
        (url.startsWith('https://sloppy.example/') ? 'g/r' : undefined) as string | null,
    }));
    expect(resolveRepo('https://elsewhere.example/x.git')).toBeNull();
    expect(resolveRepo('https://sloppy.example/g/r.git')).toMatchObject({ identityKey: 'sloppy.example/g/r' });

    resetPlatformProviders();
    registerPlatformProvider(makePlatformProvider({
      platform: 'broken.example',
      normalizeRepoUrl: () => 42 as unknown as string,
    }));
    expect(() => resolveRepo('https://broken.example/x'))
      .toThrow(InvalidRepoClaimError);
  });

  it('keeps projected comment metadata (digest, tokens, acks) intact through the scan chain', async () => {
    const body = [
      'real feedback body',
      buildReviewTokenLine({ kind: 'pass', anchorSha: SHA, token: 'tok-123456' }),
      buildAckMarker({ sourceKey: 'notes', commentId: '9' }),
    ].join('\n');
    const driver = driverFor(GOOD_PR, body);

    const scans = await scanCommentSourcesOnce(driver, 1, () => 0);
    expect(scans).toHaveLength(1);
    const row = scans[0]!.rows[0]!;
    expect(row).toMatchObject({ id: '101' });
    expect(rowHasBody(row)).toBe(true);
    expect(rowBodyDigest(row)).toBe(bodyDigest(body));
    expect(rowTokens(row)).toEqual([{ kind: 'pass', anchorSha: SHA, token: 'tok-123456' }]);
    expect(rowAcks(row)).toEqual([{ sourceKey: 'notes', commentId: '9' }]);
  });
});

describe('makeDriverExec', () => {
  function runnerWith(value: ExecResult): CommandRunner {
    return {
      exec: async () => value,
      writeFile: async () => undefined,
      execWithStdin: async () => value,
    };
  }

  it('passes through non-zero results and execution limits', async () => {
    let seen: ExecOptions | undefined;
    const runner: CommandRunner = {
      ...runnerWith({ stdout: 'out', stderr: 'HTTP 404', exitCode: 1 }),
      exec: async (_command, options) => {
        seen = options;
        return { stdout: 'out', stderr: 'HTTP 404', exitCode: 1 };
      },
    };
    const value: DriverExecResult = await makeDriverExec(runner)('gh api x', {
      timeout: 1234,
      maxBuffer: 4096,
    });
    expect(value).toEqual({ stdout: 'out', stderr: 'HTTP 404', exitCode: 1 });
    expect(seen).toEqual({ timeout: 1234, maxBuffer: 4096 });
  });

  it('uses execWithStdin whenever stdin is present, including an empty buffer', async () => {
    let seen: { command: string; stdin: Buffer; options?: ExecOptions } | undefined;
    const runner: CommandRunner = {
      exec: async () => { throw new Error('plain exec must not receive stdin-backed operations'); },
      writeFile: async () => undefined,
      execWithStdin: async (command, stdin, options) => {
        seen = { command, stdin, options };
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    };
    await makeDriverExec(runner)('gh api comment', {
      timeout: 1234,
      maxBuffer: 4096,
      stdin: Buffer.alloc(0),
    });
    expect(seen).toEqual({
      command: 'gh api comment',
      stdin: Buffer.alloc(0),
      options: { timeout: 1234, maxBuffer: 4096 },
    });
  });
});
