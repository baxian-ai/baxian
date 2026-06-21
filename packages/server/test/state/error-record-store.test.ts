import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ErrorRecordStore, type ErrorRecord } from '../../src/state/error-record-store.js';
import { initStateDir } from '../../src/state/init.js';

let tempDir: string;
let store: ErrorRecordStore;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-errors-'));
  await initStateDir(tempDir);
  store = new ErrorRecordStore(join(tempDir, 'state', 'errors'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true });
});

type AppendInput = Parameters<ErrorRecordStore['append']>[0];

function appendRecord(overrides: Partial<AppendInput> = {}): Promise<ErrorRecord> {
  return store.append({
    agentId: 'dev-1',
    projectId: 'proj',
    operation: 'probe',
    reason: 'TMUX_UNREACHABLE',
    message: 'ssh timeout',
    occurredAt: '2026-05-14T05:00:00.000Z',
    ...overrides,
  });
}

const errorsDir = (): string => join(tempDir, 'state', 'errors');
const jsonlPath = (day: string): string => join(errorsDir(), `${day}.jsonl`);

describe('ErrorRecordStore', () => {
  it('appends structured records and returns a summary reference', async () => {
    const record = await appendRecord({
      taskId: 'task-1',
      operation: 'status-probe',
      recommendation: 'Check SSH connectivity.',
      observation: { tmuxSessionStatus: 'unreachable' },
    });

    expect(record).toMatchObject({
      agentId: 'dev-1',
      projectId: 'proj',
      taskId: 'task-1',
      operation: 'status-probe',
      reason: 'TMUX_UNREACHABLE',
      message: 'ssh timeout',
      recommendation: 'Check SSH connectivity.',
    });
    expect(record.id).toMatch(/^err_/);

    const latest = await store.latestForAgent('dev-1');
    expect(latest).toEqual(record);
    expect(store.toSummary(record)).toEqual({
      id: record.id,
      reason: 'TMUX_UNREACHABLE',
      message: 'ssh timeout',
      occurredAt: '2026-05-14T05:00:00.000Z',
      recommendation: 'Check SSH connectivity.',
    });
  });

  it('stores records in date-partitioned jsonl files', async () => {
    await appendRecord({ operation: 'startup', reason: 'RUNTIME_NOT_READY', message: 'runtime did not emit signal' });
    expect(await readdir(errorsDir())).toEqual(['2026-05-14.jsonl']);
  });

  it('uses the UTC date prefix from occurredAt as the jsonl bucket key', async () => {
    await appendRecord({ reason: 'BEFORE_MIDNIGHT', message: 'before', occurredAt: '2026-05-14T23:59:59.000Z' });
    await appendRecord({ reason: 'AFTER_MIDNIGHT', message: 'after', occurredAt: '2026-05-15T00:00:00.000Z' });

    expect(await readdir(errorsDir())).toEqual([
      '2026-05-14.jsonl',
      '2026-05-15.jsonl',
    ]);
  });

  it('serializes concurrent appends into valid jsonl records', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) =>
      appendRecord({ agentId: `dev-${i}`, message: `timeout ${i}` })));

    const content = await readFile(jsonlPath('2026-05-14'), 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(20);
    expect(lines.map(line => JSON.parse(line))).toHaveLength(20);
  });

  it('latestBootstrapForAgent ignores non-bootstrap operations', async () => {
    // dispatch error after bootstrap error — latestForAgent would return dispatch (newest),
    // but latestBootstrapForAgent must still return the older bootstrap one because the
    // snapshot card semantically only surfaces bootstrap-stage failures.
    await appendRecord({ operation: 'bootstrap', reason: 'BOOTSTRAP_REPO_ACCESS_DENIED', message: 'gh 404' });
    await appendRecord({ operation: 'dispatch', reason: 'DISPATCH_TIMEOUT', message: 'ack timeout', occurredAt: '2026-05-14T06:00:00.000Z' });

    const bootstrap = await store.latestBootstrapForAgent('dev-1');
    expect(bootstrap?.reason).toBe('BOOTSTRAP_REPO_ACCESS_DENIED');
    const latestAny = await store.latestForAgent('dev-1');
    expect(latestAny?.reason).toBe('DISPATCH_TIMEOUT');
  });

  it('latestBootstrapForAgent returns undefined when agent has no bootstrap record', async () => {
    await appendRecord({ operation: 'tmux-probe' });
    expect(await store.latestBootstrapForAgent('dev-1')).toBeUndefined();
  });

  it('latestBootstrapForAgent picks the newest bootstrap record across days', async () => {
    await appendRecord({ operation: 'bootstrap', reason: 'BOOTSTRAP_REPO_ENSURE_FAILED', message: 'older' });
    await appendRecord({ operation: 'bootstrap', reason: 'BOOTSTRAP_REPO_ACCESS_DENIED', message: 'newer', occurredAt: '2026-05-15T05:00:00.000Z' });
    const latest = await store.latestBootstrapForAgent('dev-1');
    expect(latest?.message).toBe('newer');
  });

  it('latestBootstrapByAgent batches all agents in one readAll', async () => {
    // Different agents + different operations; only the latest bootstrap-typed record per
    // agent should land in the map. This is the path buildAllAgentSnapshots takes.
    await appendRecord({ projectId: 'p', operation: 'bootstrap', reason: 'BOOTSTRAP_REPO_ENSURE_FAILED', message: 'old', occurredAt: '2026-05-14T01:00:00.000Z' });
    await appendRecord({ projectId: 'p', operation: 'bootstrap', reason: 'BOOTSTRAP_REPO_ACCESS_DENIED', message: 'new', occurredAt: '2026-05-15T01:00:00.000Z' });
    await appendRecord({ projectId: 'p', operation: 'dispatch', reason: 'DISPATCH_TIMEOUT', message: 'should be ignored', occurredAt: '2026-05-15T02:00:00.000Z' });
    await appendRecord({ agentId: 'dev-2', projectId: 'p', operation: 'bootstrap', reason: 'BOOTSTRAP_REPO_ENSURE_FAILED', message: 'dev-2 boot', occurredAt: '2026-05-14T01:00:00.000Z' });
    await appendRecord({ agentId: 'dev-3', projectId: 'p', operation: 'tmux-probe', reason: 'TMUX_UNREACHABLE', message: 'no bootstrap', occurredAt: '2026-05-14T01:00:00.000Z' });

    const map = await store.latestBootstrapByAgent();
    expect(map.size).toBe(2);
    expect(map.get('dev-1')?.message).toBe('new');
    expect(map.get('dev-2')?.message).toBe('dev-2 boot');
    expect(map.has('dev-3')).toBe(false);
  });

  it('purgeAgent removes only the target agent records from all jsonl files', async () => {
    await appendRecord({ projectId: 'p', operation: 'bootstrap', reason: 'BOOTSTRAP_REPO_ACCESS_DENIED', message: 'old incarnation', occurredAt: '2026-05-14T01:00:00.000Z' });
    await appendRecord({ agentId: 'dev-2', projectId: 'p', operation: 'bootstrap', reason: 'BOOTSTRAP_REPO_ENSURE_FAILED', message: 'other agent', occurredAt: '2026-05-14T01:00:00.000Z' });
    await appendRecord({ projectId: 'p', operation: 'tmux-probe', reason: 'TMUX_UNREACHABLE', message: 'older dev-1 probe', occurredAt: '2026-05-15T01:00:00.000Z' });

    const result = await store.purgeAgent('dev-1');
    expect(result.removed).toBe(2);
    // dev-1 cleared
    expect(await store.latestForAgent('dev-1')).toBeUndefined();
    // dev-2 untouched
    expect(await store.latestForAgent('dev-2')).toMatchObject({ message: 'other agent' });
  });

  it('purgeAgent is idempotent on agents with no records', async () => {
    const result = await store.purgeAgent('nonexistent');
    expect(result.removed).toBe(0);
  });

  it('purgeBootstrapForAgent keeps other operations from the same agent', async () => {
    // Used by runSingleTarget success path to clear the red card while preserving
    // non-bootstrap (tmux-probe / dispatch) history that's still relevant for diagnosis.
    await appendRecord({ projectId: 'p', operation: 'bootstrap', reason: 'BOOTSTRAP_REPO_ACCESS_DENIED', message: 'old boot fail', occurredAt: '2026-05-14T01:00:00.000Z' });
    await appendRecord({ projectId: 'p', operation: 'tmux-probe', reason: 'TMUX_UNREACHABLE', message: 'ssh timeout', occurredAt: '2026-05-14T02:00:00.000Z' });

    const result = await store.purgeBootstrapForAgent('dev-1');
    expect(result.removed).toBe(1);
    // bootstrap gone, tmux-probe preserved
    expect(await store.latestBootstrapForAgent('dev-1')).toBeUndefined();
    expect((await store.latestForAgent('dev-1'))?.reason).toBe('TMUX_UNREACHABLE');
  });

  it('sweepStaleBootstrapErrors keeps records for active agents, drops everything else (bootstrap-typed only)', async () => {
    // Called on startup + PATCH /config to clean up stale red cards for agents that no longer
    // participate in bootstrap (deleted entirely OR transitioned to explicit workdir mode).
    // Must preserve non-bootstrap records and bootstrap records of still-active agents.
    await appendRecord({ agentId: 'still-active', projectId: 'p', operation: 'bootstrap', reason: 'BOOTSTRAP_REPO_ACCESS_DENIED', message: 'keep', occurredAt: '2026-05-14T01:00:00.000Z' });
    await appendRecord({ agentId: 'deleted', projectId: 'p', operation: 'bootstrap', reason: 'BOOTSTRAP_REPO_ACCESS_DENIED', message: 'drop (deleted)', occurredAt: '2026-05-14T02:00:00.000Z' });
    await appendRecord({ agentId: 'now-manual', projectId: 'p', operation: 'bootstrap', reason: 'BOOTSTRAP_REPO_ACCESS_DENIED', message: 'drop (transitioned to workdir)', occurredAt: '2026-05-14T03:00:00.000Z' });
    await appendRecord({ agentId: 'now-manual', projectId: 'p', operation: 'tmux-probe', reason: 'TMUX_UNREACHABLE', message: 'keep (non-bootstrap)', occurredAt: '2026-05-14T04:00:00.000Z' });

    const result = await store.sweepStaleBootstrapErrors(new Set(['still-active']));
    expect(result.removed).toBe(2);
    // still-active bootstrap kept
    expect((await store.latestBootstrapForAgent('still-active'))?.message).toBe('keep');
    // deleted + now-manual bootstrap dropped
    expect(await store.latestBootstrapForAgent('deleted')).toBeUndefined();
    expect(await store.latestBootstrapForAgent('now-manual')).toBeUndefined();
    // now-manual non-bootstrap record preserved (sweep is narrow: only bootstrap operation)
    expect((await store.latestForAgent('now-manual'))?.reason).toBe('TMUX_UNREACHABLE');
  });

  it('sweepStaleBootstrapErrors short-circuits files with no bootstrap records (hot path)', async () => {
    // Startup sweep is one-shot, but PATCH /config sweeps every config update — must not
    // rewrite files that don't contain any bootstrap records. mtime stability assertion.
    await appendRecord({ agentId: 'a', projectId: 'p', operation: 'tmux-probe', reason: 'TMUX_UNREACHABLE', message: 'no bootstrap in file', occurredAt: '2026-05-14T01:00:00.000Z' });
    const path = jsonlPath('2026-05-14');
    const before = (await stat(path)).mtimeMs;
    await new Promise(r => setTimeout(r, 5));

    const result = await store.sweepStaleBootstrapErrors(new Set([]));
    expect(result.removed).toBe(0);
    expect((await stat(path)).mtimeMs).toBe(before);
  });

  it('purgeBootstrapForAgent skips files with no matching records (avoid unnecessary rewrite)', async () => {
    // Hot-path concern: this method runs on EVERY successful 60s BootstrapPoller tick. In the
    // common case (no stale errors) it must not rewrite files. Verified via mtime stability.
    const path = jsonlPath('2026-05-14');
    await appendRecord({ agentId: 'other', projectId: 'p', operation: 'bootstrap', reason: 'BOOTSTRAP_REPO_ACCESS_DENIED', message: 'other agent fail', occurredAt: '2026-05-14T01:00:00.000Z' });
    const statBefore = await stat(path);
    // Sleep 5ms so mtime can change on filesystems with sub-ms resolution if a rewrite happens.
    await new Promise(r => setTimeout(r, 5));

    const result = await store.purgeBootstrapForAgent('dev-1');
    expect(result.removed).toBe(0);
    const statAfter = await stat(path);
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
  });

  it('purgeAgent returns removed=0 and preserves original file when rewrite fails', async () => {
    // Wire-level review: callers (bootstrap.ts success path) use removed > 0 to decide whether
    // to publish a "stale error cleared" event. If we count records as removed before the
    // atomic rename actually succeeds, a writeFile/rename failure silently produces a false
    // positive and an open dashboard would clear its red card even though disk state is unchanged.
    // Failure injection: chmod the errors/ dir to read-only so writeFile of the .tmp lands in
    // EACCES. ESM-mode vitest can't spyOn fs/promises exports, so use real permission denial.
    await appendRecord({ projectId: 'p', operation: 'bootstrap', reason: 'BOOTSTRAP_REPO_ACCESS_DENIED', message: 'still here', occurredAt: '2026-05-14T01:00:00.000Z' });
    const dir = errorsDir();
    const path = jsonlPath('2026-05-14');
    const before = await readFile(path, 'utf-8');

    await chmod(dir, 0o555); // read+exec only — writeFile of new .tmp will EACCES
    try {
      const result = await store.purgeAgent('dev-1');
      expect(result.removed).toBe(0);
      // Original file untouched.
      expect(await readFile(path, 'utf-8')).toBe(before);
    } finally {
      await chmod(dir, 0o755); // restore so afterEach rm() works
    }
    // No orphan .tmp left behind (we unlink in catch on best-effort basis).
    const files = await readdir(dir);
    expect(files.filter(f => f.endsWith('.tmp'))).toHaveLength(0);
  });

  it('purgeAgent rewrites via tmp+rename, surviving partial state of in-place writes', async () => {
    // After purge: target file should contain only kept lines; no .tmp file lingering.
    await appendRecord({ projectId: 'p', operation: 'bootstrap', reason: 'X', message: 'one', occurredAt: '2026-05-14T01:00:00.000Z' });
    await appendRecord({ agentId: 'dev-2', projectId: 'p', operation: 'bootstrap', reason: 'X', message: 'two', occurredAt: '2026-05-14T02:00:00.000Z' });
    await store.purgeAgent('dev-1');

    const files = await readdir(errorsDir());
    expect(files.filter(f => f.endsWith('.tmp'))).toHaveLength(0);
    const content = await readFile(jsonlPath('2026-05-14'), 'utf-8');
    expect(content).toContain('"two"');
    expect(content).not.toContain('"one"');
  });

  it('skips malformed jsonl lines without dropping the whole file', async () => {
    const path = jsonlPath('2026-05-14');
    await writeFile(path, [
      JSON.stringify({
        id: 'err_1',
        agentId: 'dev-1',
        projectId: 'proj',
        operation: 'probe',
        reason: 'TMUX_UNREACHABLE',
        message: 'first',
        occurredAt: '2026-05-14T05:00:00.000Z',
      }),
      '{bad json',
      JSON.stringify({
        id: 'err_2',
        agentId: 'dev-1',
        projectId: 'proj',
        operation: 'probe',
        reason: 'PANE_PROBE_FAILED',
        message: 'second',
        occurredAt: '2026-05-14T06:00:00.000Z',
      }),
    ].join('\n') + '\n');

    const latest = await store.latestForAgent('dev-1');
    expect(latest?.id).toBe('err_2');
  });
});
