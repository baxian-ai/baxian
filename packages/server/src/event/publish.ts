import type { EventBroker } from './broker.js';
import type { AgentSnapshotCtx } from '../state/snapshot.js';
import type { TaskStore } from '../state/task-store.js';
import type { EventsTopic, PollerSnapshot, TaskState } from '../shared/index.js';
import { isTaskOpen } from '../shared/index.js';
import {
  buildAgentSnapshotById,
  buildAllAgentSnapshots,
} from '../state/snapshot.js';
import { DebouncedTask } from '../timing/debounced-task.js';

export interface EventPublisherOptions {
  // Coalesce 'agents' full-list rebuilds; per-id topics stay per-mutation.
  agentsDebounceMs?: number;
  pollersDebounceMs?: number;
  projectTasksDebounceMs?: number;
}

const DEFAULT_AGENTS_DEBOUNCE_MS = 50;
const DEFAULT_POLLERS_DEBOUNCE_MS = 100;
const DEFAULT_PROJECT_TASKS_DEBOUNCE_MS = 50;

const PROJECT_TASKS_PREFIX = 'project-tasks:';

// Serializes per-topic publishes so a slow snapshot read can't overtake a fast one.
export class EventPublisher {
  private readonly chains = new Map<EventsTopic, Promise<void>>();
  private readonly broker: EventBroker;
  private readonly ctx: AgentSnapshotCtx;
  private readonly taskStore: Pick<TaskStore, 'get' | 'list'>;
  private readonly agentsBroadcast: DebouncedTask;
  private readonly pollersBroadcast: DebouncedTask;
  private readonly projectTasksBroadcasts = new Map<string, DebouncedTask>();
  private readonly projectTasksDebounceMs: number;
  private readonly taskAgents = new Map<string, Set<string>>();
  private readonly taskProjects = new Map<string, string>();

  private pollersGetter: (() => PollerSnapshot[]) | null = null;

  constructor(
    broker: EventBroker,
    ctx: AgentSnapshotCtx,
    taskStore: Pick<TaskStore, 'get' | 'list'>,
    opts: EventPublisherOptions = {},
  ) {
    this.broker = broker;
    this.ctx = ctx;
    this.taskStore = taskStore;
    this.projectTasksDebounceMs = opts.projectTasksDebounceMs ?? DEFAULT_PROJECT_TASKS_DEBOUNCE_MS;
    this.agentsBroadcast = new DebouncedTask(
      opts.agentsDebounceMs ?? DEFAULT_AGENTS_DEBOUNCE_MS,
      () => this.publishAgentsBroadcast(),
    );
    this.pollersBroadcast = new DebouncedTask(
      opts.pollersDebounceMs ?? DEFAULT_POLLERS_DEBOUNCE_MS,
      () => this.publishPollersBroadcast(),
    );
  }

  publishAgentChange(kind: 'set' | 'delete', agentId: string): void {
    const topic: EventsTopic = `agent:${agentId}`;
    void this.chain(topic, async () => {
      if (!this.broker.hasSubscribers(topic)) return;
      try {
        if (kind === 'delete') {
          this.broker.publish(topic, null);
        } else {
          const snapshot = await buildAgentSnapshotById(this.ctx, agentId);
          this.broker.publish(topic, snapshot);
        }
      } catch (err) {
        console.error(`[event/publish] ${topic} (${kind}) failed:`, err);
      }
    });
    this.scheduleAgentsBroadcast();
  }

  publishTaskChange(kind: 'set' | 'delete', taskId: string): void {
    const topic: EventsTopic = `task:${taskId}`;
    void this.chain(topic, async () => {
      try {
        const task = kind === 'delete' ? null : await this.taskStore.get(taskId);
        if (kind === 'delete') {
          if (this.broker.hasSubscribers(topic)) this.broker.publish(topic, null);
          this.publishTaskDerivedAgentChanges(taskId, null);
          this.scheduleProjectTasksRefreshForVanishedTask(taskId);
        } else {
          if (this.broker.hasSubscribers(topic)) this.broker.publish(topic, task);
          this.publishTaskDerivedAgentChanges(taskId, task);
          if (task?.projectId) {
            this.taskProjects.set(taskId, task.projectId);
            this.scheduleProjectTasksBroadcast(task.projectId);
          } else {
            // 'set' raced a concurrent delete — file is gone by the time we read it.
            this.scheduleProjectTasksRefreshForVanishedTask(taskId);
          }
        }
      } catch (err) {
        console.error(`[event/publish] ${topic} (${kind}) failed:`, err);
      }
    });
  }

