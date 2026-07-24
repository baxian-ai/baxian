import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ROOT_RECOVERY_MAX_REASON_BYTES,
  RootRecoveryStore,
} from '../../src/state/root-recovery-store.js';

const RECOVERY_ID = 'root-recovery-00000000-0000-4000-8000-000000000001';
const SECOND_RECOVERY_ID = 'root-recovery-00000000-0000-4000-8000-000000000002';
const ATTEMPT_TOKEN = '0123456789abcdef0123456789abcdef';
const AT = '2026-07-21T01:02:03.000Z';

let tempDir: string;
let store: RootRecoveryStore;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-root-recovery-store-'));
  store = new RootRecoveryStore(tempDir, {
    now: () => new Date(AT),
    idFactory: () => RECOVERY_ID,
    tokenFactory: () => ATTEMPT_TOKEN,
  });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true });
});

function input() {
  return {
    taskId: 'task-1',
    projectId: 'proj',
    trigger: {
      kind: 'runtime-stall' as const,
      observedAt: AT,
      agentId: 'dev-1',
      reason: 'STUCK_BUSY',
    },
    guard: {
      status: 'in_progress' as const,
      phase: 'code' as const,
      signalToken: 'abcdef123456',
      agentId: 'dev-1',
      reviewRound: 1,
    },
  };
}

