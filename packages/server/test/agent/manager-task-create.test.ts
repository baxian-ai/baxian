import { describe, it, expect, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BaxianEvent } from '../../src/shared/index.js';
import { useManagerSuiteHarness } from '../helpers/manager-harness.js';
import { makeConfig } from '../helpers/fixtures.js';

const harness = useManagerSuiteHarness();

const SOURCE = 'task-001';
const TOKEN = 'spawntok1234';

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

  it('drops the intent when the source task no longer exists', async () => {
    await harness.manager.spawnTaskFromSignal(intent('orphan', { taskId: 'task-404' }));
    expect(await children()).toEqual([]);
    expect(harness.manager['spawnRetry'].size).toBe(0);
    expect(eventsOf('human.intervention')).toEqual([]);
  });

  it('fails finally and dequeues when the source project is gone', async () => {
    await seedSource({ projectId: 'ghost' });
    await harness.manager.spawnTaskFromSignal(intent());
    expect(await children()).toEqual([]);
    expect(harness.manager['spawnRetry'].size).toBe(0);
    expect(eventsOf('human.intervention', 'task-create-failed').map(e => e.data)).toEqual([
      expect.objectContaining({ reason: 'project-missing', title: 'fix auth refresh' }),
    ]);
  });

  it('queues a storage failure, reports it once, and converges on the retry pass', async () => {
    await seedSource();
    const boom = Object.assign(new Error('EIO: i/o error, scandir'), { code: 'EIO' });
    const failing = vi.spyOn(harness.taskStore, 'nextId').mockRejectedValueOnce(boom).mockRejectedValueOnce(boom);
    const before = await readFile(join(harness.tempDir, 'state', 'tasks', `${SOURCE}.json`), 'utf-8');
    await harness.manager.spawnTaskFromSignal(intent());
    await harness.manager.spawnTaskFromSignal(intent());
    expect(await children()).toEqual([]);
    expect(await readFile(join(harness.tempDir, 'state', 'tasks', `${SOURCE}.json`), 'utf-8')).toBe(before);
    expect(harness.manager['spawnRetry'].size).toBe(1);
    expect(eventsOf('human.intervention', 'task-create-failed').map(e => e.data)).toEqual([
      expect.objectContaining({ title: 'fix auth refresh', error: expect.stringContaining('EIO') }),
    ]);
    failing.mockRestore();
    await harness.manager['spawnRetryPass']();
    expect((await children()).map(c => c.id)).toEqual(['task-002']);
    expect(harness.manager['spawnRetry'].size).toBe(0);
  });

  it('keeps the queue across need-input generation cleanup, token rotation, and source cancellation', async () => {
    const source = await seedSource({ status: 'pending', agentId: '', devAgentId: '', qaAgentId: undefined, preferredAgentId: '' });
    vi.spyOn(harness.taskStore, 'nextId').mockRejectedValueOnce(new Error('EIO'));
    await harness.manager.spawnTaskFromSignal(intent());
    expect(harness.manager['spawnRetry'].size).toBe(1);
    harness.manager['clearNeedInputRetryFor']('dev-1', SOURCE);
    await harness.taskStore.set({ ...source, signalToken: 'rotatedtok99', updatedAt: new Date().toISOString() });
    await harness.manager.cancelTask(SOURCE);
    expect(harness.manager['spawnRetry'].size).toBe(1);
    await harness.manager['spawnRetryPass']();
    expect(await children()).toHaveLength(1);
    expect(harness.manager['spawnRetry'].size).toBe(0);
  });

  it('terminates a queued intent on the retry pass once its project has been removed', async () => {
    await seedSource();
    vi.spyOn(harness.taskStore, 'nextId').mockRejectedValueOnce(new Error('EIO'));
    await harness.manager.spawnTaskFromSignal(intent());
    harness.manager.replaceConfig(makeConfig({ project: [] }));
    await harness.manager['spawnRetryPass']();
    expect(harness.manager['spawnRetry'].size).toBe(0);
    expect(eventsOf('human.intervention', 'task-create-failed').map(e => e.data.reason)).toEqual([undefined, 'project-missing']);
    await harness.manager['spawnRetryPass']();
    expect(eventsOf('human.intervention', 'task-create-failed')).toHaveLength(2);
  });

  it('refuses to create on an incomplete dedupe scan and names the offending file', async () => {
    await seedSource();
    await harness.manager.spawnTaskFromSignal(intent());
    const bad = join(harness.tempDir, 'state', 'tasks', 'task-bad.json');
    await writeFile(bad, '{corrupt');
    await harness.manager.spawnTaskFromSignal(intent());
    expect(harness.manager['spawnRetry'].size).toBe(1);
    expect(eventsOf('human.intervention', 'task-create-failed')[0].data.error).toContain('task-bad.json');
    await writeFile(bad, JSON.stringify({
      ...(await harness.taskStore.get(SOURCE)), id: 'task-bad', projectId: 'other', status: 'done',
    }));
    await harness.manager['spawnRetryPass']();
    expect(await children()).toHaveLength(1);
    expect(harness.manager['spawnRetry'].size).toBe(0);
  });

  it('serialises concurrent replays so both resolve to a single child', async () => {
    await seedSource();
    await Promise.all([harness.manager.spawnTaskFromSignal(intent()), harness.manager.spawnTaskFromSignal(intent())]);
    expect(await children()).toHaveLength(1);
  });
});

