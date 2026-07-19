import { describe, it, expect } from 'vitest';
import {
  GitDriver, DriverOpError, buildDriverRunContext,
  DRIVER_MAX_BUFFER, DRIVER_EXEC_TIMEOUT_MS,
  type DriverExec, type DriverExecResult,
} from '../../src/platform/git-driver.js';
import { parseDriverSpec } from '../../src/platform/driver-spec.js';
import { RowSchemaError } from '../../src/platform/row-schema.js';
import { DRIVER } from './plugin-fixtures.js';

const SHA = 'b'.repeat(40);
const PR = {
  number: 42, html_url: 'https://github.com/o/r/pull/42', state: 'open', draft: false,
  merged_at: null, updated_at: '2026-07-17T00:00:01Z',
  head: { ref: 'bx/task-1', sha: SHA, repo: { id: 7 } }, base: { ref: 'main', repo: { id: 7 } },
};

function spec(raw: string = DRIVER) {
  const r = parseDriverSpec(raw, '/p/github');
  if ('errors' in r) throw new Error(r.errors.map(e => e.message).join('\n'));
  return r.spec;
}

const CTX = buildDriverRunContext('git@github.com:o/r.git', 'gh');

function driverWith(routes: Record<string, DriverExecResult | ((page: number) => DriverExecResult)>, rawSpec?: string) {
  const calls: Array<{ cmd: string; opts: { timeout: number; maxBuffer: number } }> = [];
  const exec: DriverExec = async (cmd, opts) => {
    calls.push({ cmd, opts });
    for (const [needle, result] of Object.entries(routes)) {
      if (cmd.includes(needle)) {
        if (typeof result === 'function') {
          const page = Number(/[?&]page=(\d+)/.exec(cmd)?.[1] ?? '1');
          return result(page);
        }
        return result;
      }
    }
    throw new Error(`no route for command: ${cmd}`);
  };
  return { driver: new GitDriver({ spec: spec(rawSpec) }, CTX, exec), calls };
}

const ok = (payload: unknown): DriverExecResult => ({ stdout: JSON.stringify(payload), stderr: '', exitCode: 0 });

describe('GitDriver: single-command ops', () => {
  it('runs the render → parse → map → validate chain', async () => {
    const { driver, calls } = driverWith({ 'pulls/42': ok(PR) });
    const [row] = await driver.runOp('prView', { prNumber: 42 });
    expect(row!.headSha).toBe(SHA);
    expect(row!.targetProjectId).toBe('7');
    expect(calls[0]!.cmd).toBe("'gh' 'api' 'repos/o/r/pulls/42'");
    expect(calls[0]!.opts).toEqual({ timeout: DRIVER_EXEC_TIMEOUT_MS, maxBuffer: DRIVER_MAX_BUFFER });
  });

  it('fails the op on a row schema violation', async () => {
    const { driver } = driverWith({ 'pulls/42': ok({ ...PR, draft: 0 }) });
    await expect(driver.runOp('prView', { prNumber: 42 })).rejects.toThrow(RowSchemaError);
  });

  it('returns no rows for write ops without parse', async () => {
    const { driver } = driverWith({ '/merge': { stdout: '{"merged":true}', stderr: '', exitCode: 0 } });
    expect(await driver.runOp('merge', { prNumber: 42, expectedHeadSha: SHA })).toEqual([]);
  });

  it('rejects paged ops on the single-command runner', async () => {
    const { driver } = driverWith({});
    await expect(driver.runOp('listPrs')).rejects.toThrow(/paged/);
  });
});