describe('RootRecoveryStore', () => {
  it('serializes deduplication and persists the decision before completion', async () => {
    const [first, second] = await Promise.all([
      store.createIfIdle(input()),
      store.createIfIdle(input()),
    ]);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    expect(first.record.id).toBe(RECOVERY_ID);
    expect(second.record.id).toBe(RECOVERY_ID);

    const started = await store.markDispatchStarted(RECOVERY_ID);
    expect(started).toMatchObject({ status: 'pending', dispatchedAt: AT });
    const inflight = await store.markDispatched(RECOVERY_ID);
    expect(inflight).toMatchObject({
      status: 'inflight',
      dispatchedAt: AT,
      attemptToken: ATTEMPT_TOKEN,
    });
    const delivered = await store.markDelivered(RECOVERY_ID, ATTEMPT_TOKEN);
    expect(delivered).toMatchObject({ status: 'inflight', deliveredAt: AT });

    const claim = await store.claimDecision(RECOVERY_ID, ATTEMPT_TOKEN, {
      action: 'redispatch-current-phase',
      reason: 'The runtime is idle while the persisted phase is still active.',
    });
    expect(claim.claimed).toBe(true);
    expect((await store.get(RECOVERY_ID))?.decision?.action).toBe('redispatch-current-phase');

    const completed = await store.complete(
      RECOVERY_ID,
      { kind: 'executed', detail: 'replayed', at: AT },
      claim.record!,
    );
    expect(completed.completed).toBe(true);
    expect(await store.listActive()).toEqual([]);
    expect(await store.get(RECOVERY_ID)).toMatchObject({
      status: 'done',
      outcome: { kind: 'executed', detail: 'replayed', at: AT },
    });
  });

  it('shares one cold-start load so a concurrent mutation cannot be overwritten by an older snapshot', async () => {
    const existing = await store.createIfIdle(input());
    await store.complete(
      existing.record.id,
      { kind: 'ignored', detail: 'seeded', at: AT },
      existing.record,
    );

    let releaseFirstRead!: () => void;
    const firstReadGate = new Promise<void>(resolve => { releaseFirstRead = resolve; });
    let signalFirstRead!: () => void;
    const firstReadStarted = new Promise<void>(resolve => { signalFirstRead = resolve; });
    let signalSecondRead!: () => void;
    const secondReadStarted = new Promise<void>(resolve => { signalSecondRead = resolve; });
    let readCount = 0;
    const readTextFile = vi.fn(async (path: string) => {
      readCount++;
      if (readCount === 1) {
        signalFirstRead();
        await firstReadGate;
      } else {
        signalSecondRead();
      }
      return readFile(path, 'utf8');
    });
    const concurrentStore = new RootRecoveryStore(tempDir, {
      now: () => new Date(AT),
      idFactory: () => SECOND_RECOVERY_ID,
      tokenFactory: () => ATTEMPT_TOKEN,
      readTextFile,
    });

    const listing = concurrentStore.list();
    await firstReadStarted;
    const creating = concurrentStore.createIfIdle({ ...input(), taskId: 'task-2' });
    const sawSecondRead = await Promise.race([
      secondReadStarted.then(() => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), 20)),
    ]);
    if (sawSecondRead) await creating;
    releaseFirstRead();

    await expect(listing).resolves.toHaveLength(1);
    await expect(creating).resolves.toMatchObject({ created: true });
    expect(await concurrentStore.list()).toHaveLength(2);
    expect(readTextFile).toHaveBeenCalledOnce();
  });

  it('does not claim a response with a different attempt token', async () => {
    await store.createIfIdle(input());
    await store.markDispatched(RECOVERY_ID);
    const claim = await store.claimDecision(RECOVERY_ID, 'f'.repeat(32), {
      action: 'no-op',
      reason: 'wrong generation',
    });
    expect(claim.claimed).toBe(false);
    expect((await store.get(RECOVERY_ID))?.decision).toBeUndefined();
  });

  it('enforces the shared decision reason byte limit at its exact boundary', async () => {
    await store.createIfIdle(input());
    await store.markDispatched(RECOVERY_ID);

    await expect(store.claimDecision(RECOVERY_ID, ATTEMPT_TOKEN, {
      action: 'no-op',
      reason: 'x'.repeat(ROOT_RECOVERY_MAX_REASON_BYTES + 1),
    })).rejects.toThrow(
      `root recovery decision reason exceeds ${ROOT_RECOVERY_MAX_REASON_BYTES} bytes`,
    );
    await expect(store.claimDecision(RECOVERY_ID, ATTEMPT_TOKEN, {
      action: 'no-op',
      reason: 'x'.repeat(ROOT_RECOVERY_MAX_REASON_BYTES),
    })).resolves.toMatchObject({ claimed: true });
  });

  it('requeues only the exact undelivered dispatch generation', async () => {
    await store.createIfIdle(input());
    await store.markDispatched(RECOVERY_ID);

    await expect(store.requeueUndelivered(RECOVERY_ID, 'f'.repeat(32))).resolves.toMatchObject({
      requeued: false,
      record: { status: 'inflight' },
    });
    const requeued = await store.requeueUndelivered(RECOVERY_ID, ATTEMPT_TOKEN);
    expect(requeued).toMatchObject({ requeued: true, record: { status: 'pending' } });
    expect(requeued.record?.dispatchedAt).toBe(AT);

    await store.markDispatched(RECOVERY_ID);
    await store.markDelivered(RECOVERY_ID, ATTEMPT_TOKEN);
    await expect(store.requeueUndelivered(RECOVERY_ID, ATTEMPT_TOKEN)).resolves.toMatchObject({
      requeued: false,
      record: { status: 'inflight', deliveredAt: AT },
    });
  });

  it('deduplicates the same durable intervention event after completion', async () => {
    const eventInput = {
      ...input(),
      trigger: {
        kind: 'intervention' as const,
        observedAt: AT,
        eventId: 'evt-durable-1',
        phase: 'dispatch-reconcile-attempts-exhausted',
      },
    };
    const first = await store.createIfIdle(eventInput);
    await store.complete(
      first.record.id,
      { kind: 'ignored', detail: 'already healthy', at: AT },
      first.record,
    );
    const duplicate = await store.createIfIdle(eventInput);
    expect(duplicate.created).toBe(false);
    expect(duplicate.record.outcome?.kind).toBe('ignored');
    expect(await store.list()).toHaveLength(1);
  });

  it('accepts a pending task guard before an owner agent has been assigned', async () => {
    const created = await store.createIfIdle({
      ...input(),
      guard: { status: 'pending', agentId: '', reviewRound: 0 },
    });
    expect(created.record.guard.agentId).toBe('');
    expect(created.record.guard.status).toBe('pending');
  });

  it('surfaces corrupt durable records instead of silently skipping them', async () => {
    await writeFile(join(tempDir, `${RECOVERY_ID}.json`), '{"version":1,"status":"pending"}\n');
    await expect(store.list()).rejects.toThrow(/invalid root recovery field/);
  });

  it('uses compare-and-set completion so a stale terminal outcome cannot overwrite the winner', async () => {
    const created = await store.createIfIdle(input());
    const first = await store.complete(
      created.record.id,
      { kind: 'stale', detail: 'task advanced', at: AT },
      created.record,
    );
    const second = await store.complete(
      created.record.id,
      { kind: 'unknown', detail: 'late delivery failure', at: AT },
      created.record,
    );

    expect(first.completed).toBe(true);
    expect(second.completed).toBe(false);
    expect(second.record?.outcome?.kind).toBe('stale');
  });

  it('removes only the expected completed retention generation', async () => {
    const created = await store.createIfIdle(input());
    const completed = await store.complete(
      created.record.id,
      { kind: 'ignored', detail: 'healthy', at: AT },
      created.record,
    );
    expect(await store.listDoneBefore('2026-07-22T00:00:00.000Z')).toHaveLength(1);
    await expect(store.removeDone(created.record.id, 'wrong-generation')).resolves.toBe(false);
    await expect(store.removeDone(created.record.id, completed.record!.updatedAt)).resolves.toBe(true);
    await expect(store.get(created.record.id)).resolves.toBeNull();
  });

  it('cleans its unique temporary file and reports the original rename failure', async () => {
    const renameError = new Error('simulated rename failure');
    const unlinkFile = vi.fn(unlink);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    store = new RootRecoveryStore(tempDir, {
      now: () => new Date(AT),
      idFactory: () => RECOVERY_ID,
      tokenFactory: () => ATTEMPT_TOKEN,
      renameFile: vi.fn(async () => {
        throw renameError;
      }),
      unlinkFile,
    });

    await expect(store.createIfIdle(input())).rejects.toBe(renameError);
    expect(unlinkFile).toHaveBeenCalledOnce();
    expect((await readdir(tempDir)).filter(name => name.endsWith('.tmp'))).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed to persist'), renameError);
    warn.mockRestore();
  });
});
