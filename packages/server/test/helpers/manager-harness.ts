import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, vi } from 'vitest';
import type {
  AgentBindingFacts,
  BaxianConfig,
  BaxianEvent,
  TaskState,
} from '../../src/shared/index.js';
import { AgentManager, type AgentManagerDeps } from '../../src/agent/manager.js';
import { BranchManager } from '../../src/agent/branch.js';
import type { PaneRef, TmuxSessionRef } from '../../src/agent/tmux.js';
import { AgentStore } from '../../src/state/agent-store.js';
import { TaskStore } from '../../src/state/task-store.js';
import { LockManager } from '../../src/state/lock.js';
import { EventBus } from '../../src/event/bus.js';
import { EventLog } from '../../src/event/log.js';
import { initStateDir } from '../../src/state/init.js';
import type { RepoStore } from '../../src/agent/repo-store.js';
import { fakeRunner, type FakeRunnerAgent, type FakeRunnerOptions } from './fake-runner.js';
import { makeConfig, makeTask } from './fixtures.js';

export const TEST_SESSION_REF: TmuxSessionRef = {
  sessionId: '$1',
  serverPid: '4242',
  serverStart: '1700000000',
};

// fake runner 给每个 agent 一个唯一 session id(dev-1 $1、qa-1 $2…),pane ref 必须跟着走,否则身份守卫会真实拒绝
const SEEDED_SESSION_IDS: Record<string, string> = { 'dev-1': '$1', 'qa-1': '$2' };

export function sessionRefOf(agentId: string): TmuxSessionRef {
  return { ...TEST_SESSION_REF, sessionId: SEEDED_SESSION_IDS[agentId] ?? TEST_SESSION_REF.sessionId };
}

export function paneRefOf(paneId: string, claim: string): PaneRef {
  return { session: sessionRefOf(claim), paneId, claim };
}

export interface ManagerHarnessOverrides {
  config?: BaxianConfig;
  deps?: Partial<AgentManagerDeps>;
  agentDefaults?: Partial<AgentBindingFacts>;
  taskDefaults?: Partial<TaskState>;
  lockSeededAgents?: boolean;
  useDefaultPlatformRunner?: boolean;
}

export async function seedTask(
  taskStore: TaskStore,
  overrides: Partial<TaskState> = {},
): Promise<TaskState> {
  const task = makeTask(overrides);
  await taskStore.set(task);
  return task;
}

export async function createManagerHarness(
  tempDir: string,
  overrides: ManagerHarnessOverrides = {},
) {
  await initStateDir(tempDir);

  const deps = overrides.deps ?? {};
  const defaultConfig = makeConfig();
  defaultConfig.project[0]!.agent = defaultConfig.project[0]!.agent.map(team => (
    team.map(agent => ({ ...agent, workdir: join(tempDir, agent.id) }))
  ));
  const config = makeConfig(overrides.config ?? deps.config ?? defaultConfig);
  const agentStore = deps.agentStore ?? new AgentStore(join(tempDir, 'state', 'agents'));
  const taskStore = deps.taskStore ?? new TaskStore(join(tempDir, 'state', 'tasks'));
  const lockManager = deps.lockManager ?? new LockManager(join(tempDir, 'locks'));
  const eventLog = new EventLog(join(tempDir, 'events'));
  const eventBus = deps.eventBus ?? new EventBus(eventLog);
  const runner = fakeRunner();
  const events: BaxianEvent[] = [];
  eventBus.on('*', event => { events.push(event); });

  const managerDeps: AgentManagerDeps = {
    ...deps,
    config,
    agentStore,
    taskStore,
    lockManager,
    eventBus,
    runnerFactory: deps.runnerFactory ?? (() => runner),
    ...(overrides.useDefaultPlatformRunner === false
      ? {}
      : { platformRunner: deps.platformRunner ?? runner }),
    imageStagingRoot: deps.imageStagingRoot ?? join(tempDir, 'state', 'task-images'),
  };
  const createManager = (managerOverrides: Partial<AgentManagerDeps> = {}) =>
    new AgentManager({ ...managerDeps, ...managerOverrides });
  const manager = createManager();

  async function seedAgent(agentOverrides: Partial<AgentBindingFacts> = {}): Promise<void> {
    const agent = {
      id: 'dev-1',
      projectId: 'proj',
      updatedAt: '2026-05-14T05:00:00.000Z',
      ...structuredClone(overrides.agentDefaults ?? {}),
      ...structuredClone(agentOverrides),
    };
    await agentStore.set(agent);
    if (!overrides.lockSeededAgents || !agent.taskId || await lockManager.isLocked(agent.id)) return;
    const token = await lockManager.acquire(agent.id, agent.taskId);
    if (!token) return;
    await agentStore.update(agent.id, latest => (latest && latest.taskId === agent.taskId
      ? { ...latest, lockToken: token, updatedAt: new Date().toISOString() }
      : latest));
  }

  const seedHarnessTask = (taskOverrides: Partial<TaskState> = {}) =>
    seedTask(taskStore, {
      ...structuredClone(overrides.taskDefaults ?? {}),
      ...taskOverrides,
    });
  async function acquireAgentLock(agentId: string, taskId?: string): Promise<string | null> {
    const binding = await agentStore.get(agentId);
    const owner = taskId ?? binding?.taskId ?? 'task-1';
    const existing = await lockManager.claimOf(agentId);
    if (existing?.taskId === owner) return existing.token;
    return lockManager.acquire(agentId, owner);
  }

  return {
    config,
    manager,
    createManager,
    agentStore,
    taskStore,
    lockManager,
    eventBus,
    eventLog,
    runner,
    events,
    seedAgent,
    seedTask: seedHarnessTask,
    acquireAgentLock,
  };
}