describe('GitDriver: error classification', () => {
  const CLASSIFY_SPEC = JSON.parse(DRIVER) as { errorClasses: unknown };
  CLASSIFY_SPEC.errorClasses = [
    { class: 'RATE_LIMIT', regex: ['HTTP 429', 'rate limit exceeded'] },
    { class: 'ACCESS_DENIED', regex: ['HTTP 401', 'HTTP 403'] },
    { class: 'NOT_FOUND', regex: ['HTTP 404'] },
    { class: 'MERGE_BLOCKED', regex: ['not mergeable'] },
    { class: 'REF_NOT_FOUND', regex: ['Reference does not exist'] },
  ];

  it('classifies by declaration order so rate limits are not misread as credential errors', async () => {
    const { driver } = driverWith(
      { 'pulls/42': { stdout: '', stderr: 'HTTP 403: API rate limit exceeded for installation', exitCode: 1 } },
      JSON.stringify(CLASSIFY_SPEC),
    );
    const err = await driver.runOp('prView', { prNumber: 42 }).catch((e: unknown) => e as DriverOpError);
    expect(err).toBeInstanceOf(DriverOpError);
    expect((err as DriverOpError).info.errorClass).toBe('RATE_LIMIT');

    const { driver: d2 } = driverWith(
      { 'pulls/42': { stdout: '', stderr: 'HTTP 403: Resource not accessible', exitCode: 1 } },
      JSON.stringify(CLASSIFY_SPEC),
    );
    const err2 = await d2.runOp('prView', { prNumber: 42 }).catch((e: unknown) => e as DriverOpError);
    expect((err2 as DriverOpError).info.errorClass).toBe('ACCESS_DENIED');
  });

  it('treats declared treatAsSuccess classes as idempotent success', async () => {
    const { driver } = driverWith({
      'git/refs/heads': { stdout: '', stderr: 'gh: Reference does not exist (HTTP 422)', exitCode: 1 },
    });
    expect(await driver.runOp('deleteBranch', { branch: 'bx/task-1' })).toEqual([]);
  });

  it('unclassified failures carry exit code and stderr tail', async () => {
    const { driver } = driverWith({ 'pulls/42': { stdout: '', stderr: 'boom', exitCode: 7 } });
    const err = await driver.runOp('prView', { prNumber: 42 }).catch((e: unknown) => e as DriverOpError);
    expect((err as DriverOpError).info.exitCode).toBe(7);
    expect((err as DriverOpError).info.errorClass).toBe(undefined);
    expect((err as DriverOpError).message).toMatch(/boom/);
  });
});

describe('GitDriver: paged execution', () => {
  const prAt = (n: number, updatedAt: string) => ({ ...PR, number: n, updated_at: updatedAt });

  it('concatenates pages until the natural empty page', async () => {
    const { driver } = driverWith({
      'repos/o/r/pulls?': (page) => (page === 1 ? ok([prAt(1, '2026-07-17T00:00:03Z'), prAt(2, '2026-07-17T00:00:02Z')])
        : page === 2 ? ok([prAt(3, '2026-07-17T00:00:01Z')]) : ok([])),
    });
    const rows = await driver.runListPrs({});
    expect(rows.map(r => r.prNumber)).toEqual([1, 2, 3]);
  });

  it('stops early when shouldStop reports the watermark window is exhausted', async () => {
    const { driver, calls } = driverWith({
      'repos/o/r/pulls?': (page) => ok([prAt(page, '2026-07-17T00:00:01Z')]),
    });
    const rows = await driver.runListPrs({}, (_rows, page) => page >= 2);
    expect(rows).toHaveLength(2);
    expect(calls).toHaveLength(2);
  });

  it('treats the listPrs page cap as the discovery window, not an error', async () => {
    const { driver, calls } = driverWith({
      'repos/o/r/pulls?': (page) => ok([prAt(page, '2026-07-17T00:00:01Z')]),
    });
    const rows = await driver.runListPrs({});
    expect(rows).toHaveLength(10);
    expect(calls).toHaveLength(10);
  });

  it('fails closed when a backend ignores the page parameter', async () => {
    const { driver } = driverWith({ 'repos/o/r/pulls?': () => ok([prAt(1, '2026-07-17T00:00:01Z')]) });
    await expect(driver.runListPrs({})).rejects.toThrow(/pagination did not advance/);
  });

  it('fails closed instead of silently truncating a comment source at the page cap', async () => {
    const comment = (id: number) => ({ id, body: 'x', created_at: '2026-07-17T00:00:01Z', updated_at: '2026-07-17T00:00:01Z' });
    const { driver } = driverWith({ 'issues/42/comments': (page) => ok([comment(page)]) });
    const source = spec().commentSources[0]!;
    await expect(driver.runCommentSource(source, { prNumber: 42 })).rejects.toThrow(/exceeded page cap 100/);
  });

  it('stamps the source key into row-schema failures', async () => {
    const { driver } = driverWith({ 'issues/42/comments': ok([{ id: 'a:b', body: 'x', created_at: '2026-07-17T00:00:01Z', updated_at: '2026-07-17T00:00:01Z' }]) });
    const source = spec().commentSources[0]!;
    await expect(driver.runCommentSource(source, { prNumber: 42 })).rejects.toThrow(/listComments\[default\]/);
  });
});

