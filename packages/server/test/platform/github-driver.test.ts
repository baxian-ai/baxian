import { describe, expect, it, vi } from 'vitest';
import {
  GITHUB_AGENT_PROMPTS,
  GITHUB_AUTH_FIX,
  GitHubDriver,
  githubProvider,
} from '../../src/platform/github-driver.js';
import type { DriverExecResult } from '../../src/platform/types.js';
import { DriverInputError, DriverOpError, safeDriverErrorText } from '../../src/platform/types.js';
import { RowSchemaError } from '../../src/platform/row-schema.js';

const SHA = 'a'.repeat(40);

function result(stdout = '', exitCode = 0, stderr = ''): DriverExecResult {
  return { stdout, stderr, exitCode };
}

function harness(outputs: DriverExecResult[]) {
  const calls: Array<{ command: string; stdin?: Buffer }> = [];
  const exec = vi.fn(async (command: string, opts: { stdin?: Buffer }) => {
    calls.push({ command, stdin: opts.stdin });
    return outputs.shift() ?? result('[]');
  });
  return { driver: githubProvider.createDriver('owner/repo', exec), calls, exec };
}

describe('GitHubDriver', () => {
  it('maps a GitHub PR response and scopes every command to github.com and the configured repository', async () => {
    const { driver, calls } = harness([result(JSON.stringify({
      html_url: 'https://github.com/owner/repo/pull/42',
      head: { ref: 'bx/task-1', sha: SHA, repo: { id: 10 } },
      base: { ref: 'main', repo: { id: 10 } },
      state: 'open',
      draft: false,
      merged_at: null,
      user: { login: 'alice', id: 7 },
      mergeable_state: 'clean',
    }))]);

    await expect(driver.prView(42)).resolves.toEqual(expect.objectContaining({
      branch: 'bx/task-1',
      headSha: SHA,
      targetBranch: 'main',
      targetProjectId: '10',
    }));
    expect(calls[0]!.command).toContain("GH_HOST='github.com'");
    expect(calls[0]!.command).toContain('repos/owner/repo/pulls/42');
  });

  it('keeps a deleted fork source explicit as null instead of dropping the field', async () => {
    const { driver } = harness([result(JSON.stringify({
      html_url: 'https://github.com/owner/repo/pull/43',
      head: { ref: 'bx/task-2', sha: SHA, repo: null },
      base: { ref: 'main', repo: { id: 10 } },
      state: 'open',
      draft: false,
      merged_at: null,
      user: { login: 'alice', id: 7 },
      mergeable_state: 'clean',
    }))]);
    await expect(driver.prView(43)).resolves.toEqual(expect.objectContaining({
      sourceProjectId: null,
      targetProjectId: '10',
    }));
  });

  it('fills explicit null thread roots for inline comments without in_reply_to_id', async () => {
    const { driver } = harness([
      result(JSON.stringify([{
        id: 31, body: 'root', user: { login: 'bob', id: 8 },
        created_at: '2026-08-05T00:00:00Z', updated_at: '2026-08-05T00:00:00Z',
        path: 'a.ts', line: 3,
      }])),
      result('[]'),
    ]);
    const rows = await driver.listComments({ key: 'inline-comments', category: 'threaded' }, 42);
    expect(rows[0]).toMatchObject({ id: '31', discussionId: null, parentId: null });
  });

  it('passes comment text through stdin and rejects empty, NUL, or oversized bodies', async () => {
    const { driver, calls } = harness([result()]);
    await expect(driver.postComment(42, 'hello $(unsafe)')).resolves.toBeUndefined();
    expect(calls[0]!.stdin?.toString('utf8')).toBe('hello $(unsafe)');
    expect(calls[0]!.command).not.toContain('hello');

    await expect(driver.postComment(42, '  ')).rejects.toThrow(DriverInputError);
    await expect(driver.postComment(42, 'x\0y')).rejects.toThrow(/NUL/);
    await expect(driver.postComment(42, 'x'.repeat(65 * 1024))).rejects.toThrow(/exceeds/);
  });

  it('validates operation inputs before execution', async () => {
    const { driver, exec } = harness([]);
    await expect(driver.prView(0)).rejects.toThrow(/positive/);
    await expect(driver.mergePr(1, 'not-a-sha')).rejects.toThrow(/hex sha/);
    await expect(driver.deleteBranch('R_repo', 'bad..branch', SHA)).rejects.toThrow(/branch/);
    expect(exec).not.toHaveBeenCalled();
  });

  it('classifies platform failures without exposing their diagnostic text through the safe formatter', async () => {
    const { driver } = harness([result('', 1, 'HTTP 403 secret-token')]);
    const error = await driver.projectView().catch(value => value as DriverOpError);
    expect(error).toBeInstanceOf(DriverOpError);
    expect(error.info.errorClass).toBe('ACCESS_DENIED');
    expect(safeDriverErrorText(error)).toBe('op projectView failed (exit 1, class ACCESS_DENIED)');
    expect(safeDriverErrorText(error)).not.toContain('secret-token');
  });

  it('fails closed on GraphQL errors even when gh exits zero', async () => {
    const { driver } = harness([result(JSON.stringify({ data: null, errors: [{ message: 'denied' }] }))]);
    await expect(driver.branchView('R_repo', 'bx/task-1')).rejects.toThrow(/GraphQL errors/);
  });

  it('requires one valid row from single-resource reads', async () => {
    const missing = harness([result('null')]).driver;
    await expect(missing.projectView()).rejects.toThrow(/exactly one row/);

    const malformed = harness([result(JSON.stringify({ default_branch: 12 }))]).driver;
    await expect(malformed.projectView()).rejects.toThrow(RowSchemaError);
  });

  it('paginates PRs, deduplicates exact overlap, and stops on the caller watermark', async () => {
    const row = (number: number, updatedAt: string) => ({
      number,
      html_url: `https://github.com/owner/repo/pull/${number}`,
      head: { ref: `bx/task-${number}`, sha: SHA, repo: { id: 1 } },
      base: { ref: 'main', repo: { id: 1 } },
      state: 'open', draft: false, merged_at: null, updated_at: updatedAt, title: `PR ${number}`,
      user: { login: 'alice', id: 7 },
    });
    const { driver } = harness([
      result(JSON.stringify([row(2, '2026-07-31T00:00:02Z'), row(1, '2026-07-31T00:00:01Z')])),
      result(JSON.stringify([row(1, '2026-07-31T00:00:01Z'), row(3, '2026-07-31T00:00:00Z')])),
    ]);
    const rows = await driver.listPrs((_page, page) => page === 2);
    expect(rows.map(value => value.prNumber)).toEqual([2, 1, 3]);
  });

  it('fails when pagination stalls or a duplicate id changes during a scan', async () => {
    const raw = (title: string) => ({
      number: 1, html_url: 'https://github.com/owner/repo/pull/1',
      head: { ref: 'bx/task-1', sha: SHA, repo: { id: 1 } }, base: { ref: 'main', repo: { id: 1 } },
      state: 'open', draft: false, merged_at: null, updated_at: '2026-07-31T00:00:00Z', title,
      user: { login: 'alice', id: 7 },
    });
    const stalled = harness([result(JSON.stringify([raw('same')])), result(JSON.stringify([raw('same')]))]).driver;
    await expect(stalled.listPrs()).rejects.toThrow(/did not advance/);

    const changed = harness([
      result(JSON.stringify([raw('before'), { ...raw('other'), number: 2 }])),
      result(JSON.stringify([raw('after'), { ...raw('third'), number: 3 }])),
    ]).driver;
    await expect(changed.listPrs()).rejects.toThrow(/conflicting duplicate/);
  });

  it('maps each fixed GitHub feedback source and rejects unknown sources', async () => {
    const issue = harness([result(JSON.stringify([{
      id: 11, body: 'hello', user: { login: 'alice', id: 7 },
      created_at: '2026-07-31T00:00:00Z', updated_at: '2026-07-31T00:00:00Z',
    }])), result('[]')]);
    const issueRows = await issue.driver.listComments(issue.driver.commentSources[0]!, 42);
    expect(issueRows).toEqual([expect.objectContaining({ id: '11', body: 'hello', author: 'alice' })]);

    const inline = harness([result(JSON.stringify([{
      id: 12, body: 'inline', user: { login: 'bob', id: 8 }, in_reply_to_id: 10,
      path: 'src/a.ts', line: 7, original_line: 6,
      created_at: '2026-07-31T00:00:01Z', updated_at: '2026-07-31T00:00:02Z',
    }])), result('[]')]);
    const inlineRows = await inline.driver.listComments(inline.driver.commentSources[1]!, 42);
    expect(inlineRows).toEqual([expect.objectContaining({
      id: '12', discussionId: '10', parentId: '10', path: 'src/a.ts', line: 7, originalLine: 6,
    })]);

    const review = harness([result(JSON.stringify([{
      id: 13, body: 'review', user: { login: 'carol', id: 9 }, state: 'APPROVED',
      submitted_at: '2026-07-31T00:00:03Z', commit_id: SHA,
    }])), result('[]')]);
    const reviewRows = await review.driver.listComments(review.driver.commentSources[2]!, 42);
    expect(reviewRows).toEqual([expect.objectContaining({
      id: '13', reviewState: 'APPROVED', commitSha: SHA, createdAt: '2026-07-31T00:00:03Z',
    })]);

    expect(() => issue.driver.listComments({ key: 'future-source', category: 'top-level' }, 42))
      .toThrow(/unknown GitHub comment source/);
  });

  it('states every server-matched ACK source key in the feedback contract', () => {
    const { driver } = harness([]);
    for (const source of driver.commentSources) {
      expect(GITHUB_AGENT_PROMPTS.feedback).toContain(source.key);
    }
    expect(GITHUB_AGENT_PROMPTS.feedback).toContain('baxian:reply:ack:<source-key>:<comment-id>');
  });

  it('states the adopt-or-create publish semantics without any signal actor encoding', () => {
    expect(GITHUB_AGENT_PROMPTS.publish).toContain('reuse or create one open non-draft PR');
    expect(GITHUB_AGENT_PROMPTS.publish).toContain('exact head');
    expect(GITHUB_AGENT_PROMPTS.publish).toContain('requested/default base');
    expect(GITHUB_AGENT_PROMPTS.publish).toContain('stop on ambiguity');
    expect(GITHUB_AGENT_PROMPTS.publish).not.toMatch(/base64|actor|gh api user/);
  });

  it('checks the authenticated GitHub identity and classifies rate limits', async () => {
    const good = harness([result('{"login":"alice"}')]);
    await expect(good.driver.runPreflightSteps()).resolves.toEqual([
      { step: 'github-auth', ok: true, message: 'GitHub CLI authenticated' },
    ]);

    const unauthenticated = harness([result('', 1, 'not logged in')]);
    await expect(unauthenticated.driver.runPreflightSteps()).resolves.toEqual([
      { step: 'github-auth', ok: false, message: GITHUB_AUTH_FIX },
    ]);
    // GH_TOKEN/GITHUB_TOKEN override stored logins, so the fix must start there before suggesting gh auth login.
    expect(GITHUB_AUTH_FIX).toMatch(/GH_TOKEN or GITHUB_TOKEN[\s\S]*replace or unset[\s\S]*otherwise run "gh auth login --hostname github.com"/);

    const badCredentials = harness([result('', 1, 'gh: Bad credentials (HTTP 401)')]);
    await expect(badCredentials.driver.runPreflightSteps()).resolves.toEqual([
      expect.objectContaining({ step: 'github-auth', ok: false, errorClass: 'ACCESS_DENIED' }),
    ]);

    const limited = harness([result('', 1, 'secondary rate limit')]);
    await expect(limited.driver.runPreflightSteps()).rejects.toMatchObject({
      info: { errorClass: 'RATE_LIMIT' },
    });
  });
});

