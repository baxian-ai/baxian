import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
import type { PaneRef, TmuxManager, TmuxSessionRef } from '../../src/agent/tmux.js';
import { AgentStore } from '../../src/state/agent-store.js';
import { TaskStore } from '../../src/state/task-store.js';
import { LockManager } from '../../src/state/lock.js';
import { EventBus } from '../../src/event/bus.js';
import { EventLog } from '../../src/event/log.js';
import { SkillRegistry } from '../../src/skill/registry.js';
import { initStateDir } from '../../src/state/init.js';
import { fakeRunner } from './fake-runner.js';
import { makeConfig, makeTask } from './fixtures.js';

const SKILL_NAMES = [
  'baxian-greeting',
  'baxian-task-check',
  'baxian-pr-review',
  'baxian-pr-feedback',
  'baxian-pr-recheck',
  'baxian-signals',
];

export const TEST_SESSION_REF: TmuxSessionRef = {
  sessionId: '$1',
  serverPid: '4242',
  serverStart: '1700000000',
};

export function paneRefOf(paneId: string, claim: string): PaneRef {
  return { session: TEST_SESSION_REF, paneId, claim };
}

export type AckResult = { acked: boolean; composerDelivered?: boolean; aborted?: boolean };

export function callInjectAndAwaitAck(
  manager: AgentManager,
  tmux: TmuxManager,
  paneId: string,
  prompt: string,
  agentId: string,
  runtime: 'claude-code' | 'codex',
  guardBeforePaste?: () => Promise<boolean>,
): Promise<AckResult> {
  return (manager as unknown as {
    injectAndAwaitAck: (
      tmux: TmuxManager, pane: PaneRef, prompt: string, agentId: string, runtime: 'claude-code' | 'codex',
      guardBeforePaste?: () => Promise<boolean>,
    ) => Promise<AckResult>;
  }).injectAndAwaitAck(tmux, paneRefOf(paneId, agentId), prompt, agentId, runtime, guardBeforePaste);
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

  const skillsDir = join(tempDir, 'skills');
  for (const skillName of SKILL_NAMES) {
    const skillDir = join(skillsDir, skillName);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), `# ${skillName}\nMock skill for testing.`);
  }

  const deps = overrides.deps ?? {};
  const defaultConfig = makeConfig();
  defaultConfig.project[0]!.agent = defaultConfig.project[0]!.agent.map(group => (
    group.map(agent => ({ ...agent, workdir: join(tempDir, agent.id) }))
  ));
  const config = makeConfig(overrides.config ?? deps.config ?? defaultConfig);
  const agentStore = deps.agentStore ?? new AgentStore(join(tempDir, 'state', 'agents'));
  const taskStore = deps.taskStore ?? new TaskStore(join(tempDir, 'state', 'tasks'));
  const lockManager = deps.lockManager ?? new LockManager(join(tempDir, 'locks'));
  const eventLog = new EventLog(join(tempDir, 'events'));
  const eventBus = deps.eventBus ?? new EventBus(eventLog);
  const skillRegistry = deps.skillRegistry ?? new SkillRegistry(skillsDir);
  if (!deps.skillRegistry) await skillRegistry.scan();
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
    skillRegistry,
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
    await agentStore.update(agent.id, latest => latest?.taskId === agent.taskId
      ? { ...latest, lockToken: token, updatedAt: new Date().toISOString() }
      : latest);
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
    skillRegistry,
    freshSkillRegistry: () => new SkillRegistry(skillsDir),
    runner,
    events,
    seedAgent,
    seedTask: seedHarnessTask,
    acquireAgentLock,
  };
}

export function createManagerSuiteRunner() {
  return fakeRunner({
    session: 'absent',
    agents: {
      'qa-1': { screen: 'permissions: YOLO mode\n\n>' },
    },
  });
}

export async function createManagerSuiteHarness(tempDir: string) {
  const runner = createManagerSuiteRunner();
  const harness = await createManagerHarness(tempDir, {
    config: makeConfig({ review: { rounds: 2 } }),
    deps: { runnerFactory: () => runner },
    lockSeededAgents: true,
    useDefaultPlatformRunner: false,
  });
  const workdirByAgent = new Map(harness.config.project
    .flatMap(project => project.agent.flat())
    .map(agent => [agent.id, agent.workdir] as const));
  vi.spyOn(harness.manager, 'platformVerifyPrBinding').mockResolvedValue({
    ok: true,
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
  function stubEnsureSession(
    target: AgentManager,
    resultOverrides: Record<string, unknown> = {},
  ): void {
    vi.spyOn(target, 'ensureSession').mockImplementation(async agentId => ({
      ok: true,
      createdSession: false,
      freshRuntime: false,
      paneId: '%0',
      workdir: (await harness.agentStore.get(agentId))?.workdir ?? '/tmp/repo',
      ...resultOverrides,
    }));
    vi.spyOn(
      target as unknown as { waitForReplPromptReady: (...args: unknown[]) => Promise<void> },
      'waitForReplPromptReady',
    ).mockResolvedValue(undefined);
    vi.spyOn(
      target as unknown as { clearRuntimeForDispatchBoundary: (...args: unknown[]) => Promise<void> },
      'clearRuntimeForDispatchBoundary',
    ).mockResolvedValue(undefined);
    vi.spyOn(BranchManager.prototype, 'switchToTaskBranch').mockResolvedValue(undefined);
    vi.spyOn(BranchManager.prototype, 'switchToRemoteBranchDetached').mockResolvedValue(undefined);
    vi.spyOn(BranchManager.prototype, 'switchToDefaultDetached').mockResolvedValue(undefined);
    vi.spyOn(BranchManager.prototype, 'parkOnDefaultDetached').mockResolvedValue(undefined);
  }
  function stubInject(
    target: AgentManager,
    implementation: (
      tmux: TmuxManager,
      paneId: string,
      prompt: string,
      agentId: string,
      runtime: 'claude-code' | 'codex',
    ) => Promise<{ acked: boolean; composerDelivered: boolean }>,
  ): void {
    vi.spyOn(
      target as unknown as { injectAndAwaitAck: typeof implementation },
      'injectAndAwaitAck',
    ).mockImplementation(implementation);
  }
  const setCompactTiming = (target: AgentManager, waitMs = 100, pollMs = 10) => {
    Object.assign(target, { compactIdleWaitMs: waitMs, compactIdlePollMs: pollMs });
  };
  const mockInterruptPane = (target: AgentManager, ok: boolean) =>
    vi.spyOn(
      target as unknown as { interruptPaneAndWaitReady: () => Promise<boolean> },
      'interruptPaneAndWaitReady',
    ).mockResolvedValue(ok);
  return {
    ...harness,
    runner,
    seedAgent: (agent: Partial<AgentBindingFacts> = {}) => harness.seedAgent({
      workdir: workdirByAgent.get(agent.id ?? 'dev-1'),
      ...agent,
    }),
    stubEnsureSession,
    stubInject,
    setCompactTiming,
    mockInterruptPane,
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