describe('buildDriverRunContext', () => {
  it('folds every github form into the github.com namespace', () => {
    for (const url of ['git@github.com:Owner/Repo.git', 'https://github.com/Owner/Repo', 'Owner/Repo']) {
      const ctx = buildDriverRunContext(url, 'gh');
      expect(ctx.hostname).toBe('github.com');
      expect(ctx.host).toBe('github.com');
      expect(ctx.scheme).toBe('https');
      expect(ctx.repoPath).toBe('Owner/Repo');
    }
  });

  it('keeps explicit ports and path case for non-github http(s) remotes', () => {
    const ctx = buildDriverRunContext('https://git.corp.example.com:8443/Team/App.git', '/opt/bin/forge');
    expect(ctx).toMatchObject({
      scheme: 'https', hostname: 'git.corp.example.com', host: 'git.corp.example.com:8443',
      repoPath: 'Team/App', binary: '/opt/bin/forge',
    });
  });
});

describe('GitDriver: single-resource op cardinality', () => {
  it('fails closed when a lifecycle single-object op yields no row', async () => {
    for (const stdout of ['null', '42', '[]']) {
      const { driver } = driverWith({ 'pulls/42': { stdout, stderr: '', exitCode: 0 } });
      await expect(driver.runOp('prView', { prNumber: 42 })).rejects.toThrow(/exactly one row/);
    }
  });

  it('fails closed when a single-object op yields multiple rows', async () => {
    const { driver } = driverWith({ 'repos/o/r': ok([{ default_branch: 'main' }, { default_branch: 'dev' }]) });
    await expect(driver.runOp('projectView')).rejects.toThrow(/exactly one row/);
  });

  it('does not impose cardinality on write ops or custom ops', async () => {
    const { driver } = driverWith({ '/merge': { stdout: 'null', stderr: '', exitCode: 0 } });
    expect(await driver.runOp('merge', { prNumber: 42, expectedHeadSha: SHA })).toEqual([]);
  });
});

describe('GitDriver: paged runner guards', () => {
  it('rejects non-paged ops reaching the paged runner', async () => {
    const raw = JSON.parse(DRIVER) as { ops: Record<string, { parse?: string; argv: string[] }> };
    raw.ops.listPrs = { ...raw.ops.listPrs, parse: 'json', argv: ['{binary}', 'api', 'repos/{repoPath}/pulls'] };
    const r = parseDriverSpec(JSON.stringify(raw), '/p/x');
    expect('errors' in r && r.errors.map(e => e.message).join('\n')).toMatch(/ops\.listPrs\.parse must be 'json-paged'/);
  });

  it('fails closed on empty stdout instead of treating it as a legal empty page', async () => {
    const { driver } = driverWith({ 'issues/42/comments': { stdout: '', stderr: '', exitCode: 0 } });
    const source = spec().commentSources[0]!;
    await expect(driver.runCommentSource(source, { prNumber: 42 })).rejects.toThrow(/empty stdout/);
  });
});