export function workdirsOf(config: BaxianConfig): Record<string, string> {
  const agents = config.project.flatMap(project => project.agent.flat());
  return Object.fromEntries(agents.flatMap(agent => (agent.workdir ? [[agent.id, agent.workdir]] : [])));
}

// live runtime:两个 agent 的 tmux 会话都在、pane 处于 idle,workdir 与配置一致,提示投递按守卫协议真实推进
export function createManagerSuiteRunner(options: FakeRunnerOptions & { workdirs?: Record<string, string> } = {}) {
  const { workdirs = {}, agents = {}, ...rest } = options;
  const agentSpec = (id: string, runtime: FakeRunnerAgent['runtime']): FakeRunnerAgent => ({
    runtime,
    ...(workdirs[id] ? { workdir: workdirs[id] } : {}),
    ...agents[id],
  });
  return fakeRunner({
    session: 'present',
    ...rest,
    agents: {
      ...agents,
      'dev-1': agentSpec('dev-1', 'claude-code'),
      'qa-1': agentSpec('qa-1', 'codex'),
    },
  });
}

// git 仓库边界替身(spec E4):manager 对 RepoStore 的契约只是 ensure() → workdir
export function repoStoreStandIn(tempDir: string): NonNullable<AgentManagerDeps['repoStoreFactory']> {
  return (_runner, _repo, _mode, _host, _cache, agentId, workdir) => ({
    ensure: async () => workdir ?? join(tempDir, agentId),
    refresh: async () => undefined,
  }) as unknown as RepoStore;
}

async function createManagerSuiteHarness(tempDir: string) {
  const suiteConfig = makeConfig({ review: { rounds: 2 } });
  const workdirs = workdirsOf(suiteConfig);
  const runner = createManagerSuiteRunner({ workdirs });
  const harness = await createManagerHarness(tempDir, {
    config: suiteConfig,
    deps: {
      runnerFactory: () => runner,
      repoStoreFactory: repoStoreStandIn(tempDir),
      // live runtime 每次派单都真实等待 idle/ack,节拍压到毫秒级,单测不再按生产秒级轮询
      compactIdlePollMs: 1,
      readyStableSpacingMs: 1,
      runtimeLivenessProbeMs: 1,
      bootstrapTimeoutsMs: { trustDialog: 300, waitReplReady: 1_000 },
    },
    lockSeededAgents: true,
    useDefaultPlatformRunner: false,
  });
  const workdirByAgent = new Map(harness.config.project
    .flatMap(project => project.agent.flat())
    .map(agent => [agent.id, agent.workdir] as const));
  vi.spyOn(harness.manager, 'platformVerifyPrBinding').mockResolvedValue({
    ok: true,
    prUrl: 'https://github.com/user/repo/pull/42',
    headSha: 'a'.repeat(40),
    branch: 'bx/task-review',
    targetBranch: 'main',
  });
  vi.spyOn(BranchManager.prototype, 'assertClean').mockResolvedValue(undefined);
  vi.spyOn(BranchManager.prototype, 'switchToTaskBranch').mockResolvedValue(undefined);
  vi.spyOn(BranchManager.prototype, 'switchToRemoteBranchDetached').mockResolvedValue(undefined);
  vi.spyOn(BranchManager.prototype, 'switchToDefaultDetached').mockResolvedValue(undefined);
  vi.spyOn(BranchManager.prototype, 'parkOnDefaultDetached').mockResolvedValue(undefined);
  vi.spyOn(BranchManager.prototype, 'cleanupTaskBranch').mockResolvedValue({ status: 'deleted' });
  vi.spyOn(BranchManager.prototype, 'currentRef').mockImplementation(async workdir => {
    const binding = (await harness.agentStore.list()).find(state => state.workdir === workdir && state.taskId);
    const boundTask = binding?.taskId ? await harness.taskStore.get(binding.taskId) : null;
    return boundTask?.branch ? `refs/heads/${boundTask.branch}` : null;
  });
  return {
    ...harness,
    runner,
    seedAgent: (agent: Partial<AgentBindingFacts> = {}) => harness.seedAgent({
      workdir: workdirByAgent.get(agent.id ?? 'dev-1'),
      ...agent,
    }),
  };
}

export type ManagerSuiteHarness = Awaited<ReturnType<typeof createManagerSuiteHarness>>;

export function useManagerSuiteHarness(): ManagerSuiteHarness & { tempDir: string } {
  const harness = {} as ManagerSuiteHarness & { tempDir: string };
  beforeEach(async () => {
    harness.tempDir = await mkdtemp(join(tmpdir(), 'baxian-manager-'));
    Object.assign(harness, await createManagerSuiteHarness(harness.tempDir));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(harness.tempDir, { recursive: true, force: true });
  });
  return harness;
}
