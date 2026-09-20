import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentManager } from '../../src/agent/manager.js';
import type { BaxianEvent } from '../../src/shared/index.js';
import { useManagerSuiteHarness } from '../helpers/manager-harness.js';
import { makeConfig } from '../helpers/fixtures.js';

const harness = useManagerSuiteHarness();

const SOURCE = 'task-001';
const TOKEN = 'spawntok1234';
const RETRY_MS = 20;

function intent(title = 'fix auth refresh', over: Partial<{ taskId: string; token: string }> = {}) {
  return { agentId: 'dev-1', taskId: SOURCE, projectId: 'proj', token: TOKEN, title, ...over };
}

function eventsOf(type: string, phase?: string): BaxianEvent[] {
  return harness.events.filter(e => e.type === type && (phase === undefined || e.data.phase === phase));
}

async function children(): Promise<Array<{ id: string; title: string; origin?: { taskId: string; title: string } }>> {
  return (await harness.taskStore.listStrict()).filter(t => t.origin !== undefined);
}

async function seedSource(over: Record<string, unknown> = {}) {
  return harness.seedTask({ id: SOURCE, status: 'in_progress', signalToken: TOKEN, agentId: 'dev-1', devAgentId: 'dev-1', ...over });
}

const today = () => new Date().toISOString().slice(0, 10);
const failedEvents = async (reason?: string) => (await harness.eventLog.readDate(today()))
  .filter(e => e.type === 'human.intervention' && e.data.phase === 'task-create-failed'
    && (reason === undefined || e.data.reason === reason));

describe('AgentManager task-create side channel', () => {
  it('creates a pending, unassigned task carrying its origin and announces it', async () => {
    await seedSource();
    await harness.manager.spawnTaskFromSignal(intent());
    const [child] = await children();
    expect(child).toMatchObject({
      projectId: 'proj', title: 'fix auth refresh', description: '', preferredAgentId: '', agentId: '',
      status: 'pending', origin: { taskId: SOURCE, title: 'fix auth refresh' },
    });
    expect(child.id).not.toBe(SOURCE);
    expect(eventsOf('task.created').map(e => e.taskId)).toEqual([child.id]);
  });

  it('replays of the same origin resolve to the one existing child without a second announcement', async () => {
    await seedSource();
    await harness.manager.spawnTaskFromSignal(intent());
    const [child] = await children();
    await harness.manager.editTask(child.id, { title: 'renamed by a human' });
    await harness.manager.spawnTaskFromSignal(intent());
    await harness.manager.cancelTask(child.id);
    await harness.manager.spawnTaskFromSignal(intent('fix auth refresh', { token: 'rotatedtok99' }));
    expect(await children()).toHaveLength(1);
    expect(eventsOf('task.created')).toHaveLength(1);
  });

  it('creates distinct children for distinct titles', async () => {
    await seedSource();
    await harness.manager.spawnTaskFromSignal(intent('one'));
    await harness.manager.spawnTaskFromSignal(intent('two'));
    expect((await children()).map(c => c.title).sort()).toEqual(['one', 'two']);
  });

  it('serialises concurrent replays so both resolve to a single child', async () => {
    await seedSource();
    await Promise.all([harness.manager.spawnTaskFromSignal(intent()), harness.manager.spawnTaskFromSignal(intent())]);
    expect(await children()).toHaveLength(1);
  });

  it('refuses to create on an incomplete dedupe scan and names the offending file', async () => {
    await seedSource();
    await harness.manager.spawnTaskFromSignal(intent());
    await writeFile(join(harness.tempDir, 'state', 'tasks', 'task-bad.json'), '{corrupt');
    await harness.manager.spawnTaskFromSignal(intent());
    expect(eventsOf('task.created')).toHaveLength(1);
    expect(eventsOf('human.intervention', 'task-create-failed')[0].data.error).toContain('task-bad.json');
  });

  it('persists the first failure in the event log with the title a human needs to recreate it', async () => {
    await seedSource();
    vi.spyOn(harness.taskStore, 'nextId').mockRejectedValueOnce(new Error('EIO'));
    await harness.manager.spawnTaskFromSignal(intent('recover me'));
    expect((await failedEvents()).filter(e => e.taskId === SOURCE).map(e => e.data)).toEqual([
      expect.objectContaining({ title: 'recover me', token: TOKEN, error: 'EIO' }),
    ]);
  });
});