describe('AgentManager task-create durability', () => {
  it('persists the first failure in the event log with the title a human needs to recreate it', async () => {
    await seedSource();
    vi.spyOn(harness.taskStore, 'nextId').mockRejectedValueOnce(new Error('EIO'));
    await harness.manager.spawnTaskFromSignal(intent('recover me'));
    const today = new Date().toISOString().slice(0, 10);
    const logged = (await harness.eventLog.readDate(today))
      .filter(e => e.type === 'human.intervention' && e.data.phase === 'task-create-failed' && e.taskId === SOURCE);
    expect(logged.map(e => e.data)).toEqual([
      expect.objectContaining({ title: 'recover me', token: TOKEN, error: 'EIO' }),
    ]);
  });

  it('retries on the real interval timer, not only when the pass is invoked by hand', async () => {
    await seedSource();
    const manager = harness.createManager({ needInputRetryIntervalMs: 20 });
    vi.spyOn(harness.taskStore, 'nextId').mockRejectedValueOnce(new Error('EIO'));
    await manager.spawnTaskFromSignal(intent('timer child'));
    expect(manager['spawnRetry'].size).toBe(1);
    await vi.waitFor(async () => {
      expect((await children()).map(c => c.title)).toEqual(['timer child']);
    }, { timeout: 2000, interval: 25 });
    await vi.waitFor(() => expect(manager['spawnRetry'].size).toBe(0), { timeout: 2000, interval: 25 });
    expect(manager['spawnRetryTimer']).toBeNull();
  });
});

describe('AgentManager task-create failure notification durability', () => {
  it('keeps trying to persist the failure event on later retries until the log accepts it', async () => {
    await seedSource();
    const today = new Date().toISOString().slice(0, 10);
    const failedEvents = async () => (await harness.eventLog.readDate(today))
      .filter(e => e.type === 'human.intervention' && e.data.phase === 'task-create-failed');
    const eio = new Error('EIO');
    vi.spyOn(harness.taskStore, 'nextId')
      .mockRejectedValueOnce(eio).mockRejectedValueOnce(eio).mockRejectedValueOnce(eio);
    vi.spyOn(harness.eventLog, 'append').mockRejectedValueOnce(new Error('log disk full'));

    await harness.manager.spawnTaskFromSignal(intent('notify me'));
    expect(await failedEvents()).toEqual([]);
    expect(harness.manager['spawnRetry'].size).toBe(1);

    await harness.manager['spawnRetryPass']();
    expect((await failedEvents()).map(e => e.data.title)).toEqual(['notify me']);

    await harness.manager['spawnRetryPass']();
    expect(await failedEvents()).toHaveLength(1);

    await harness.manager['spawnRetryPass']();
    expect((await children()).map(c => c.title)).toEqual(['notify me']);
    expect(harness.manager['spawnRetry'].size).toBe(0);
  });
});