  enqueue(topic: EventsTopic, fn: () => Promise<void>): Promise<void> {
    return this.chain(topic, fn);
  }

  publishPollersChange(getSnapshots: () => PollerSnapshot[]): void {
    this.pollersGetter = getSnapshots;
    this.pollersBroadcast.schedule();
  }

  dispose(): void {
    this.agentsBroadcast.cancel();
    this.pollersBroadcast.cancel();
    for (const dt of this.projectTasksBroadcasts.values()) dt.cancel();
    this.projectTasksBroadcasts.clear();
    this.taskProjects.clear();
  }

  private chain(topic: EventsTopic, fn: () => Promise<void>): Promise<void> {
    const prev = this.chains.get(topic) ?? Promise.resolve();
    const next = prev.then(fn).catch((err) => {
      console.error(`[event/publish] chain on ${topic} threw:`, err);
    });
    this.chains.set(topic, next);
    void next.finally(() => {
      if (this.chains.get(topic) === next) this.chains.delete(topic);
    });
    return next;
  }

  private scheduleAgentsBroadcast(): void {
    this.agentsBroadcast.schedule();
  }

  private publishTaskDerivedAgentChanges(taskId: string, task: TaskState | null): void {
    const previous = this.taskAgents.get(taskId) ?? new Set<string>();
    const next = new Set<string>();
    if (task?.agentId) next.add(task.agentId);
    if (task?.qaAgentId) next.add(task.qaAgentId);
    if (task) {
      this.taskAgents.set(taskId, next);
    } else {
      this.taskAgents.delete(taskId);
    }
    const affected = new Set([...previous, ...next]);
    for (const agentId of affected) {
      this.publishAgentChange('set', agentId);
    }
  }

  private publishPollersBroadcast(): void {
    const getter = this.pollersGetter;
    if (!getter) return;
    void this.chain('pollers', async () => {
      if (!this.broker.hasSubscribers('pollers')) return;
      try {
        this.broker.publish('pollers', getter());
      } catch (err) {
        console.error('[event/publish] pollers broadcast failed:', err);
      }
    });
  }

  private publishAgentsBroadcast(): void {
    void this.chain('agents', async () => {
      if (!this.broker.hasSubscribers('agents')) return;
      try {
        const all = await buildAllAgentSnapshots(this.ctx);
        this.broker.publish('agents', all);
      } catch (err) {
        console.error('[event/publish] agents broadcast failed:', err);
      }
    });
  }

  // Vanished task = delete OR set that raced a concurrent delete. Cache hit
  // (set in this session) targets one project; cache miss (cross-restart, or
  // task created before this server came up) is rare and falls back to every
  // subscribed project-tasks topic.
  private scheduleProjectTasksRefreshForVanishedTask(taskId: string): void {
    const cached = this.taskProjects.get(taskId);
    if (cached) {
      this.taskProjects.delete(taskId);
      this.scheduleProjectTasksBroadcast(cached);
      return;
    }
    for (const topic of this.broker.subscribedTopicsByPrefix(PROJECT_TASKS_PREFIX)) {
      this.scheduleProjectTasksBroadcast(topic.slice(PROJECT_TASKS_PREFIX.length));
    }
  }

  private scheduleProjectTasksBroadcast(projectId: string): void {
    // No subscribers → no DebouncedTask, no timer. Late subscribers see the
    // current state via the WS plugin's fetchSnapshot at subscribe time.
    const topic: EventsTopic = `${PROJECT_TASKS_PREFIX}${projectId}`;
    if (!this.broker.hasSubscribers(topic)) return;
    let dt = this.projectTasksBroadcasts.get(projectId);
    if (!dt) {
      dt = new DebouncedTask(
        this.projectTasksDebounceMs,
        () => this.publishProjectTasksBroadcast(projectId),
      );
      this.projectTasksBroadcasts.set(projectId, dt);
    }
    dt.schedule();
  }

  private publishProjectTasksBroadcast(projectId: string): void {
    const topic: EventsTopic = `${PROJECT_TASKS_PREFIX}${projectId}`;
    void this.chain(topic, async () => {
      if (!this.broker.hasSubscribers(topic)) return;
      try {
        const tasks = await this.taskStore.list({ projectId });
        this.broker.publish(topic, tasks.filter((t) => isTaskOpen(t.status)));
      } catch (err) {
        console.error(`[event/publish] ${topic} broadcast failed:`, err);
      }
    });
  }
}
