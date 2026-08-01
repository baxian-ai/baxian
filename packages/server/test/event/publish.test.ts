import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentBindingFacts, AgentSnapshot, PollerSnapshot, TaskState } from '../../src/shared/index.js';
import type { AgentSnapshotCtx } from '../../src/state/snapshot.js';
import { EventBroker } from '../../src/event/broker.js';
import { EventPublisher } from '../../src/event/publish.js';
import { makeTask } from '../helpers/fixtures.js';

function makeFakes() {
  const states = new Map<string, AgentBindingFacts>();
  const tasks = new Map<string, TaskState | null>();
  const tmuxSessionStatus = new Map<string, AgentSnapshot['tmuxSessionStatus']>();
  const configured = [{ id: 'dev-1', projectId: 'proj' }, { id: 'qa-1', projectId: 'proj' }];
  const taskStore = {
    get: vi.fn(async (id: string) => tasks.get(id) ?? null),
    list: vi.fn(async (filter?: { projectId?: string }) => {
      const all = Array.from(tasks.values()).filter((t): t is TaskState => t !== null);
      if (filter?.projectId) return all.filter(t => t.projectId === filter.projectId);
      return all;
    }),
  };

  const ctx: AgentSnapshotCtx = {
    agentManager: {
      listAgents: () => configured,
      getAgentConfig: (id) => configured.find((c) => c.id === id),
    },
    agentStore: {
      list: vi.fn(async () => Array.from(states.values())),
      get: vi.fn(async (id: string) => states.get(id) ?? null),
    },
    taskStore,
    tmuxSessionStatusStore: {
      get: (id: string) => ({ tmuxSessionStatus: tmuxSessionStatus.get(id) ?? 'unknown' }),
    },
  };
  return { ctx, taskStore, states, tasks, tmuxSessionStatus };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('EventPublisher', () => {
  it('per-topic chain preserves mutation order even when first read is slower', async () => {
    const { ctx, taskStore, tasks } = makeFakes();
    const broker = new EventBroker();
    const received: Array<TaskState | null> = [];
    broker.subscribe('task:t1', (data) => received.push(data as TaskState | null));

    let resolveFirst: ((task: TaskState | null) => void) | null = null;
    const slowFirst = new Promise<TaskState | null>((res) => { resolveFirst = res; });
    const realGet = taskStore.get;
    let callCount = 0;
    taskStore.get = vi.fn(async (id: string) => {
      callCount += 1;
      return callCount === 1 ? await slowFirst : realGet(id);
    });

    const publisher = new EventPublisher(broker, ctx, taskStore, { agentsDebounceMs: 0 });

    tasks.set('t1', makeTask({ id: 't1', status: 'in_progress' }));
    publisher.publishTaskChange('set', 't1');

    tasks.set('t1', makeTask({ id: 't1', status: 'review' }));
    publisher.publishTaskChange('set', 't1');

    resolveFirst!(makeTask({ id: 't1', status: 'in_progress' }));

    await vi.runAllTimersAsync();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const statuses = received.map((t) => t?.status);
    expect(statuses).toEqual(['in_progress', 'review']);
  });

  it('agents broadcast is debounced — burst of N mutations produces 1 broadcast', async () => {
    const { ctx, taskStore, states } = makeFakes();
    const broker = new EventBroker();
    let agentsCount = 0;
    broker.subscribe('agents', () => { agentsCount += 1; });
    broker.subscribe('agent:dev-1', () => undefined);

    const publisher = new EventPublisher(broker, ctx, taskStore, { agentsDebounceMs: 50 });

    states.set('dev-1', baseAgentState('dev-1', 'task-1'));
    publisher.publishAgentChange('set', 'dev-1');
    states.set('dev-1', baseAgentState('dev-1', 'task-2'));
    publisher.publishAgentChange('set', 'dev-1');
    states.set('dev-1', baseAgentState('dev-1', 'task-3'));
    publisher.publishAgentChange('set', 'dev-1');

    expect(agentsCount).toBe(0);

    await vi.advanceTimersByTimeAsync(50);
    await Promise.resolve();
    expect(agentsCount).toBe(1);
  });

  it('agents publish is skipped when no one is subscribed (avoids O(n) buildAllAgentSnapshots)', async () => {
    const { ctx, taskStore, states } = makeFakes();
    const broker = new EventBroker();
    const publisher = new EventPublisher(broker, ctx, taskStore, { agentsDebounceMs: 0 });

    states.set('dev-1', baseAgentState('dev-1'));
    publisher.publishAgentChange('set', 'dev-1');
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(ctx.agentStore.list).not.toHaveBeenCalled();
  });

  it('agent:<id> publish is skipped when no one is subscribed', async () => {
    const { ctx, taskStore, states } = makeFakes();
    const broker = new EventBroker();
    const publisher = new EventPublisher(broker, ctx, taskStore, { agentsDebounceMs: 0 });

    states.set('dev-1', baseAgentState('dev-1', 'task-1'));
    publisher.publishAgentChange('set', 'dev-1');
    await Promise.resolve();
    await Promise.resolve();

    expect(ctx.agentStore.get).not.toHaveBeenCalled();
  });

  it('task status changes refresh agents broadcasts because agent snapshots derive runtime status from tasks', async () => {
    const { ctx, taskStore, states, tasks, tmuxSessionStatus } = makeFakes();
    const broker = new EventBroker();
    const received: AgentSnapshot[][] = [];
    broker.subscribe('agents', (data) => { received.push(data as AgentSnapshot[]); });
    const publisher = new EventPublisher(broker, ctx, taskStore, { agentsDebounceMs: 0 });

    states.set('dev-1', baseAgentState('dev-1', 'task-1'));
    tmuxSessionStatus.set('dev-1', 'present');
    tasks.set('task-1', makeTask({ id: 'task-1', status: 'in_progress' }));
    publisher.publishTaskChange('set', 'task-1');
    await vi.runAllTimersAsync();
    await Promise.resolve();
    await Promise.resolve();

    tasks.set('task-1', makeTask({ id: 'task-1', status: 'review' }));
    publisher.publishTaskChange('set', 'task-1');
    await vi.runAllTimersAsync();
    await Promise.resolve();
    await Promise.resolve();

    expect(received.map(batch => batch.find(agent => agent.id === 'dev-1')?.runtimeStatus))
      .toEqual(['working', 'waiting']);
  });

  it('project-tasks:<id> publish refreshes the full list scoped to that project on any task mutation', async () => {
    const { ctx, taskStore, tasks } = makeFakes();
    const broker = new EventBroker();
    const received: TaskState[][] = [];
    broker.subscribe('project-tasks:proj', (data) => { received.push(data as TaskState[]); });
    const publisher = new EventPublisher(broker, ctx, taskStore, {
      agentsDebounceMs: 0,
      projectTasksDebounceMs: 0,
    });

    tasks.set('t1', makeTask({ id: 't1', status: 'in_progress' }));
    publisher.publishTaskChange('set', 't1');
    await vi.runAllTimersAsync();
    await Promise.resolve();
    await Promise.resolve();

    tasks.set('t2', makeTask({ id: 't2', status: 'pending' }));
    publisher.publishTaskChange('set', 't2');
    await vi.runAllTimersAsync();
    await Promise.resolve();
    await Promise.resolve();

    const lastFrameIds = received[received.length - 1].map(t => t.id).sort();
    expect(lastFrameIds).toEqual(['t1', 't2']);
  });

  it('project-tasks:<id> frame carries only open tasks — terminal (已处理) tasks are excluded', async () => {
    const { ctx, taskStore, tasks } = makeFakes();
    const broker = new EventBroker();
    const received: TaskState[][] = [];
    broker.subscribe('project-tasks:proj', (data) => { received.push(data as TaskState[]); });
    const publisher = new EventPublisher(broker, ctx, taskStore, {
      agentsDebounceMs: 0,
      projectTasksDebounceMs: 0,
    });

    tasks.set('t1', makeTask({ id: 't1', status: 'in_progress' }));
    tasks.set('t2', makeTask({ id: 't2', status: 'pending' }));
    tasks.set('t3', makeTask({ id: 't3', status: 'merged' }));
    tasks.set('t4', makeTask({ id: 't4', status: 'failed' }));
    publisher.publishTaskChange('set', 't1');
    await vi.runAllTimersAsync();
    await Promise.resolve();
    await Promise.resolve();

    const lastFrameIds = received[received.length - 1].map((t) => t.id).sort();
    expect(lastFrameIds).toEqual(['t1', 't2']);
  });

  it('project-tasks:<id> publish is skipped when no one is subscribed (avoids unnecessary list scans)', async () => {
    const { ctx, taskStore, tasks } = makeFakes();
    const broker = new EventBroker();
    const publisher = new EventPublisher(broker, ctx, taskStore, {
      agentsDebounceMs: 0,
      projectTasksDebounceMs: 0,
    });

    tasks.set('t1', makeTask({ id: 't1', status: 'in_progress' }));
    publisher.publishTaskChange('set', 't1');
    await vi.runAllTimersAsync();
    await Promise.resolve();
    await Promise.resolve();

    expect(taskStore.list).not.toHaveBeenCalled();
  });

  it('publishTaskChange does not register a DebouncedTask when no one is subscribed (avoids per-project timer churn)', async () => {
    const { ctx, taskStore, tasks } = makeFakes();
    const broker = new EventBroker();
    const publisher = new EventPublisher(broker, ctx, taskStore, {
      agentsDebounceMs: 0,
      projectTasksDebounceMs: 0,
    });

    for (let i = 0; i < 20; i += 1) {
      tasks.set(`t${i}`, makeTask({ id: `t${i}`, projectId: `proj-${i}`, status: 'pending' }));
      publisher.publishTaskChange('set', `t${i}`);
    }
    await vi.runAllTimersAsync();
    await Promise.resolve();
    await Promise.resolve();

    const broadcasts = (publisher as unknown as { projectTasksBroadcasts: Map<string, unknown> })
      .projectTasksBroadcasts;
    expect(broadcasts.size).toBe(0);
  });

  it('project-tasks:<id> publish reflects deletions even when the deleted task was never set in this session', async () => {
    const { ctx, taskStore, tasks } = makeFakes();
    const broker = new EventBroker();
    const received: TaskState[][] = [];
    broker.subscribe('project-tasks:proj', (data) => { received.push(data as TaskState[]); });
    tasks.set('t1', makeTask({ id: 't1', status: 'in_progress' }));
    const publisher = new EventPublisher(broker, ctx, taskStore, {
      agentsDebounceMs: 0,
      projectTasksDebounceMs: 0,
    });

    tasks.delete('t1');
    publisher.publishTaskChange('delete', 't1');
    await vi.runAllTimersAsync();
    await Promise.resolve();
    await Promise.resolve();

    expect(received[received.length - 1]).toEqual([]);
  });

  it('set targets only the task\'s own projectId; other subscribed projects stay quiet', async () => {
    const { ctx, taskStore, tasks } = makeFakes();
    const broker = new EventBroker();
    let projARecv = 0;
    let projBRecv = 0;
    broker.subscribe('project-tasks:proj-a', () => { projARecv += 1; });
    broker.subscribe('project-tasks:proj-b', () => { projBRecv += 1; });
    const publisher = new EventPublisher(broker, ctx, taskStore, {
      agentsDebounceMs: 0,
      projectTasksDebounceMs: 0,
    });

    tasks.set('t1', makeTask({ id: 't1', projectId: 'proj-a', status: 'in_progress' }));
    publisher.publishTaskChange('set', 't1');
    await vi.runAllTimersAsync();
    await Promise.resolve();
    await Promise.resolve();

    expect(projARecv).toBe(1);
    expect(projBRecv).toBe(0);
  });

  it('delete after a prior in-session set targets only the cached project, not every subscribed project', async () => {
    const { ctx, taskStore, tasks } = makeFakes();
    const broker = new EventBroker();
    const publisher = new EventPublisher(broker, ctx, taskStore, {
      agentsDebounceMs: 0,
      projectTasksDebounceMs: 0,
    });

    tasks.set('t1', makeTask({ id: 't1', projectId: 'proj-a', status: 'in_progress' }));
    publisher.publishTaskChange('set', 't1');
    await vi.runAllTimersAsync();
    await Promise.resolve();
    await Promise.resolve();

    let projARecv = 0;
    let projBRecv = 0;
    broker.subscribe('project-tasks:proj-a', () => { projARecv += 1; });
    broker.subscribe('project-tasks:proj-b', () => { projBRecv += 1; });

    tasks.delete('t1');
    publisher.publishTaskChange('delete', 't1');
    await vi.runAllTimersAsync();
    await Promise.resolve();
    await Promise.resolve();

    expect(projARecv).toBe(1);
    expect(projBRecv).toBe(0);
  });

  it('delete with no cached projectId falls back to refreshing every subscribed project', async () => {
    const { ctx, taskStore } = makeFakes();
    const broker = new EventBroker();
    let projARecv = 0;
    let projBRecv = 0;
    broker.subscribe('project-tasks:proj-a', () => { projARecv += 1; });
    broker.subscribe('project-tasks:proj-b', () => { projBRecv += 1; });
    const publisher = new EventPublisher(broker, ctx, taskStore, {
      agentsDebounceMs: 0,
      projectTasksDebounceMs: 0,
    });

    publisher.publishTaskChange('delete', 't-orphan');
    await vi.runAllTimersAsync();
    await Promise.resolve();
    await Promise.resolve();

    expect(projARecv).toBe(1);
    expect(projBRecv).toBe(1);
  });

  it('project-tasks broadcast is debounced — a burst of mutations produces 1 broadcast', async () => {
    const { ctx, taskStore, tasks } = makeFakes();
    const broker = new EventBroker();
    let count = 0;
    broker.subscribe('project-tasks:proj', () => { count += 1; });
    const publisher = new EventPublisher(broker, ctx, taskStore, {
      agentsDebounceMs: 0,
      projectTasksDebounceMs: 30,
    });

    tasks.set('t1', makeTask({ id: 't1', status: 'in_progress' }));
    publisher.publishTaskChange('set', 't1');
    tasks.set('t1', makeTask({ id: 't1', status: 'review' }));
    publisher.publishTaskChange('set', 't1');
    tasks.set('t1', makeTask({ id: 't1', status: 'approved' }));
    publisher.publishTaskChange('set', 't1');

    expect(count).toBe(0);
    await vi.advanceTimersByTimeAsync(30);
    await Promise.resolve();
    await Promise.resolve();
    expect(count).toBe(1);
  });
});

describe('EventPublisher — deletes, failures and auxiliary channels', () => {
  async function flush(): Promise<void> {
    await vi.runAllTimersAsync();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  function spyConsoleError(): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(console, 'error').mockImplementation(() => undefined);
  }

  it('agent delete publishes null to agent:<id> subscribers', async () => {
    const { ctx, taskStore } = makeFakes();
    const broker = new EventBroker();
    const received: unknown[] = [];
    broker.subscribe('agent:dev-1', (d) => received.push(d));
    const publisher = new EventPublisher(broker, ctx, taskStore, { agentsDebounceMs: 0 });

    publisher.publishAgentChange('delete', 'dev-1');
    await flush();

    expect(received).toEqual([null]);
  });

  it('agent snapshot build failure is logged and the topic chain stays usable', async () => {
    const { ctx, taskStore, states } = makeFakes();
    const broker = new EventBroker();
    const received: Array<{ id: string }> = [];
    broker.subscribe('agent:dev-1', (d) => received.push(d as { id: string }));
    const publisher = new EventPublisher(broker, ctx, taskStore, { agentsDebounceMs: 0 });

    const errSpy = spyConsoleError();
    try {
      ctx.agentStore.get = vi.fn(async () => { throw new Error('store down'); });
      publisher.publishAgentChange('set', 'dev-1');
      await flush();
      expect(received).toEqual([]);
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('agent:dev-1 (set) failed:'),
        expect.any(Error),
      );

      states.set('dev-1', baseAgentState('dev-1'));
      ctx.agentStore.get = vi.fn(async (id: string) => states.get(id) ?? null);
      publisher.publishAgentChange('set', 'dev-1');
      await flush();
      expect(received.map((s) => s.id)).toEqual(['dev-1']);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('set for a task that vanished before the read publishes null and refreshes every subscribed project', async () => {
    const { ctx, taskStore } = makeFakes();
    const broker = new EventBroker();
    const taskFrames: unknown[] = [];
    let projA = 0;
    let projB = 0;
    broker.subscribe('task:ghost', (d) => taskFrames.push(d));
    broker.subscribe('project-tasks:proj-a', () => { projA += 1; });
    broker.subscribe('project-tasks:proj-b', () => { projB += 1; });
    const publisher = new EventPublisher(broker, ctx, taskStore, {
      agentsDebounceMs: 0,
      projectTasksDebounceMs: 0,
    });

    publisher.publishTaskChange('set', 'ghost');
    await flush();

    expect(taskFrames).toEqual([null]);
    expect(projA).toBe(1);
    expect(projB).toBe(1);
  });

  it('taskStore.get failure is logged and later publishes on the topic still flow', async () => {
    const { ctx, taskStore, tasks } = makeFakes();
    const broker = new EventBroker();
    const received: Array<TaskState | null> = [];
    broker.subscribe('task:t1', (d) => received.push(d as TaskState | null));
    const publisher = new EventPublisher(broker, ctx, taskStore, { agentsDebounceMs: 0 });

    const errSpy = spyConsoleError();
    try {
      taskStore.get.mockRejectedValueOnce(new Error('disk gone'));
      publisher.publishTaskChange('set', 't1');
      await flush();
      expect(received).toEqual([]);
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('task:t1 (set) failed:'),
        expect.any(Error),
      );

      tasks.set('t1', makeTask({ id: 't1', status: 'review' }));
      publisher.publishTaskChange('set', 't1');
      await flush();
      expect(received.map((t) => t?.status)).toEqual(['review']);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('enqueue runs jobs on the same topic strictly in submission order', async () => {
    const { ctx, taskStore } = makeFakes();
    const publisher = new EventPublisher(new EventBroker(), ctx, taskStore, { agentsDebounceMs: 0 });

    const order: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const p1 = publisher.enqueue('task:t1', async () => { await gate; order.push(1); });
    const p2 = publisher.enqueue('task:t1', async () => { order.push(2); });

    release();
    await p1;
    await p2;
    expect(order).toEqual([1, 2]);
  });

  it('a rejecting enqueue job is contained and later jobs on the topic still run', async () => {
    const { ctx, taskStore } = makeFakes();
    const publisher = new EventPublisher(new EventBroker(), ctx, taskStore, { agentsDebounceMs: 0 });

    const errSpy = spyConsoleError();
    try {
      await publisher.enqueue('task:t1', async () => { throw new Error('job boom'); });
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('chain on task:t1 threw:'),
        expect.any(Error),
      );

      const ran = vi.fn();
      await publisher.enqueue('task:t1', async () => { ran(); });
      expect(ran).toHaveBeenCalledTimes(1);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('publishPollersChange broadcasts the latest snapshots to pollers subscribers after the debounce', async () => {
    const { ctx, taskStore } = makeFakes();
    const broker = new EventBroker();
    const frames: unknown[] = [];
    broker.subscribe('pollers', (d) => frames.push(d));
    const publisher = new EventPublisher(broker, ctx, taskStore, { pollersDebounceMs: 10 });

    const snapshots: PollerSnapshot[] = [{
      repo: 'https://github.com/user/repo.git',
      projectId: 'proj',
      intervalMs: 1000,
      isPolling: false,
      consecutiveFailures: 0,
      health: 'healthy',
    }];
    publisher.publishPollersChange(() => snapshots);
    expect(frames).toEqual([]);

    await vi.advanceTimersByTimeAsync(10);
    await Promise.resolve();
    await Promise.resolve();
    expect(frames).toEqual([snapshots]);
  });

  it('pollers broadcast with no subscribers never invokes the snapshot getter', async () => {
    const { ctx, taskStore } = makeFakes();
    const publisher = new EventPublisher(new EventBroker(), ctx, taskStore, { pollersDebounceMs: 0 });

    const getter = vi.fn(() => [] as PollerSnapshot[]);
    publisher.publishPollersChange(getter);
    await flush();

    expect(getter).not.toHaveBeenCalled();
  });

  it('a throwing pollers getter is logged without crashing the publisher', async () => {
    const { ctx, taskStore } = makeFakes();
    const broker = new EventBroker();
    broker.subscribe('pollers', () => undefined);
    const publisher = new EventPublisher(broker, ctx, taskStore, { pollersDebounceMs: 0 });

    const errSpy = spyConsoleError();
    try {
      publisher.publishPollersChange(() => { throw new Error('poller boom'); });
      await flush();
      expect(errSpy).toHaveBeenCalledWith('[event/publish] pollers broadcast failed:', expect.any(Error));
    } finally {
      errSpy.mockRestore();
    }
  });

  it('agents broadcast failure (buildAllAgentSnapshots throws) is logged', async () => {
    const { ctx, taskStore } = makeFakes();
    const broker = new EventBroker();
    broker.subscribe('agents', () => undefined);
    const publisher = new EventPublisher(broker, ctx, taskStore, { agentsDebounceMs: 0 });

    const errSpy = spyConsoleError();
    try {
      ctx.agentStore.list = vi.fn(async () => { throw new Error('list boom'); });
      publisher.publishAgentChange('set', 'dev-1');
      await flush();
      expect(errSpy).toHaveBeenCalledWith('[event/publish] agents broadcast failed:', expect.any(Error));
    } finally {
      errSpy.mockRestore();
    }
  });

  it('project-tasks broadcast failure (taskStore.list throws) is logged', async () => {
    const { ctx, taskStore, tasks } = makeFakes();
    const broker = new EventBroker();
    broker.subscribe('project-tasks:proj', () => undefined);
    const publisher = new EventPublisher(broker, ctx, taskStore, {
      agentsDebounceMs: 0,
      projectTasksDebounceMs: 0,
    });

    const errSpy = spyConsoleError();
    try {
      taskStore.list.mockRejectedValue(new Error('scan boom'));
      tasks.set('t1', makeTask({ id: 't1', status: 'in_progress' }));
      publisher.publishTaskChange('set', 't1');
      await flush();
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('project-tasks:proj broadcast failed:'),
        expect.any(Error),
      );
    } finally {
      errSpy.mockRestore();
    }
  });

  it('dispose cancels every pending debounced broadcast', async () => {
    const { ctx, taskStore, states, tasks } = makeFakes();
    const broker = new EventBroker();
    let agentsN = 0;
    let pollersN = 0;
    let projectN = 0;
    broker.subscribe('agents', () => { agentsN += 1; });
    broker.subscribe('pollers', () => { pollersN += 1; });
    broker.subscribe('project-tasks:proj', () => { projectN += 1; });
    const publisher = new EventPublisher(broker, ctx, taskStore, {
      agentsDebounceMs: 50,
      pollersDebounceMs: 50,
      projectTasksDebounceMs: 50,
    });

    states.set('dev-1', baseAgentState('dev-1'));
    publisher.publishAgentChange('set', 'dev-1');
    publisher.publishPollersChange(() => []);
    tasks.set('t1', makeTask({ id: 't1', status: 'in_progress' }));
    publisher.publishTaskChange('set', 't1');
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    publisher.dispose();
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();
    await Promise.resolve();

    expect(agentsN).toBe(0);
    expect(pollersN).toBe(0);
    expect(projectN).toBe(0);
    const broadcasts = (publisher as unknown as { projectTasksBroadcasts: Map<string, unknown> })
      .projectTasksBroadcasts;
    expect(broadcasts.size).toBe(0);
  });
});

function baseAgentState(id: string, taskId?: string): AgentBindingFacts {
  return {
    id,
    projectId: 'proj',
    ...(taskId ? { taskId } : {}),
    updatedAt: '2026-05-09T00:00:00Z',
  };
}