// Retry scheduling is observed from the clock boundary: a queued intent shows as one pending interval,
// a drained queue as none. The cancel must be real — a nulled handle without clearInterval keeps the count at 1.
describe('AgentManager task-create retry (interval clock)', () => {
  let manager: AgentManager;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    manager = harness.createManager({ needInputRetryIntervalMs: RETRY_MS });
  });
  afterEach(() => { vi.useRealTimers(); });

  const tick = () => vi.advanceTimersByTimeAsync(RETRY_MS);
  const restoreProject = () =>
    manager.replaceConfig(makeConfig({ project: [{ ...makeConfig().project[0]!, id: 'ghost' }] }));

  it('drops the intent when the source task no longer exists: nothing created, nothing scheduled', async () => {
    await manager.spawnTaskFromSignal(intent('orphan', { taskId: 'task-404' }));
    expect(await children()).toEqual([]);
    expect(eventsOf('human.intervention')).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails finally when the source project is gone: verdict persisted, nothing scheduled', async () => {
    await seedSource({ projectId: 'ghost' });
    await manager.spawnTaskFromSignal(intent());
    expect(await children()).toEqual([]);
    expect((await failedEvents('project-missing')).map(e => e.data.title)).toEqual(['fix auth refresh']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('queues a storage failure, reports it once, retries on the interval, and stops the clock once done', async () => {
    await seedSource();
    const boom = Object.assign(new Error('EIO: i/o error, scandir'), { code: 'EIO' });
    vi.spyOn(harness.taskStore, 'nextId').mockRejectedValueOnce(boom).mockRejectedValueOnce(boom);
    const sourceFile = join(harness.tempDir, 'state', 'tasks', `${SOURCE}.json`);
    const before = await readFile(sourceFile, 'utf-8');

    await manager.spawnTaskFromSignal(intent());
    await manager.spawnTaskFromSignal(intent());
    expect(await children()).toEqual([]);
    expect(await readFile(sourceFile, 'utf-8')).toBe(before);
    expect((await failedEvents()).map(e => e.data)).toEqual([
      expect.objectContaining({ title: 'fix auth refresh', error: expect.stringContaining('EIO') }),
    ]);
    expect(vi.getTimerCount()).toBe(1);

    await tick();
    await vi.waitFor(async () => expect((await children()).map(c => c.id)).toEqual(['task-002']));
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(0));
  });

  it('keeps retrying across need-input generation cleanup, token rotation, and source cancellation', async () => {
    const source = await seedSource({ status: 'review' });
    await harness.seedAgent({ id: 'dev-1', taskId: SOURCE, paneId: '%0', needInput: { epoch: 3, askSeq: 1, answeredSeq: 0 } });
    await harness.acquireAgentLock('dev-1');
    vi.spyOn(harness.taskStore, 'nextId').mockRejectedValueOnce(new Error('EIO'));
    await manager.spawnTaskFromSignal(intent());
    expect(vi.getTimerCount()).toBe(1);

    await manager.releaseAgentForTask('dev-1', SOURCE, 'waiting');
    expect((await harness.agentStore.get('dev-1'))?.needInput).toEqual({ epoch: 4 });
    await harness.taskStore.set({ ...source, signalToken: 'rotatedtok99', updatedAt: new Date().toISOString() });
    await manager.cancelTask(SOURCE);
    expect(vi.getTimerCount()).toBe(1);

    await tick();
    await vi.waitFor(async () => expect(await children()).toHaveLength(1));
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(0));
  });

  it('terminates a queued intent once its project has been removed and never fires again', async () => {
    await seedSource();
    vi.spyOn(harness.taskStore, 'nextId').mockRejectedValueOnce(new Error('EIO'));
    await manager.spawnTaskFromSignal(intent());
    manager.replaceConfig(makeConfig({ project: [] }));

    await tick();
    await vi.waitFor(async () => expect((await failedEvents()).map(e => e.data.reason)).toEqual([undefined, 'project-missing']));
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(0));
    await tick();
    expect(await failedEvents()).toHaveLength(2);
    expect(await children()).toEqual([]);
  });

  it('retries a dedupe scan that failed on a corrupt sibling file once the file is repaired', async () => {
    await seedSource();
    await manager.spawnTaskFromSignal(intent());
    const bad = join(harness.tempDir, 'state', 'tasks', 'task-bad.json');
    await writeFile(bad, '{corrupt');
    await manager.spawnTaskFromSignal(intent());
    expect(vi.getTimerCount()).toBe(1);

    await writeFile(bad, JSON.stringify({
      ...(await harness.taskStore.get(SOURCE)), id: 'task-bad', projectId: 'other', status: 'done',
    }));
    await tick();
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(0));
    expect(await children()).toHaveLength(1);
  });

  it('keeps trying to persist the failure event on later retries until the log accepts it', async () => {
    await seedSource();
    const eio = new Error('EIO');
    vi.spyOn(harness.taskStore, 'nextId').mockRejectedValueOnce(eio).mockRejectedValueOnce(eio).mockRejectedValueOnce(eio);
    vi.spyOn(harness.eventLog, 'append').mockRejectedValueOnce(new Error('log disk full'));

    await manager.spawnTaskFromSignal(intent('notify me'));
    expect(await failedEvents()).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);

    await tick();
    await vi.waitFor(async () => expect((await failedEvents()).map(e => e.data.title)).toEqual(['notify me']));
    await tick();
    await vi.waitFor(async () => expect(await failedEvents()).toHaveLength(1));
    await tick();
    await vi.waitFor(async () => expect((await children()).map(c => c.title)).toEqual(['notify me']));
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(0));
  });

  it('keeps a notify-only entry when the project-missing verdict did not persist, and never creates on it', async () => {
    await seedSource({ projectId: 'ghost' });
    vi.spyOn(harness.eventLog, 'append').mockRejectedValueOnce(new Error('log disk full'));
    await manager.spawnTaskFromSignal(intent());
    expect(await failedEvents('project-missing')).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);

    restoreProject();
    await tick();
    await vi.waitFor(async () => expect((await failedEvents('project-missing')).map(e => e.data.title)).toEqual(['fix auth refresh']));
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(0));
    expect(await children()).toEqual([]);
  });

  it('documents the best-effort log: a failure that recovers on the next attempt leaves no failure record', async () => {
    await seedSource();
    vi.spyOn(harness.taskStore, 'nextId').mockRejectedValueOnce(new Error('EIO'));
    vi.spyOn(harness.eventLog, 'append').mockRejectedValueOnce(new Error('log disk full'));
    await manager.spawnTaskFromSignal(intent());
    await tick();
    await vi.waitFor(async () => expect(await children()).toHaveLength(1));
    expect(await failedEvents()).toEqual([]);
  });

  it('documents the best-effort log: a persisted event whose handler throws is appended again on the next failure', async () => {
    await seedSource();
    const eio = new Error('EIO');
    vi.spyOn(harness.taskStore, 'nextId').mockRejectedValueOnce(eio).mockRejectedValueOnce(eio);
    harness.eventBus.on('human.intervention', async () => { throw new Error('handler down'); });
    await manager.spawnTaskFromSignal(intent());
    await tick();
    await vi.waitFor(async () => expect(await failedEvents()).toHaveLength(2));
    await tick();
    await vi.waitFor(async () => expect(await children()).toHaveLength(1));
  });

  it('a late final-notification callback never dequeues a newer create retry sharing its key', async () => {
    await seedSource({ projectId: 'ghost' });
    vi.spyOn(harness.eventLog, 'append').mockRejectedValueOnce(new Error('log disk full'));
    await manager.spawnTaskFromSignal(intent());
    expect(vi.getTimerCount()).toBe(1);

    let releaseAppend!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>(resolve => { releaseAppend = resolve; });
    const reachedGate = new Promise<void>(resolve => { reached = resolve; });
    const realAppend = harness.eventLog.append.bind(harness.eventLog);
    vi.spyOn(harness.eventLog, 'append').mockImplementationOnce(async (event) => { reached(); await gate; await realAppend(event); });
    await tick();
    await reachedGate;

    restoreProject();
    vi.spyOn(harness.taskStore, 'nextId').mockRejectedValueOnce(new Error('EIO'));
    await manager.spawnTaskFromSignal(intent());
    releaseAppend();
    await vi.waitFor(async () => expect((await failedEvents('project-missing')).length).toBe(1));

    await tick();
    await vi.waitFor(async () => expect((await children()).map(c => c.title)).toEqual(['fix auth refresh']));
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(0));
  });

  it('a first project-missing verdict whose notification fails never overwrites a newer create retry under its key', async () => {
    await seedSource({ projectId: 'ghost' });
    let failAppend!: () => void;
    let reached!: () => void;
    const gate = new Promise<never>((_, reject) => { failAppend = () => reject(new Error('log disk full')); });
    const reachedGate = new Promise<void>(resolve => { reached = resolve; });
    vi.spyOn(harness.eventLog, 'append').mockImplementationOnce(() => { reached(); return gate; });
    const first = manager.spawnTaskFromSignal(intent());
    await reachedGate;

    restoreProject();
    vi.spyOn(harness.taskStore, 'nextId').mockRejectedValueOnce(new Error('EIO'));
    await manager.spawnTaskFromSignal(intent());
    failAppend();
    await first;

    await tick();
    await vi.waitFor(async () => expect((await children()).map(c => c.title)).toEqual(['fix auth refresh']));
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(0));
  });
});