describe('AgentManager task-create final-notification retry', () => {
  const today = () => new Date().toISOString().slice(0, 10);
  const failedEvents = async (reason?: string) => (await harness.eventLog.readDate(today()))
    .filter(e => e.type === 'human.intervention' && e.data.phase === 'task-create-failed'
      && (reason === undefined || e.data.reason === reason));

  it('keeps a notify-only entry when the project-missing verdict did not persist, and never creates on it', async () => {
    await seedSource({ projectId: 'ghost' });
    vi.spyOn(harness.eventLog, 'append').mockRejectedValueOnce(new Error('log disk full'));
    await harness.manager.spawnTaskFromSignal(intent());
    expect(await failedEvents('project-missing')).toEqual([]);
    expect(harness.manager['spawnRetry'].size).toBe(1);

    harness.manager.replaceConfig(makeConfig({ project: [{ ...makeConfig().project[0]!, id: 'ghost' }] }));
    await harness.manager['spawnRetryPass']();
    expect((await failedEvents('project-missing')).map(e => e.data.title)).toEqual(['fix auth refresh']);
    expect(harness.manager['spawnRetry'].size).toBe(0);
    expect(await children()).toEqual([]);
  });

  it('documents the best-effort log: a failure that recovers on the next attempt leaves no failure record', async () => {
    await seedSource();
    vi.spyOn(harness.taskStore, 'nextId').mockRejectedValueOnce(new Error('EIO'));
    vi.spyOn(harness.eventLog, 'append').mockRejectedValueOnce(new Error('log disk full'));
    await harness.manager.spawnTaskFromSignal(intent());
    await harness.manager['spawnRetryPass']();
    expect(await children()).toHaveLength(1);
    expect(await failedEvents()).toEqual([]);
  });

  it('documents the best-effort log: a persisted event whose handler throws is appended again on the next failure', async () => {
    await seedSource();
    const eio = new Error('EIO');
    vi.spyOn(harness.taskStore, 'nextId').mockRejectedValueOnce(eio).mockRejectedValueOnce(eio);
    harness.eventBus.on('human.intervention', async () => { throw new Error('handler down'); });
    await harness.manager.spawnTaskFromSignal(intent());
    await harness.manager['spawnRetryPass']();
    expect(await failedEvents()).toHaveLength(2);
    await harness.manager['spawnRetryPass']();
    expect(await children()).toHaveLength(1);
  });
});

describe('AgentManager task-create retry entry identity', () => {
  it('a late final-notification callback never dequeues a newer create retry sharing its key', async () => {
    await seedSource({ projectId: 'ghost' });
    vi.spyOn(harness.eventLog, 'append').mockRejectedValueOnce(new Error('log disk full'));
    await harness.manager.spawnTaskFromSignal(intent());
    expect(harness.manager['spawnRetry'].get(`${SOURCE}\0fix auth refresh`)?.final).toBe('project-missing');

    let releaseAppend!: () => void;
    const gate = new Promise<void>(resolve => { releaseAppend = resolve; });
    const realAppend = harness.eventLog.append.bind(harness.eventLog);
    vi.spyOn(harness.eventLog, 'append').mockImplementationOnce(async (event) => { await gate; await realAppend(event); });
    const pass = harness.manager['spawnRetryPass']();
    await new Promise(resolve => setImmediate(resolve));

    harness.manager.replaceConfig(makeConfig({ project: [{ ...makeConfig().project[0]!, id: 'ghost' }] }));
    vi.spyOn(harness.taskStore, 'nextId').mockRejectedValueOnce(new Error('EIO'));
    await harness.manager.spawnTaskFromSignal(intent());
    const fresh = harness.manager['spawnRetry'].get(`${SOURCE}\0fix auth refresh`);
    expect(fresh?.final).toBeUndefined();

    releaseAppend();
    await pass;
    expect(harness.manager['spawnRetry'].get(`${SOURCE}\0fix auth refresh`)).toBe(fresh);
    await harness.manager['spawnRetryPass']();
    expect((await children()).map(c => c.title)).toEqual(['fix auth refresh']);
    expect(harness.manager['spawnRetry'].size).toBe(0);
  });
});

describe('AgentManager task-create final entry write guard', () => {
  it('a first project-missing verdict whose notification fails never overwrites a newer create retry under its key', async () => {
    await seedSource({ projectId: 'ghost' });
    let failAppend!: () => void;
    let reached!: () => void;
    const gate = new Promise<never>((_, reject) => { failAppend = () => reject(new Error('log disk full')); });
    const reachedGate = new Promise<void>(resolve => { reached = resolve; });
    vi.spyOn(harness.eventLog, 'append').mockImplementationOnce(() => { reached(); return gate; });
    const first = harness.manager.spawnTaskFromSignal(intent());
    await reachedGate;

    harness.manager.replaceConfig(makeConfig({ project: [{ ...makeConfig().project[0]!, id: 'ghost' }] }));
    vi.spyOn(harness.taskStore, 'nextId').mockRejectedValueOnce(new Error('EIO'));
    await harness.manager.spawnTaskFromSignal(intent());
    const fresh = harness.manager['spawnRetry'].get(`${SOURCE}\0fix auth refresh`);
    expect(fresh?.final).toBeUndefined();

    failAppend();
    await first;
    expect(harness.manager['spawnRetry'].get(`${SOURCE}\0fix auth refresh`)).toBe(fresh);
    await harness.manager['spawnRetryPass']();
    expect((await children()).map(c => c.title)).toEqual(['fix auth refresh']);
    expect(harness.manager['spawnRetry'].size).toBe(0);
  });
});