describe('GitDriver: pagination identity and overlap', () => {
  const prAt = (n: number, updatedAt: string) => ({ ...PR, number: n, updated_at: updatedAt });

  it('tracks listPrs progress by prNumber even when the driver maps an unrelated id field', async () => {
    const raw = JSON.parse(DRIVER) as { ops: Record<string, { map?: Record<string, unknown> }> };
    raw.ops.listPrs.map = { ...raw.ops.listPrs.map, id: 'node_id' };
    const withId = JSON.stringify(raw);
    const { driver } = driverWith({
      'repos/o/r/pulls?': (page) => (page === 1 ? ok([{ ...prAt(1, '2026-07-17T00:00:02Z'), node_id: 'same' }])
        : page === 2 ? ok([{ ...prAt(2, '2026-07-17T00:00:01Z'), node_id: 'same' }]) : ok([])),
    }, withId);
    const rows = await driver.runListPrs({});
    expect(rows.map(r => r.prNumber)).toEqual([1, 2]);
  });

  it('drops identical rows repeated across a page-shift overlap and keeps one copy', async () => {
    const { driver } = driverWith({
      'repos/o/r/pulls?': (page) => (page === 1 ? ok([prAt(1, '2026-07-17T00:00:02Z')])
        : page === 2 ? ok([prAt(1, '2026-07-17T00:00:02Z'), prAt(2, '2026-07-17T00:00:01Z')]) : ok([])),
    });
    const rows = await driver.runListPrs({});
    expect(rows.map(r => r.prNumber)).toEqual([1, 2]);
  });

  it('fails closed when the same identity reappears with conflicting content mid-scan', async () => {
    const { driver } = driverWith({
      'repos/o/r/pulls?': (page) => (page === 1 ? ok([prAt(1, '2026-07-17T00:00:02Z')])
        : page === 2 ? ok([{ ...prAt(1, '2026-07-17T00:00:02Z'), head: { ...PR.head, sha: 'f'.repeat(40) } }, prAt(2, '2026-07-17T00:00:01Z')]) : ok([])),
    });
    await expect(driver.runListPrs({})).rejects.toThrow(/conflicting duplicate row for prNumber=1/);
  });
});

describe('GitDriver: page projection hook', () => {
  it('applies the projection to every page before aggregation', async () => {
    const comment = (id: number) => ({ id, body: `body-${id}`, created_at: '2026-07-17T00:00:01Z', updated_at: '2026-07-17T00:00:01Z' });
    const { driver } = driverWith({
      'issues/42/comments': (page) => (page === 1 ? ok([comment(1)]) : page === 2 ? ok([comment(2)]) : ok([])),
    });
    const source = spec().commentSources[0]!;
    const rows = await driver.runCommentSource(source, { prNumber: 42 }, pageRows => {
      for (const r of pageRows) {
        r.projectedFrom = r.body;
        delete r.body;
      }
      return pageRows;
    });
    expect(rows.map(r => r.projectedFrom)).toEqual(['body-1', 'body-2']);
    expect(rows.every(r => r.body === undefined)).toBe(true);
  });
});

describe('GitDriver: optional op degradation', () => {
  it('degrades a failing optional op to zero rows while the same failure on a required op stays fatal', async () => {
    const raw = JSON.parse(DRIVER) as { ops: Record<string, unknown> };
    raw.ops.listApprovals = {
      argv: ['{binary}', 'api', 'repos/{repoPath}/approvals'], parse: 'json', optional: true,
      map: { id: { sources: ['id'], optional: true } },
    };
    const denied = { stdout: '', stderr: 'HTTP 404: Not Found', exitCode: 1 };
    const { driver } = driverWith({ '/approvals': denied, 'pulls/42': denied }, JSON.stringify(raw));
    expect(await driver.runOp('listApprovals')).toEqual([]);
    await expect(driver.runOp('prView', { prNumber: 42 })).rejects.toThrow(DriverOpError);
  });
});