describe('githubProvider', () => {
  it('normalizes every supported URL form to one lowercase slug', () => {
    for (const url of [
      'https://github.com/Owner/Repo.git',
      'https://github.com/Owner/Repo',
      'https://github.com/Owner/Repo/',
      'git@github.com:Owner/Repo.git',
      'ssh://git@github.com/Owner/Repo.git',
      '  https://github.com/Owner/Repo.git  ',
    ]) {
      expect.soft(githubProvider.normalizeRepoUrl(url), url).toBe('owner/repo');
    }
  });

  it('accepts dot-prefixed repo names but rejects bare dot segments', () => {
    for (const [url, slug] of [
      ['https://github.com/org/.github', 'org/.github'],
      ['https://github.com/org/.github.git', 'org/.github'],
      ['git@github.com:org/.github-private.git', 'org/.github-private'],
    ] as const) {
      expect.soft(githubProvider.normalizeRepoUrl(url), url).toBe(slug);
    }
    for (const url of [
      'https://github.com/org/.',
      'https://github.com/org/..',
      'https://github.com/org/...git',
    ]) {
      expect.soft(githubProvider.normalizeRepoUrl(url), url).toBeNull();
    }
  });

  it('rejects shorthands, other hosts, insecure HTTP, ports, and malformed paths', () => {
    for (const url of [
      'owner/repo',
      'https://gitlab.com/owner/repo.git',
      'http://github.com/owner/repo.git',
      'https://github.com:443/owner/repo.git',
      'ssh://git@github.com:22/owner/repo.git',
      'https://github.com/group/sub/repo.git',
      'https://github.com/.dot/repo.git',
      'not-a-url',
      '',
    ]) {
      expect.soft(githubProvider.normalizeRepoUrl(url), url).toBeNull();
    }
  });

  it('builds a GitHubDriver bound to the canonical slug', () => {
    const driver = githubProvider.createDriver('owner/repo', async () => result('[]'));
    expect(driver).toBeInstanceOf(GitHubDriver);
    expect(githubProvider.platform).toBe('github.com');
    expect(githubProvider.prompts).toBe(GITHUB_AGENT_PROMPTS);
  });
});
