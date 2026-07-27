import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentBindingFacts, AgentConfig, BaxianConfig, BaxianEvent, TaskState } from '../../src/shared/index.js';
import { DEFAULT_SERVER_CONFIG } from '../../src/shared/index.js';
import type { AgentManagerDeps } from '../../src/agent/manager.js';
import {
  AgentManager,
  DispatchTerminalError,
  EnsureSessionError,
  canDispatchWithBinding,
  type ContinueSessionOpts,
} from '../../src/agent/manager.js';
import { ApiError } from '../../src/errors.js';
import type { CommandRunner, ExecResult } from '../../src/agent/runner.js';
import { PromptSizeError, RequiredSkillsMissingError } from '../../src/agent/prompt.js';
import { TmuxManager, ReplNotReadyError } from '../../src/agent/tmux.js';
import type { PaneRef, TmuxSessionRef } from '../../src/agent/tmux.js';
import { BranchManager, DirtyWorkdirError, ReviewHeadMismatchError } from '../../src/agent/branch.js';
import { AgentStore } from '../../src/state/agent-store.js';
import { TaskStore } from '../../src/state/task-store.js';
import { LockManager } from '../../src/state/lock.js';
import { EventBus } from '../../src/event/bus.js';
import { VisibleTextExtractor } from '../../src/agent/vt-visible-text.js';
import { EventLog } from '../../src/event/log.js';
import { SkillRegistry } from '../../src/skill/registry.js';
import { initStateDir } from '../../src/state/init.js';
import { DriverOpError } from '../../src/platform/git-driver.js';

const NOW = '2026-05-14T05:00:00.000Z';

const GIT_BINDING = { mode: 'git', repoKey: 'github.com/user/repo', tool: 'gh' };

const CONFIG: BaxianConfig = {
  review: { rounds: 2 },
  server: DEFAULT_SERVER_CONFIG,
  project: [{
    id: 'proj',
    repo: 'user/repo',
    merge: null,
    agent: [[
      { id: 'dev-1', runtime: 'claude-code', role: 'dev', mode: 'local', workdir: '/tmp/repo' },
      { id: 'qa-1', runtime: 'codex', role: 'qa', mode: 'local', workdir: '/tmp/qa-repo' },
    ]],
  }],
};

let tempDir: string;
let agentStore: AgentStore;
let taskStore: TaskStore;
let lockManager: LockManager;
let eventBus: EventBus;
let manager: AgentManager;
const events: BaxianEvent[] = [];

function readyRunner(): CommandRunner {
  return {
    exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
      if (cmd.includes('tmux has-session') || cmd.includes('tmux list-sessions') || cmd.includes('tmux list-panes')) {
        return { stdout: '', stderr: 'session not found', exitCode: 1 };
      }
      if (cmd.includes('display-message') && cmd.includes('pane_current_command') && !cmd.includes('capture-pane')) {
        return { stdout: cmd.includes('%1') ? 'BX_PANE_OKcodex\n' : 'BX_PANE_OKclaude\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('capture-pane')) {
        const frame = cmd.includes('%1')
          ? 'permissions: YOLO mode\n\n>'
          : '⏵⏵ bypass permissions on /tmp/repo\n\n>';
        return {
          stdout: cmd.includes('history_size') ? `BX_PANE_OK|0\n${frame}` : `BX_PANE_OK\n${frame}`,
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    }),
    writeFile: vi.fn(async (): Promise<void> => undefined),
    execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
  };
}

function clearAwareRunner(
  sentKeys: string[],
  paneInfo: (pane: string) => { proc: string; idle: string },
  opts: { failClear?: (pane: string) => boolean; swallowClearEnters?: number; rejectClear?: (pane: string) => boolean } = {},
): CommandRunner {
  const clearTyped = new Set<string>();
  const rejected = new Set<string>();
  const swallowed = new Map<string, number>();
  const paneOf = (cmd: string): string => cmd.match(/%\d+/)?.[0] ?? '';
  return {
    exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
      const runtimeFact = claimedRuntimeFact(cmd, agentId => agentId === 'qa-1' ? '%1' : '%0');
      if (runtimeFact) return runtimeFact;
      if (cmd.includes('send-keys')) {
        sentKeys.push(cmd);
        const pane = paneOf(cmd);
        if (cmd.includes('send-keys -l') && cmd.includes('/clear')) {
          if (opts.failClear?.(pane)) return { stdout: '', stderr: 'tmux send failed', exitCode: 1 };
          clearTyped.add(pane);
        } else if (cmd.includes("'Enter'") && clearTyped.has(pane)) {
          const n = swallowed.get(pane) ?? 0;
          if (n < (opts.swallowClearEnters ?? 0)) swallowed.set(pane, n + 1);
          else { clearTyped.delete(pane); if (opts.rejectClear?.(pane)) rejected.add(pane); }
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      const pane = paneOf(cmd);
      const info = paneInfo(pane);
      if (cmd.includes('display-message') && cmd.includes('pane_current_command') && !cmd.includes('capture-pane')) {
        return { stdout: `BX_PANE_OK${info.proc}\n`, stderr: '', exitCode: 0 };
      }
      const frame = rejected.has(pane)
        ? `■ '/clear' is disabled while a task is in progress.\n${info.idle}`
        : clearTyped.has(pane) ? `${info.idle} /clear` : info.idle;
      if (cmd.includes('capture-pane') && cmd.includes('history_size')) {
        return { stdout: `BX_PANE_OK|0\n${frame}`, stderr: '', exitCode: 0 };
      }
      if (cmd.includes('capture-pane')) {
        return { stdout: `BX_PANE_OK\n${frame}`, stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    }),
    writeFile: vi.fn(async (): Promise<void> => undefined),
    execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
  } as unknown as CommandRunner;
}

const CLAUDE_PANE = { proc: 'claude', idle: '⏵⏵ bypass permissions on /tmp/repo\n\n>' };
const CODEX_PANE = { proc: 'codex', idle: 'permissions: YOLO mode\n\n>' };

function compactRunner(
  execs: string[],
  onExec?: (cmd: string) => void | Promise<void>,
  busyCaptures = 3,
): CommandRunner {
  const BUSY = '⏵⏵ bypass permissions on /tmp/repo\n\n· Compacting… (3s)\n  esc to interrupt\n';
  const IDLE = '⏵⏵ bypass permissions on /tmp/repo\n\n>';
  let busyLeft = 0;
  return {
    exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
      execs.push(cmd);
      if (onExec) await onExec(cmd);
      const runtimeFact = claimedRuntimeFact(cmd, () => '%5');
      if (runtimeFact) return runtimeFact;
      if (cmd.includes('send-keys') && cmd.includes("'Enter'")) busyLeft = busyCaptures;
      if (cmd.includes('display-message') && cmd.includes('pane_current_command') && !cmd.includes('capture-pane')) {
        return { stdout: 'BX_PANE_OKclaude\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('capture-pane')) {
        let frame = IDLE;
        if (busyLeft > 0) { busyLeft--; frame = BUSY; }
        if (cmd.includes('history_size')) return { stdout: `BX_PANE_OK|0\n${frame}`, stderr: '', exitCode: 0 };
        return { stdout: `BX_PANE_OK\n${frame}`, stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    }),
    writeFile: vi.fn(async (): Promise<void> => undefined),
    execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
  } as unknown as CommandRunner;
}

function smallPaneClaudeCompactRunner(execs: string[]): CommandRunner {
  const BUSY = '✽ Grooving… (5m 21s · thinking)\n';
  const IDLE = '✻ Worked for 31s\n\n❯ \n';
  let busyLeft = 0;
  return {
    exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
      execs.push(cmd);
      const runtimeFact = claimedRuntimeFact(cmd, () => '%5');
      if (runtimeFact) return runtimeFact;
      if (cmd.includes('send-keys') && cmd.includes("'Enter'")) busyLeft = 2;
      if (cmd.includes('display-message') && cmd.includes('pane_current_command') && !cmd.includes('capture-pane')) {
        return { stdout: 'BX_PANE_OKclaude\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('capture-pane')) {
        let frame = IDLE;
        if (busyLeft > 0) { busyLeft--; frame = BUSY; }
        if (cmd.includes('history_size')) return { stdout: `BX_PANE_OK|0\n${frame}`, stderr: '', exitCode: 0 };
        return { stdout: `BX_PANE_OK\n${frame}`, stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    }),
    writeFile: vi.fn(async (): Promise<void> => undefined),
    execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
  } as unknown as CommandRunner;
}

function task(overrides: Partial<TaskState> = {}): TaskState {
  const id = overrides.id ?? 'task-1';
  const branch = overrides.branch ?? `bx/${id}`;
  return {
    id,
    projectId: 'proj',
    title: 'T',
    description: 'D',
    preferredAgentId: 'dev-1',
    agentId: 'dev-1',
    devAgentId: 'dev-1',
    qaAgentId: 'qa-1',
    branch,
    branchCreatedByBaxian: overrides.branchCreatedByBaxian ?? branch === `bx/${id}`,
    reviewRound: 0,
    platformBinding: GIT_BINDING,
    status: 'in_progress',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeManager(overrides: Partial<AgentManagerDeps> = {}): AgentManager {
  return new AgentManager({
    config: CONFIG,
    agentStore,
    taskStore,
    lockManager,
    eventBus,
    runnerFactory: () => readyRunner(),
    ...overrides,
  });
}

type InjectAckFn = (
  tmux: TmuxManager,
  paneId: string,
  prompt: string,
  agentId: string,
  runtime: 'claude-code' | 'codex',
) => Promise<{ acked: boolean; composerDelivered: boolean }>;

function stubInject(mgr: AgentManager, impl: InjectAckFn): void {
  vi.spyOn(mgr as unknown as { injectAndAwaitAck: InjectAckFn }, 'injectAndAwaitAck').mockImplementation(impl);
}

function stubEnsureSession(mgr: AgentManager, over: Record<string, unknown> = {}): void {
  vi.spyOn(mgr, 'ensureSession').mockImplementation(async (agentId) => ({
    ok: true,
    createdSession: false,
    freshRuntime: false,
    paneId: '%0',
    workdir: (await agentStore.get(agentId))?.workdir ?? '/tmp/repo',
    ...over,
  }));
  vi.spyOn(
    mgr as unknown as { waitForReplPromptReady: (...args: unknown[]) => Promise<void> },
    'waitForReplPromptReady',
  ).mockResolvedValue(undefined);
  vi.spyOn(
    mgr as unknown as { clearRuntimeForDispatchBoundary: (...args: unknown[]) => Promise<void> },
    'clearRuntimeForDispatchBoundary',
  ).mockResolvedValue(undefined);
  vi.spyOn(BranchManager.prototype, 'switchToTaskBranch').mockResolvedValue(undefined);
  vi.spyOn(BranchManager.prototype, 'switchToRemoteBranchDetached').mockResolvedValue(undefined);
  vi.spyOn(BranchManager.prototype, 'switchToDefaultDetached').mockResolvedValue(undefined);
  vi.spyOn(BranchManager.prototype, 'parkOnDefaultDetached').mockResolvedValue(undefined);
}

function stubImagePathsThrow(mgr: AgentManager, err: Error): void {
  vi.spyOn(
    mgr as unknown as { imagePathsForDispatch: () => Promise<string[]> },
    'imagePathsForDispatch',
  ).mockRejectedValue(err);
}

function mockPlatformReviewBinding(
  target: AgentManager,
  headSha = 'a'.repeat(40),
): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(target, 'platformVerifyPrBinding').mockResolvedValue({
    ok: true,
    headSha,
    branch: 'bx/task-review',
    targetBranch: 'main',
  });
}

const SESSION_REF: TmuxSessionRef = { sessionId: '$1', serverPid: '4242', serverStart: '1700000000' };

function paneRefOf(paneId: string, claim: string): PaneRef {
  return { session: SESSION_REF, paneId, claim };
}

function stubClaimedPaneResolution(paneForAgent: (agentId: string) => string): void {
  vi.spyOn(TmuxManager.prototype, 'getSessionSnapshot')
    .mockImplementation(async (name) => ({ ref: SESSION_REF, claim: name }));
  vi.spyOn(TmuxManager.prototype, 'getSinglePaneByRef')
    .mockImplementation(async (ref, claim) => ({ session: ref, paneId: paneForAgent(claim), claim }));
}

function claimedRuntimeFact(
  cmd: string,
  paneForAgent: (agentId: string) => string,
): ExecResult | null {
  const hasSessionAgent = cmd.match(/=([^':\s]+)/)?.[1];
  if (hasSessionAgent && cmd.includes('tmux has-session')) {
    return { stdout: '', stderr: '', exitCode: 0 };
  }
  const sessionName = cmd.match(/session_name},([^}]+)}/)?.[1];
  if (sessionName && cmd.includes('tmux list-sessions')) {
    return {
      stdout: `${SESSION_REF.serverPid}|${SESSION_REF.serverStart}|${SESSION_REF.sessionId}|${sessionName}\n`,
      stderr: '',
      exitCode: 0,
    };
  }
  const claim = cmd.match(/@baxian-agent-id},([^}]+)}/)?.[1];
  if (claim && cmd.includes('tmux list-panes')) {
    const runtime = claim === 'qa-1' ? 'codex' : 'claude';
    return { stdout: `${paneForAgent(claim)} ${runtime}\n`, stderr: '', exitCode: 0 };
  }
  return null;
}

function recordingRunner(
  execs: string[],
  onExec?: (cmd: string) => void | Promise<void>,
): CommandRunner {
  return {
    exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
      execs.push(cmd);
      if (onExec) await onExec(cmd);
      return { stdout: '', stderr: '', exitCode: 0 };
    }),
    writeFile: vi.fn(async (): Promise<void> => undefined),
    execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
  } as unknown as CommandRunner;
}

function setCompactTiming(mgr: AgentManager, waitMs = 100, pollMs = 10): void {
  Object.assign(mgr, { compactIdleWaitMs: waitMs, compactIdlePollMs: pollMs });
}

function mockInterruptPane(mgr: AgentManager, ok: boolean): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(mgr as unknown as { interruptPaneAndWaitReady: () => Promise<boolean> }, 'interruptPaneAndWaitReady')
    .mockResolvedValue(ok) as ReturnType<typeof vi.spyOn>;
}

function freshRegistry(): SkillRegistry {
  return new SkillRegistry(join(tempDir, 'skills'));
}

function makeInjectManager(runner: CommandRunner, ackMs: number, settleMs: number): AgentManager {
  const mgr = makeManager({
    skillRegistry: freshRegistry(),
    runnerFactory: () => runner,
    dispatchAckTimeoutMs: ackMs,
    dispatchSettleTimeoutMs: settleMs,
  });
  Object.assign(mgr, { runtimeLivenessProbeMs: 1 });
  return mgr;
}

type AckResult = { acked: boolean; composerDelivered?: boolean; aborted?: boolean };

function callInjectAndAwaitAck(
  mgr: AgentManager,
  tmux: TmuxManager,
  paneId: string,
  prompt: string,
  agentId: string,
  runtime: 'claude-code' | 'codex',
  guardBeforePaste?: () => Promise<boolean>,
): Promise<AckResult> {
  return (mgr as unknown as {
    injectAndAwaitAck: (
      tmux: TmuxManager, pane: PaneRef, prompt: string, agentId: string, runtime: 'claude-code' | 'codex',
      guardBeforePaste?: () => Promise<boolean>,
    ) => Promise<AckResult>;
  }).injectAndAwaitAck(tmux, paneRefOf(paneId, agentId), prompt, agentId, runtime, guardBeforePaste);
}

function seedAgent(overrides: Partial<AgentBindingFacts> & { id: string }): Promise<void> {
  return agentStore.set({ projectId: 'proj', updatedAt: NOW, ...overrides });
}

async function seedTask(overrides: Partial<TaskState> = {}): Promise<TaskState> {
  const t = task(overrides);
  await taskStore.set(t);
  return t;
}

async function acquireBoundLock(agentId: string, taskId?: string): Promise<string | null> {
  const binding = await agentStore.get(agentId);
  const owner = taskId ?? binding?.taskId ?? 'task-1';
  const existing = await lockManager.claimOf(agentId);
  if (existing?.taskId === owner) return existing.token;
  return lockManager.acquire(agentId, owner);
}

function capturePaneRunner(
  execs: string[],
  capture: () => string | Promise<string>,
): CommandRunner {
  return {
    exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
      execs.push(cmd);
      const runtimeFact = claimedRuntimeFact(cmd, () => '%5');
      if (runtimeFact) return runtimeFact;
      if (cmd.includes('display-message') && cmd.includes('pane_current_command') && !cmd.includes('capture-pane')) {
        return { stdout: 'BX_PANE_OKclaude\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('capture-pane')) {
        const header = cmd.includes('history_size') ? 'BX_PANE_OK|0' : 'BX_PANE_OK';
        return { stdout: `${header}\n${await capture()}`, stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    }),
    writeFile: vi.fn(async (): Promise<void> => undefined),
    execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
  } as unknown as CommandRunner;
}

function captureInjection(into: string[]): (cmd: string) => void {
  return (cmd: string) => {
    const m = cmd.match(/printf '%s' '([^']+)'/);
    if (m && cmd.includes('load-buffer')) into.push(Buffer.from(m[1], 'base64').toString('utf8'));
  };
}

async function seedPhaseSkillsAtDir(skillsDir: string): Promise<void> {
  for (const name of [
    'baxian-task-check',
    'baxian-pr-feedback',
    'baxian-pr-review',
    'baxian-pr-recheck',
    'baxian-server-feedback',
    'baxian-signals',
  ]) {
    await mkdir(join(skillsDir, name), { recursive: true });
    await writeFile(
      join(skillsDir, name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${name} stub\n---\nstub`,
    );
  }
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-manager-'));
  await initStateDir(tempDir);
  agentStore = new AgentStore(join(tempDir, 'state', 'agents'));
  taskStore = new TaskStore(join(tempDir, 'state', 'tasks'));
  lockManager = new LockManager(join(tempDir, 'locks'));
  const setAgent = agentStore.set.bind(agentStore);
  const updateAgent = agentStore.update.bind(agentStore);
  const mirrorExactLock = async (id: string): Promise<void> => {
    const state = await agentStore.get(id);
    if (!state?.taskId) return;
    let next = state;
    if (state.workdir === undefined) {
      next = {
        ...next,
        workdir: id === 'qa-1' ? '/tmp/qa-repo' : '/tmp/repo',
        updatedAt: new Date().toISOString(),
      };
    }
    const claim = await lockManager.claimOf(id);
    const token = claim?.taskId === next.taskId
      ? claim.token
      : claim
        ? null
        : await lockManager.acquire(id, next.taskId);
    if (token && next.lockToken !== token) {
      next = { ...next, lockToken: token, updatedAt: new Date().toISOString() };
    }
    if (next !== state) await setAgent(next);
  };
  vi.spyOn(agentStore, 'set').mockImplementation(async (state) => {
    await setAgent(state);
    await mirrorExactLock(state.id);
  });
  vi.spyOn(agentStore, 'update').mockImplementation(async (id, update) => {
    const commit = await updateAgent(id, update);
    await mirrorExactLock(id);
    return commit;
  });
  eventBus = new EventBus(new EventLog(join(tempDir, 'events')));
  events.length = 0;
  eventBus.on('*', (event) => { events.push(event); });

  const skillsDir = join(tempDir, 'skills');
  await seedPhaseSkillsAtDir(skillsDir);
  const skillRegistry = new SkillRegistry(skillsDir);
  await skillRegistry.scan();

  manager = makeManager({ skillRegistry });
  mockPlatformReviewBinding(manager);
  vi.spyOn(BranchManager.prototype, 'assertClean').mockResolvedValue(undefined);
  vi.spyOn(BranchManager.prototype, 'switchToTaskBranch').mockResolvedValue(undefined);
  vi.spyOn(BranchManager.prototype, 'switchToRemoteBranchDetached').mockResolvedValue(undefined);
  vi.spyOn(BranchManager.prototype, 'switchToDefaultDetached').mockResolvedValue(undefined);
  vi.spyOn(BranchManager.prototype, 'parkOnDefaultDetached').mockResolvedValue(undefined);
  vi.spyOn(BranchManager.prototype, 'cleanupTaskBranch').mockResolvedValue({ status: 'deleted' });
  vi.spyOn(BranchManager.prototype, 'currentRef').mockImplementation(async (workdir) => {
    const binding = (await agentStore.list()).find(state => state.workdir === workdir && state.taskId);
    const boundTask = binding?.taskId ? await taskStore.get(binding.taskId) : null;
    return boundTask?.branch ? `refs/heads/${boundTask.branch}` : null;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tempDir, { recursive: true, force: true });
});

describe('AgentManager task binding flow', () => {
  it('createTask binds a free preferred dev and holds its lock', async () => {
    await seedAgent({ id: 'dev-1' });

    const created = await manager.createTask('proj', {
      title: 'build it',
      description: 'details',
      preferredAgentId: 'dev-1',
    });

    expect(created.status).toBe('in_progress');
    expect(created.agentId).toBe('dev-1');
    expect(created.devAgentId).toBe('dev-1');
    expect(created.qaAgentId).toBe('qa-1');
    expect(created.phase).toBeUndefined();
    expect((await agentStore.get('dev-1'))?.taskId).toBe(created.id);
    expect(await lockManager.isLocked('dev-1')).toBe(true);
    expect(events.some(e => e.type === 'task.assigned' && e.agentId === 'dev-1')).toBe(true);
  });

  it('createTask rejects the binding when a DELETE→recreate bumps the generation during config reads', async () => {
    await seedAgent({ id: 'dev-1' });
    // Simulate a concurrent DELETE→same-id recreate landing in the window between the entry
    // generation capture and the commit: bump the generation while the agent config is read.
    // The capture must precede pickAgent/config reads so this change closes the gate.
    const realPick = manager.pickAgent.bind(manager);
    vi.spyOn(manager, 'pickAgent').mockImplementation(async (projectId, agentId) => {
      const picked = await realPick(projectId, agentId);
      manager.bumpDeletionGeneration(agentId);
      return picked;
    });

    const result = await manager.createTask('proj', {
      title: 'racy', description: 'd', preferredAgentId: 'dev-1',
    });

    expect(result.status).toBe('pending');
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(false);
  });

  it('createTask rejects the queued early-return when a DELETE→recreate bumps the generation (no stale participants persisted)', async () => {
    await seedAgent({ id: 'dev-1' });
    // Agent appears busy (pickAgent → null), but the group snapshot is already stale because a
    // DELETE→same-id recreate bumped the generation; the queued early-return must reject, not persist
    // a pending task carrying the old incarnation's devAgentId/qaAgentId.
    vi.spyOn(manager, 'pickAgent').mockImplementation(async (_projectId, agentId) => {
      manager.bumpDeletionGeneration(agentId);
      return null;
    });

    await expect(manager.createTask('proj', {
      title: 'racy queued', description: 'd', preferredAgentId: 'dev-1',
    })).rejects.toThrow(/deleted or recreated/);
  });

  it('createTask queued early-return rejects when a group member (QA) is being deleted, even with the dev generation unchanged', async () => {
    await seedAgent({ id: 'dev-1' });
    // Standalone QA delete: dev's generation is unchanged, but the QA participant is tombstoned.
    manager.tryClaimDeletion(['qa-1']);
    vi.spyOn(manager, 'pickAgent').mockResolvedValue(null); // agent appears busy → preferred_agent_busy branch

    await expect(manager.createTask('proj', {
      title: 'qa-deleting', description: 'd', preferredAgentId: 'dev-1',
    })).rejects.toThrow(/being deleted or recreated/);
  });

  it('createTask does not create an active task when the lock is rotated away after the binding commit (binding-before-active)', async () => {
    await seedAgent({ id: 'dev-1' });
    // Simulate a DELETE rotating the lock in the window between the binding commit and the in_progress write.
    vi.spyOn(lockManager, 'isOwner').mockResolvedValue(false);

    const result = await manager.createTask('proj', { title: 't', description: 'd', preferredAgentId: 'dev-1' });

    expect(result.status).toBe('pending'); // NOT in_progress → no orphan active task
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined(); // binding rolled back
    expect(await lockManager.isLocked('dev-1')).toBe(false); // lock released
  });

  it('createTask does not create an active task when a group participant (QA) is deleted+recreated after the snapshot', async () => {
    await seedAgent({ id: 'dev-1' });
    // dev's generation is unchanged and no tombstone remains, but a QA member was reintroduced after the
    // group snapshot — its captured generation no longer matches, so the active task must not bake it in.
    const realAcquire = lockManager.acquire.bind(lockManager);
    vi.spyOn(lockManager, 'acquire').mockImplementation(async (id: string, taskId: string) => {
      const token = await realAcquire(id, taskId);
      manager.bumpDeletionGeneration('qa-1');
      return token;
    });

    const result = await manager.createTask('proj', { title: 't', description: 'd', preferredAgentId: 'dev-1' });

    expect(result.status).toBe('pending');
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(false);
  });

  it('scanOpenThenClaimDeletion serializes with createTask: a racing delete-claim cannot orphan the in_progress write', async () => {
    await seedAgent({ id: 'dev-1' });
    // createTask is invoked first so it wins the task lock; the delete-claim queues behind it and its active
    // scan runs only AFTER the in_progress commit — the owner-check→commit window is never interleaved.
    const create = manager.createTask('proj', { title: 't', description: 'd', preferredAgentId: 'dev-1' });
    const claim = manager.scanOpenThenClaimDeletion(['dev-1']);
    const [created, claimResult] = await Promise.all([create, claim]);

    expect(created.status).toBe('in_progress');
    expect(claimResult).toEqual({ ok: false, code: 'active', agentId: 'dev-1', taskId: created.id });
    expect(manager.isDeletionInFlight('dev-1')).toBe(false); // claim refused before tryClaimDeletion → no tombstone
  });

  it('a delete-claim that wins the task lock forces a racing createTask to reject (no active task on a claimed agent)', async () => {
    await seedAgent({ id: 'dev-1' });
    // Reverse order: the delete-claim wins the lock and tombstones dev-1; createTask (queued behind it) then
    // sees the tombstone at its gate/participant check and rejects instead of committing an active task.
    const claim = manager.scanOpenThenClaimDeletion(['dev-1']);
    const create = manager.createTask('proj', { title: 't', description: 'd', preferredAgentId: 'dev-1' });

    await expect(create).rejects.toThrow(/being deleted or recreated/);
    expect(await claim).toEqual({ ok: true });
    expect(manager.isDeletionInFlight('dev-1')).toBe(true);
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
  });

  it('ensureSession refuses and skips the Workdir state-write when a DELETE→recreate bumps the generation mid-flight', async () => {
    await seedAgent({ id: 'dev-1' });
    // ensureWorkdir resolves, but a concurrent DELETE→same-id recreate bumps the generation during it.
    // The gate re-check under the lifecycle lock must throw BEFORE the stale Workdir is persisted.
    vi.spyOn(manager as unknown as { ensureWorkdir: (...a: unknown[]) => Promise<{ workdir: string }> }, 'ensureWorkdir')
      .mockImplementation(async () => {
        manager.bumpDeletionGeneration('dev-1');
        return { workdir: '/tmp/stale-workdir' };
      });

    await expect(manager.ensureSession('dev-1', 'runtime')).rejects.toThrow(/being deleted|recreated/);
    expect((await agentStore.get('dev-1'))?.workdir).not.toBe('/tmp/stale-workdir');
  });

  it('ensureSession re-gates after the tmux probe: a DELETE tombstone during getSessionSnapshot blocks build/adopt', async () => {
    await seedAgent({ id: 'dev-1', workdir: '/repo/wt' });
    vi.spyOn(manager as unknown as { ensureWorkdir: (...a: unknown[]) => Promise<{ workdir: string }> }, 'ensureWorkdir')
      .mockResolvedValue({ workdir: '/repo/wt' });
    vi.spyOn(manager as unknown as { provisionRepoSkills: (...a: unknown[]) => Promise<void> }, 'provisionRepoSkills')
      .mockResolvedValue(undefined);
    const buildSpy = vi.spyOn(
      manager as unknown as { buildFreshSession: (...a: unknown[]) => Promise<unknown> }, 'buildFreshSession',
    ).mockResolvedValue({ createdSession: true, agentId: 'dev-1' });
    // Gate is open at entry; a DELETE claims the tombstone while the snapshot probe is in flight. The post-probe
    // re-gate must throw before buildFreshSession (or adopt) creates a session for the agent being deleted.
    vi.spyOn(TmuxManager.prototype, 'getSessionSnapshot').mockImplementation(async () => {
      manager.tryClaimDeletion(['dev-1']);
      return null;
    });

    await expect(manager.ensureSession('dev-1', 'runtime')).rejects.toThrow(/being deleted|recreated/);
    expect(buildSpy).not.toHaveBeenCalled();
  });

  it('reconcileTaskBranches skips branch cleanup when a DELETE→recreate bumps the generation during the ref scan', async () => {
    await seedTask({ id: 'rtb-1', status: 'merged', branch: 'bx/rtb-1', branchCreatedByBaxian: true, agentId: 'dev-1' });
    await seedAgent({ id: 'dev-1', workdir: '/repo/wt' });

    const cmds: string[] = [];
    vi.spyOn(manager as unknown as { createRunnerFor: (a: unknown) => CommandRunner }, 'createRunnerFor')
      .mockReturnValue({
        exec: vi.fn(async (cmd: string) => {
          cmds.push(cmd);
          if (cmd.includes('for-each-ref')) {
            // A DELETE→same-id recreate lands mid-scan; the gate captured before this read must close.
            manager.bumpDeletionGeneration('dev-1');
            return { stdout: 'refs/heads/bx/rtb-1\n', stderr: '', exitCode: 0 };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        }),
        writeFile: vi.fn(async () => {}),
      } as unknown as CommandRunner);

    await manager.reconcileTaskBranches();

    // Gate closed after the bump → the old runner/workdir is never used to delete a branch.
    expect(cmds.some(c => c.includes('show-ref --verify'))).toBe(false);
    expect(cmds.some(c => /branch\s+-[dD]\b/.test(c))).toBe(false);
  });

  it('createTask records the QA partner before any review dispatch', async () => {
    await seedAgent({ id: 'dev-1' });

    const created = await manager.createTask('proj', {
      title: 'bind the group',
      description: 'details',
      preferredAgentId: 'dev-1',
    });

    expect(created).toMatchObject({
      agentId: 'dev-1',
      qaAgentId: 'qa-1',
      status: 'in_progress',
      reviewRound: 0,
    });
    expect((await taskStore.get(created.id))?.qaAgentId).toBe('qa-1');
  });

  it('createTask queues when preferred dev has a creation token or task binding', async () => {
    await seedAgent({ id: 'dev-1', creationToken: 'tok' });
    const pendingDuringCreate = await manager.createTask('proj', {
      title: 'blocked',
      description: 'details',
      preferredAgentId: 'dev-1',
    });
    expect(pendingDuringCreate.status).toBe('pending');

    await seedAgent({ id: 'dev-1', taskId: 'other-task' });
    const pendingWhileBound = await manager.createTask('proj', {
      title: 'blocked again',
      description: 'details',
      preferredAgentId: 'dev-1',
    });
    expect(pendingWhileBound.status).toBe('pending');
  });

  it('serializes concurrent createTask calls so only one task binds the preferred dev', async () => {
    await seedAgent({ id: 'dev-1' });

    const [first, second] = await Promise.all([
      manager.createTask('proj', {
        title: 'first',
        description: 'details',
        preferredAgentId: 'dev-1',
      }),
      manager.createTask('proj', {
        title: 'second',
        description: 'details',
        preferredAgentId: 'dev-1',
      }),
    ]);

    const bound = [first, second].filter(t => t.status === 'in_progress');
    const queued = [first, second].filter(t => t.status === 'pending');
    expect(bound).toHaveLength(1);
    expect(queued).toHaveLength(1);
    expect((await agentStore.get('dev-1'))?.taskId).toBe(bound[0].id);
  });

  it('safeEmit failures do not block createTask state transitions', async () => {
    await seedAgent({ id: 'dev-1' });
    vi.spyOn(eventBus, 'emit').mockRejectedValueOnce(new Error('event log down'));

    const created = await manager.createTask('proj', {
      title: 'build it',
      description: 'details',
      preferredAgentId: 'dev-1',
    });

    expect(created.status).toBe('in_progress');
    expect((await agentStore.get('dev-1'))?.taskId).toBe(created.id);
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  it('createTask stores custom branch in TaskState', async () => {
    await seedAgent({ id: 'dev-1' });
    const created = await manager.createTask('proj', {
      title: 'custom branch',
      description: 'details',
      preferredAgentId: 'dev-1',
      branch: 'feat/my-feature',
    });
    expect(created.branch).toBe('feat/my-feature');
  });

  it('createTask rejects custom branch starting with reserved bx/ prefix', async () => {
    await seedAgent({ id: 'dev-1' });
    await expect(manager.createTask('proj', {
      title: 'reserved prefix',
      description: 'details',
      preferredAgentId: 'dev-1',
      branch: 'bx/task-other',
    })).rejects.toThrow(/reserved prefix/);
  });

  it.each([
    '-flag-like',
    'feat/../escape',
    'feat@{0}',
    'feat/.hidden',
    'feat/foo.lock',
    'feat/',
    'feat//x',
    'feat/x.',
  ])('createTask rejects git-invalid branch name: %s', async (branch) => {
    await seedAgent({ id: 'dev-1' });
    await expect(manager.createTask('proj', {
      title: 'bad branch',
      description: 'details',
      preferredAgentId: 'dev-1',
      branch,
    })).rejects.toThrow(/Invalid branch name/);
  });

  it('createTask rejects duplicate custom branch within the same project', async () => {
    await seedAgent({ id: 'dev-1' });
    await manager.createTask('proj', {
      title: 'first',
      description: 'details',
      preferredAgentId: 'dev-1',
      branch: 'feat/unique',
    });

    await seedAgent({ id: 'dev-1' });
    await expect(manager.createTask('proj', {
      title: 'second',
      description: 'details',
      preferredAgentId: 'dev-1',
      branch: 'feat/unique',
    })).rejects.toThrow(/already bound to task/);
  });

  it('createTask allows the same custom branch name in different repos', async () => {
    manager = makeManager({
      config: {
        ...CONFIG,
        project: [
          { id: 'proj-a', repo: 'user/repo-a', merge: null, agent: [] },
          { id: 'proj-b', repo: 'user/repo-b', merge: null, agent: [] },
        ],
      },
    });
    await taskStore.set(task({
      id: 'task-other-repo',
      projectId: 'proj-a',
      preferredAgentId: '',
      agentId: '',
      branch: 'feat/shared',
      branchCreatedByBaxian: false,
    }));

    const created = await manager.createTask('proj-b', {
      title: 'same name in another repo',
      description: 'details',
      preferredAgentId: '',
      branch: 'feat/shared',
    });

    expect(created).toMatchObject({ projectId: 'proj-b', branch: 'feat/shared', status: 'pending' });
  });

  it('cancelTask delegates releaseAgentForTask for dev and qa after cancelling the task', async () => {
    const t = await seedTask({ qaAgentId: 'qa-1' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1' });
    mockInterruptPane(manager, true);
    const releaseSpy = vi.spyOn(manager, 'releaseAgentForTask').mockResolvedValue(true);

    const cancelled = await manager.cancelTask(t.id);

    expect(cancelled.status).toBe('cancelled');
    expect(releaseSpy).toHaveBeenCalledWith('dev-1', t.id, 'idle', { allowAwaitingHuman: true, fromCancelCleanup: true });
    expect(releaseSpy).toHaveBeenCalledWith('qa-1', t.id, 'idle', { allowAwaitingHuman: true, fromCancelCleanup: true });
  });

  it('cancelTask on a terminal task still interrupts and releases stale bound agents without rewriting the status', async () => {
    await seedTask({ id: 'task-term', status: 'merged', agentId: 'dev-1', qaAgentId: 'qa-1', updatedAt: NOW });
    await seedAgent({ id: 'dev-1', taskId: 'task-term', paneId: '%0' });
    await seedAgent({ id: 'qa-1', taskId: 'task-term', paneId: '%1' });
    const interruptSpy = mockInterruptPane(manager, true);

    const result = await manager.cancelTask('task-term');

    expect(result.status).toBe('merged');
    expect(interruptSpy).toHaveBeenCalledTimes(2);
    expect(await taskStore.get('task-term')).toMatchObject({ status: 'merged', updatedAt: NOW });
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect((await agentStore.get('qa-1'))?.taskId).toBeUndefined();
    expect(events.some(e => e.type === 'task.updated' && e.taskId === 'task-term')).toBe(false);
  });

  it('cancelTask on a terminal task with no live bindings is a clean no-op', async () => {
    await seedTask({ id: 'task-term2', status: 'cancelled', agentId: 'dev-1', updatedAt: NOW });
    await seedAgent({ id: 'dev-1' });
    const interruptSpy = mockInterruptPane(manager, true);

    const result = await manager.cancelTask('task-term2');

    expect(result.status).toBe('cancelled');
    expect(interruptSpy).not.toHaveBeenCalled();
    expect((await taskStore.get('task-term2'))?.updatedAt).toBe(NOW);
  });

  it('cancelTask on a terminal task still refuses while completion is in flight (409)', async () => {
    await seedTask({ id: 'task-term3', status: 'merged' });
    manager['markCompleteInFlight'].add('task-term3');
    try {
      await expect(manager.cancelTask('task-term3')).rejects.toMatchObject({ status: 409 });
    } finally {
      manager['markCompleteInFlight'].delete('task-term3');
    }
  });

  it('re-clicking cancel on a cancelled task retries a failed interrupt cleanup and frees the held agent', async () => {
    await seedTask({ id: 'task-term4', status: 'cancelled', agentId: 'dev-1', updatedAt: NOW });
    await seedAgent({
      id: 'dev-1',
      taskId: 'task-term4',
      paneId: '%0',
      status: 'awaiting_human',
      awaitingPhase: 'cancel-interrupt-failed',
    });
    mockInterruptPane(manager, true);

    await manager.cancelTask('task-term4');

    const dev = await agentStore.get('dev-1');
    expect(dev?.taskId).toBeUndefined();
    expect(dev?.status).toBeUndefined();
  });

  it('cancelTask stops the watcher again after the cancelled write (closes rollback re-arm race)', async () => {
    const stop = vi.fn();
    const m = makeManager({ phaseSignalWatcher: { start: vi.fn(), stop } as never });
    const t = await seedTask({ qaAgentId: 'qa-1' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1' });
    mockInterruptPane(m, true);
    vi.spyOn(m, 'releaseAgentForTask').mockResolvedValue(true);

    await m.cancelTask(t.id);

    // pre-lock stop() + post-cancelled-write stop(): the second closes the window where a concurrent
    // dispatchReview rollback re-armed a watcher after our first stop() but before 'cancelled' landed
    expect(stop.mock.calls.filter(c => c[0] === t.id)).toHaveLength(2);
  });

  it('cancelTask releases a bound dev through the real release path without task-lock deadlock', async () => {
    const localManager = makeManager({ runnerFactory: () => clearAwareRunner([], () => CLAUDE_PANE) });
    setCompactTiming(localManager);
    const t = await seedTask();
    await seedAgent({
      id: 'dev-1',
      taskId: t.id,
      paneId: '%0',
    });
    await acquireBoundLock('dev-1');

    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('cancelTask timed out')), 1_500);
    });
    const cancelled = await Promise.race([localManager.cancelTask(t.id), timeout]);

    expect(cancelled.status).toBe('cancelled');
    const state = await agentStore.get('dev-1');
    expect(state?.taskId).toBeUndefined();
    expect(state?.paneId).toBe('%0');
    expect(await lockManager.isLocked('dev-1')).toBe(false);
  });

  it('rollbackFailedDispatch clears only the matching binding and releases the lock', async () => {
    const t = await seedTask();
    await seedAgent({
      id: 'dev-1',
      taskId: t.id,
      workdir: '/tmp/wt',
      paneId: '%0',
    });
    await acquireBoundLock('dev-1');

    const token = (await agentStore.get('dev-1'))?.lockToken;
    await manager['rollbackFailedDispatch'](t.id, 'dev-1', undefined, token);

    expect((await taskStore.get(t.id))?.status).toBe('pending');
    const state = await agentStore.get('dev-1');
    expect(state?.taskId).toBeUndefined();
    expect(state?.workdir).toBe('/tmp/wt');
    expect(state?.paneId).toBe('%0');
    expect(await lockManager.isLocked('dev-1')).toBe(false);
  });

  it('rollbackFailedDispatch can safely recover when agent state disappeared but the exact lock remains', async () => {
    const t = await seedTask({ id: 'task-state-missing' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    const token = (await agentStore.get('dev-1'))!.lockToken!;
    await agentStore.delete('dev-1');

    await manager['rollbackFailedDispatch'](t.id, 'dev-1', undefined, token);

    expect((await taskStore.get(t.id))?.status).toBe('pending');
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(false);
  });

  it('rollbackFailedDispatch does not resurrect state deleted by a DELETE→recreate during the rollback', async () => {
    const t = await seedTask({ id: 'task-rb-revive', status: 'in_progress' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    const token = (await agentStore.get('dev-1'))!.lockToken!;
    // A DELETE completes during the task-rollback await: generation bumps and the state file is removed.
    const realSet = taskStore.set.bind(taskStore);
    vi.spyOn(taskStore, 'set').mockImplementation(async (task) => {
      await realSet(task);
      manager.bumpDeletionGeneration('dev-1');
      await agentStore.delete('dev-1');
    });

    await manager['rollbackFailedDispatch'](t.id, 'dev-1', undefined, token);

    // The final write-back must NOT rebuild the deleted incarnation from the stale entry snapshot.
    expect(await agentStore.get('dev-1')).toBeNull();
  });

  it('rollbackFailedDispatch with a reason emits a human.intervention naming the failure', async () => {
    const t = await seedTask();
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await acquireBoundLock('dev-1');

    const token = (await agentStore.get('dev-1'))?.lockToken;
    await manager['rollbackFailedDispatch'](t.id, 'dev-1', {
      phase: 'dispatch-rollback',
      message: 'ensureWorkdir failed: git fetch failed: Could not resolve host',
    }, token);

    expect((await taskStore.get(t.id))?.status).toBe('pending');
    const intervention = events.find(
      e => e.type === 'human.intervention'
        && (e.data as { phase?: string }).phase === 'dispatch-rollback',
    );
    expect(intervention).toBeDefined();
    expect((intervention!.data as { message?: string }).message).toContain('Could not resolve host');
  });

  it('rollbackFailedDispatch stays silent when the task did not need rolling back', async () => {
    const t = await seedTask({ status: 'cancelled' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    const token = (await agentStore.get('dev-1'))?.lockToken;

    await manager['rollbackFailedDispatch'](t.id, 'dev-1', {
      phase: 'dispatch-rollback',
      message: 'irrelevant',
    }, token);

    expect(events.some(
      e => e.type === 'human.intervention'
        && (e.data as { phase?: string }).phase === 'dispatch-rollback',
    )).toBe(false);
  });

  it('rollbackFailedDispatch cannot clear a newer lock generation for the same task', async () => {
    const t = await seedTask();
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    const oldToken = (await agentStore.get('dev-1'))!.lockToken!;
    await lockManager.releaseIfOwner('dev-1', t.id, oldToken);
    const newToken = await lockManager.acquire('dev-1', t.id);
    await agentStore.update('dev-1', state => ({ ...state!, lockToken: newToken!, updatedAt: NOW }));

    await manager['rollbackFailedDispatch'](t.id, 'dev-1', undefined, oldToken);

    expect((await taskStore.get(t.id))?.status).toBe('in_progress');
    expect((await agentStore.get('dev-1'))?.lockToken).toBe(newToken);
    expect(await lockManager.isOwner('dev-1', t.id, newToken!)).toBe(true);
  });

  it('createAndStartTask surfaces a non-terminal dispatch error as a dispatch-rollback intervention', async () => {
    vi.spyOn(manager, 'startSession').mockRejectedValue(
      new Error('ensureWorkdir failed: git fetch failed at /repo: Connection timed out'),
    );

    const created = await manager.createAndStartTask('proj', {
      title: 'T', description: 'D', preferredAgentId: 'dev-1',
    });

    expect(created?.status).toBe('pending');
    const intervention = events.find(
      e => e.type === 'human.intervention'
        && (e.data as { phase?: string }).phase === 'dispatch-rollback',
    );
    expect(intervention).toBeDefined();
    expect((intervention!.data as { message?: string }).message).toContain('Connection timed out');
  });

  it('createAndStartTask skips rollbackFailedDispatch when startSession throws EnsureSessionError(handled=true)', async () => {
    const dialogErr = new EnsureSessionError(
      { createdSession: true, agentId: 'dev-1', dialogPending: true, handled: true },
      'develop dispatch runtime dialog handled',
    );
    vi.spyOn(manager, 'startSession').mockRejectedValue(dialogErr);
    const rollbackSpy = vi.spyOn(manager as never as { rollbackFailedDispatch: (taskId: string, agentId: string) => Promise<void> }, 'rollbackFailedDispatch');

    const created = await manager.createAndStartTask('proj', {
      title: 'T', description: 'D', preferredAgentId: 'dev-1',
    });

    expect(rollbackSpy).not.toHaveBeenCalled();
    expect(created.status).toBe('in_progress');
  });

  it('createAndStartTask({ background: true }) returns without waiting for the session bootstrap', async () => {
    const startSpy = vi.spyOn(manager, 'startSession').mockReturnValue(new Promise<boolean>(() => {}));

    const created = await manager.createAndStartTask(
      'proj',
      { title: 'T', description: 'D', preferredAgentId: 'dev-1' },
      { background: true },
    );

    expect(created.status).toBe('in_progress');
    await vi.waitFor(() => expect(startSpy).toHaveBeenCalledTimes(1));
  });

  it('createAndStartTask({ background: true }) rolls a failed bootstrap back off the create path', async () => {
    vi.spyOn(manager, 'startSession').mockRejectedValue(new Error('boot failed'));
    let rolledBack!: () => void;
    const rollbackDone = new Promise<void>((resolve) => { rolledBack = resolve; });
    const rollbackSpy = vi
      .spyOn(manager as never as { rollbackFailedDispatch: (taskId: string, agentId: string) => Promise<void> }, 'rollbackFailedDispatch')
      .mockImplementation(async () => { rolledBack(); });

    const created = await manager.createAndStartTask(
      'proj',
      { title: 'T', description: 'D', preferredAgentId: 'dev-1' },
      { background: true },
    );

    expect(created.status).toBe('in_progress');
    await rollbackDone;
    expect(rollbackSpy).toHaveBeenCalledTimes(1);
  });

  function mockStartSessionThatCancels(): void {
    vi.spyOn(manager, 'startSession').mockImplementation(async (cancelledTaskId: string) => {
      const t = await taskStore.get(cancelledTaskId);
      if (t) await taskStore.set({ ...t, status: 'cancelled', updatedAt: NOW });
      return true;
    });
  }

  it('createAndStartTask({ background: true }): cancel mid-bootstrap interrupts the pane, then idle-releases', async () => {
    mockStartSessionThatCancels();
    const interruptSpy = mockInterruptPane(manager, true);
    let released!: () => void;
    const releaseDone = new Promise<void>((resolve) => { released = resolve; });
    const releaseSpy = vi.spyOn(manager, 'releaseAgentForTask').mockImplementation(async () => { released(); return true; });
    const armSpy = vi.spyOn(
      manager as never as { armPostDispatchSignalOrHold: (...args: unknown[]) => Promise<void> },
      'armPostDispatchSignalOrHold',
    );

    const created = await manager.createAndStartTask(
      'proj',
      { title: 'T', description: 'D', preferredAgentId: 'dev-1' },
      { background: true },
    );

    await releaseDone;
    expect(interruptSpy).toHaveBeenCalledTimes(1);
    expect(releaseSpy).toHaveBeenCalledWith('dev-1', created.id, 'idle', { allowAwaitingHuman: true, fromCancelCleanup: true });
    expect(armSpy).not.toHaveBeenCalled();
  });

  it('createAndStartTask({ background: true }): cancel mid-bootstrap holds the agent when the pane can not be interrupted', async () => {
    mockStartSessionThatCancels();
    mockInterruptPane(manager, false);
    const releaseSpy = vi.spyOn(manager, 'releaseAgentForTask').mockResolvedValue(true);
    let held!: () => void;
    const holdDone = new Promise<void>((resolve) => { held = resolve; });
    const holdSpy = vi.spyOn(manager, 'markAwaitingHuman').mockImplementation(async () => { held(); return true; });

    const created = await manager.createAndStartTask(
      'proj',
      { title: 'T', description: 'D', preferredAgentId: 'dev-1' },
      { background: true },
    );

    await holdDone;
    expect(holdSpy).toHaveBeenCalledWith('dev-1', 'cancel-interrupt-failed', expect.any(String), { expectedTaskId: created.id });
    expect(releaseSpy).not.toHaveBeenCalled();
  });

  it('createAndStartTask({ background: true }): a watcher arm failure holds the agent instead of being swallowed', async () => {
    vi.spyOn(manager, 'startSession').mockResolvedValue(true);
    vi.spyOn(manager as never as { armPostDispatchSignalOrHold: (...args: unknown[]) => Promise<void> }, 'armPostDispatchSignalOrHold')
      .mockRejectedValue(new Error('watcher store down'));
    let held!: () => void;
    const holdDone = new Promise<void>((resolve) => { held = resolve; });
    const holdSpy = vi
      .spyOn(manager as never as { holdAgentForUnarmedSignal: (...args: unknown[]) => Promise<void> }, 'holdAgentForUnarmedSignal')
      .mockImplementation(async () => { held(); });

    const created = await manager.createAndStartTask(
      'proj',
      { title: 'T', description: 'D', preferredAgentId: 'dev-1' },
      { background: true },
    );

    expect(created.status).toBe('in_progress');
    await holdDone;
    expect(holdSpy).toHaveBeenCalledWith(created.id, 'dev-1', ['spec-done', 'pr-created']);
  });

  it('createAndStartTask: a cancel-cleanup hold from a cancel-before-delivery is NOT auto-released by the !started path', async () => {
    vi.spyOn(manager, 'startSession').mockImplementation(async (cancelledTaskId: string) => {
      const t = await taskStore.get(cancelledTaskId);
      if (t) await taskStore.set({ ...t, status: 'cancelled', updatedAt: NOW });
      await agentStore.update('dev-1', (s) => (s
        ? { ...s, status: 'awaiting_human' as const, awaitingPhase: 'cancel-interrupt-failed', awaitingSince: NOW }
        : s));
      return false;
    });

    const created = await manager.createAndStartTask('proj', { title: 'T', description: 'D', preferredAgentId: 'dev-1' });

    const dev = await agentStore.get('dev-1');
    expect(dev?.taskId).toBe(created.id);
    expect(dev?.awaitingPhase).toBe('cancel-interrupt-failed');
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  it('develop dispatch holds the dev when the spec/pr-created watcher fails to arm', async () => {
    await seedAgent({ id: 'dev-1' });
    const watcher = { start: vi.fn(async () => false), stop: vi.fn(), has: vi.fn(() => false) };
    const skillRegistry = new SkillRegistry(join(tempDir, 'skills'));
    await skillRegistry.scan();
    const m = makeManager({ skillRegistry, phaseSignalWatcher: watcher as never });
    vi.spyOn(m, 'startSession').mockResolvedValue(true);
    const holdSpy = vi.spyOn(m, 'markAwaitingHuman');

    await m.createAndStartTask('proj', { title: 'T', description: 'D', preferredAgentId: 'dev-1' });

    expect(watcher.start).toHaveBeenCalled();
    expect(holdSpy).toHaveBeenCalledWith(
      'dev-1',
      expect.stringContaining('signal-arm-failed'),
      expect.any(String),
      expect.objectContaining({ expectedTaskId: expect.any(String) }),
    );
  });

  it('setupPhaseSignal through the REAL watcher reports false for a config-removed agent; the hold marks it awaiting_human', async () => {
    const t = await seedTask({ id: 'task-ghost', agentId: 'ghost', devAgentId: 'ghost', signalToken: 'tok-1' });
    await seedAgent({ id: 'ghost', taskId: t.id });
    const skillRegistry = new SkillRegistry(join(tempDir, 'skills'));
    await skillRegistry.scan();
    const m = makeManager({
      skillRegistry,
      paneStreamerManager: {
        ensure: () => { throw new Error('unreachable: resolveAgent fails before ensure'); },
      } as never,
    });

    const armed = await m.setupPhaseSignal(t.id, 'ghost', 'pr-created', { skipSnapshot: true });

    expect(armed).toBe(false);
    expect(events.some(
      e => e.type === 'human.intervention'
        && (e.data as { phase?: string }).phase === 'signal-setup-no-agent:pr-created',
    )).toBe(true);

    await m.holdAgentForUnarmedSignal(t.id, 'ghost', 'pr-created');
    const held = await agentStore.get('ghost');
    expect(held?.status).toBe('awaiting_human');
    expect(held?.awaitingPhase).toBe('signal-arm-failed:pr-created');
  });

  it('setupPhaseSignal through the REAL watcher arms and reports true for a configured agent', async () => {
    const t = await seedTask({ id: 'task-armed', signalToken: 'tok-2' });
    const skillRegistry = new SkillRegistry(join(tempDir, 'skills'));
    await skillRegistry.scan();
    const m = makeManager({
      skillRegistry,
      paneStreamerManager: {
        ensure: () => ({
          subscribeAtomic: async () => ({ unsubscribe: () => undefined, snapshot: { data: '' } }),
        }),
      } as never,
    });

    const armed = await m.setupPhaseSignal(t.id, 'dev-1', 'pr-created', { skipSnapshot: true });

    expect(armed).toBe(true);
  });

  it('failTaskForDispatchError fails the task and releases its agent binding', async () => {
    const t = await seedTask();
    await seedAgent({
      id: 'dev-1',
      taskId: t.id,
      paneId: '%0',
    });
    await acquireBoundLock('dev-1');

    await manager.failTaskForDispatchError(
      t.id,
      'develop',
      'dev-1',
      new DispatchTerminalError('prompt_too_large', 'prompt too large'),
    );

    expect((await taskStore.get(t.id))?.status).toBe('failed');
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(false);
  });

  it('validateTaskDispatch raises ApiError(500) when preflight hits RequiredSkillsMissingError', async () => {
    const unseededSkillsDir = join(tempDir, 'skills-empty');
    await mkdir(unseededSkillsDir, { recursive: true });
    const emptyRegistry = new SkillRegistry(unseededSkillsDir);
    await emptyRegistry.scan();
    const badManager = makeManager({ skillRegistry: emptyRegistry });
    await seedAgent({ id: 'dev-1' });

    let caught: unknown;
    try {
      await badManager.validateTaskDispatch('proj', {
        title: 'x',
        description: 'y',
        preferredAgentId: 'dev-1',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(500);
    expect((caught as Error).message).toMatch(/required skill/i);
  });

  it('validateTaskDispatch fails fast when baxian-signals is missing (preview carries a signal token)', async () => {
    const partialDir = join(tempDir, 'skills-no-signals');
    await mkdir(join(partialDir, 'baxian-task-check'), { recursive: true });
    await writeFile(
      join(partialDir, 'baxian-task-check', 'SKILL.md'),
      `---\nname: baxian-task-check\ndescription: stub\n---\nstub`,
    );
    const registry = new SkillRegistry(partialDir);
    await registry.scan();
    const mgr2 = makeManager({ skillRegistry: registry });
    await seedAgent({ id: 'dev-1' });

    let caught: unknown;
    try {
      await mgr2.validateTaskDispatch('proj', { title: 'x', description: 'y', preferredAgentId: 'dev-1' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(500);
    expect((caught as Error).message).toMatch(/baxian-signals/);
  });

  it('failTaskForDispatchError accepts required_skills_missing reason', async () => {
    const t = await seedTask({ id: 'task-skills' });
    await seedAgent({
      id: 'dev-1',
      taskId: t.id,
      paneId: '%0',
    });
    await acquireBoundLock('dev-1');

    await manager.failTaskForDispatchError(
      t.id,
      'develop',
      'dev-1',
      new DispatchTerminalError('required_skills_missing', 'missing baxian-task-check'),
    );

    expect((await taskStore.get(t.id))?.status).toBe('failed');
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
  });

  it('startSession ack_unknown preserves binding/lock/worktree (so downstream markAwaitingHuman can take over)', async () => {
    const t = await seedTask({ id: 'task-startsession-ack-unknown', branch: 'bx/task-startsession-ack-unknown' });
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
    });
    await acquireBoundLock('dev-1');
    const beforeUpdatedAt = NOW;

    stubEnsureSession(manager);
    vi.spyOn(manager as unknown as { injectAndAwaitAck: () => Promise<void> }, 'injectAndAwaitAck')
      .mockRejectedValue(new DispatchTerminalError('ack_unknown', 'simulated ack_unknown from infra failure'));
    const minimalRunner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('git worktree add')) return { stdout: '', stderr: '', exitCode: 0 };
        if (cmd.includes('git rev-parse')) return { stdout: 'abc123\n', stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async () => undefined),
      execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
    };
    (manager as unknown as { runnerFactory: () => CommandRunner }).runnerFactory = () => minimalRunner;

    await expect(manager.startSession(t.id, 'dev-1', 'develop')).rejects.toBeInstanceOf(DispatchTerminalError);

    const stateAfter = await agentStore.get('dev-1');
    expect(stateAfter?.taskId).toBe(t.id);
    expect(stateAfter?.workdir).toBeTruthy();
    expect(stateAfter?.updatedAt).not.toBe(beforeUpdatedAt);
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  it('startSession cleanup leaves the binding when cancel took it over (cancel-clearing) during the mutex wait', async () => {
    const t = await seedTask({ id: 'task-ss-cancel-clearing', branch: 'bx/task-ss-cancel-clearing' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await acquireBoundLock('dev-1');

    stubEnsureSession(manager);
    vi.spyOn(manager as unknown as { injectAndAwaitAck: () => Promise<unknown> }, 'injectAndAwaitAck')
      .mockImplementation(async () => {
        await (manager as unknown as { markPaneCancelClearing: (a: string, tid: string) => Promise<void> })
          .markPaneCancelClearing('dev-1', t.id);
        throw new Error('dispatch aborted: task went terminal while waiting for pane mutex');
      });
    const minimalRunner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('git worktree add')) return { stdout: '', stderr: '', exitCode: 0 };
        if (cmd.includes('git rev-parse')) return { stdout: 'abc123\n', stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async () => undefined),
      execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
    };
    (manager as unknown as { runnerFactory: () => CommandRunner }).runnerFactory = () => minimalRunner;

    await expect(manager.startSession(t.id, 'dev-1', 'develop')).rejects.toThrow(/went terminal/);

    const stateAfter = await agentStore.get('dev-1');
    expect(stateAfter?.taskId).toBe(t.id);
    expect(stateAfter?.awaitingPhase).toBe('cancel-clearing');
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  it('startSession set-running write preserves a cancel-clearing hold present at write time (does NOT wipe it)', async () => {
    const t = await seedTask({ id: 'task-ss-cancel-clearing-prewrite', branch: 'bx/task-ss-cancel-clearing-prewrite' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-clearing' });
    await acquireBoundLock('dev-1');

    stubEnsureSession(manager);
    const injectSpy = vi.spyOn(manager as unknown as { injectAndAwaitAck: () => Promise<unknown> }, 'injectAndAwaitAck')
      .mockRejectedValue(new Error('injectAndAwaitAck must not run when a cancel hold owns the binding'));
    const minimalRunner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('git worktree add')) return { stdout: '', stderr: '', exitCode: 0 };
        if (cmd.includes('git rev-parse')) return { stdout: 'abc123\n', stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async () => undefined),
      execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
    };
    (manager as unknown as { runnerFactory: () => CommandRunner }).runnerFactory = () => minimalRunner;

    const result = await manager.startSession(t.id, 'dev-1', 'develop');

    expect(result).toBe(false);
    expect(injectSpy).not.toHaveBeenCalled();
    const stateAfter = await agentStore.get('dev-1');
    expect(stateAfter?.taskId).toBe(t.id);
    expect(stateAfter?.awaitingPhase).toBe('cancel-clearing');
    expect(stateAfter?.bootstrappingTaskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  it('rollbackFailedDispatch leaves the binding/lock when the agent is held by cancel cleanup', async () => {
    const t = await seedTask({ id: 'task-rollback-cancel', status: 'cancelled' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-clearing' });
    await acquireBoundLock('dev-1');

    const token = (await agentStore.get('dev-1'))?.lockToken;
    await (manager as unknown as {
      rollbackFailedDispatch: (tid: string, aid: string, reason?: unknown, token?: string) => Promise<void>;
    }).rollbackFailedDispatch(t.id, 'dev-1', undefined, token);

    const st = await agentStore.get('dev-1');
    expect(st?.taskId).toBe(t.id);
    expect(st?.awaitingPhase).toBe('cancel-clearing');
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  it('failTaskForDispatchError on ack_unknown releases partner agents (terminal cleanup)', async () => {
    const t = await seedTask({ id: 'task-ack-partner', status: 'review', qaAgentId: 'qa-1' });
    await seedAgent({
      id: 'qa-1', taskId: t.id, paneId: '%1',
    });
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
    });
    await acquireBoundLock('qa-1');
    await acquireBoundLock('dev-1');

    await manager.failTaskForDispatchError(
      t.id, 'review', 'qa-1',
      new DispatchTerminalError('ack_unknown', 'simulated'),
    );

    expect((await agentStore.get('qa-1'))?.status).toBe('awaiting_human');
    expect((await agentStore.get('qa-1'))?.taskId).toBe(t.id);
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(false);
  });

  it('failTaskForDispatchError preserves binding on ack_unknown (prompt may already be running)', async () => {
    const t = await seedTask({ id: 'task-ack-unknown' });
    await seedAgent({
      id: 'dev-1',
      taskId: t.id,
      paneId: '%0',
    });
    await acquireBoundLock('dev-1');
    const releaseSpy = vi.spyOn(manager, 'releaseAgentForTask');

    await manager.failTaskForDispatchError(
      t.id,
      'develop',
      'dev-1',
      new DispatchTerminalError('ack_unknown', 'capture-pane failed mid-wait'),
    );

    expect((await taskStore.get(t.id))?.status).toBe('failed');
    const stateAfter = await agentStore.get('dev-1');
    expect(stateAfter?.taskId).toBe(t.id);
    expect(stateAfter?.status).toBe('awaiting_human');
    expect(stateAfter?.awaitingPhase).toBe('dispatch-failed:ack_unknown');
    expect(await lockManager.isLocked('dev-1')).toBe(true);
    expect(releaseSpy).toHaveBeenCalledWith(
      'qa-1',
      t.id,
      'idle',
      { allowAwaitingHuman: true },
    );
    expect(releaseSpy.mock.calls.some(([agentId]) => agentId === 'dev-1')).toBe(false);

    const interventions = events.filter(
      e => e.type === 'human.intervention' &&
        typeof (e.data as { phase?: string }).phase === 'string' &&
        (e.data as { phase: string }).phase.startsWith('dispatch-failed:ack_unknown'),
    );
    expect(interventions).toHaveLength(1);

    releaseSpy.mockRestore();
  });
});

describe('AgentManager transitionTaskStatus', () => {
  it('persists a valid non-terminal transition and returns the previous status', async () => {
    await seedTask({ id: 'task-transition', status: 'in_progress', updatedAt: NOW });

    const result = await manager.transitionTaskStatus(
      'task-transition',
      'review',
      { fromStatus: ['in_progress', 'fixing'] },
    );

    expect(result).toMatchObject({
      previousStatus: 'in_progress',
      task: { id: 'task-transition', status: 'review' },
    });
    expect((await taskStore.get('task-transition'))?.status).toBe('review');
    expect((await taskStore.get('task-transition'))?.updatedAt).not.toBe(NOW);
  });

  it('returns null and leaves the task unchanged when fromStatus does not match', async () => {
    await seedTask({ id: 'task-guard', status: 'in_progress', updatedAt: NOW });

    const result = await manager.transitionTaskStatus(
      'task-guard',
      'merged',
      { fromStatus: ['review', 'approved'] },
    );

    expect(result).toBeNull();
    expect(await taskStore.get('task-guard')).toMatchObject({
      status: 'in_progress',
      updatedAt: NOW,
    });
  });

  it('refuses terminal tasks even when the guard includes the terminal status', async () => {
    for (const terminal of ['merged', 'failed', 'cancelled'] as const) {
      await seedTask({ id: `task-${terminal}`, status: terminal });
      await expect(
        manager.transitionTaskStatus(`task-${terminal}`, 'review', { fromStatus: [terminal] }),
      ).resolves.toBeNull();
      expect((await taskStore.get(`task-${terminal}`))?.status).toBe(terminal);
    }
  });

  it('returns null for an unknown task', async () => {
    await expect(
      manager.transitionTaskStatus('missing-task', 'review', { fromStatus: ['in_progress'] }),
    ).resolves.toBeNull();
  });

  it('persists the supplied task patch with the transition', async () => {
    await seedTask({ id: 'task-patch', status: 'in_progress', reviewRound: 0 });

    const result = await manager.transitionTaskStatus(
      'task-patch',
      'review',
      { fromStatus: ['in_progress'] },
      {
        reviewRound: 1,
        prNumber: 87,
        prUrl: 'https://github.com/baxian-ai/baxian/pull/87',
        qaAgentId: 'qa-1',
        latestHeadSha: 'abc123',
      },
    );

    expect(result?.task).toMatchObject({
      status: 'review',
      reviewRound: 1,
      prNumber: 87,
      prUrl: 'https://github.com/baxian-ai/baxian/pull/87',
      qaAgentId: 'qa-1',
      latestHeadSha: 'abc123',
    });
    expect(await taskStore.get('task-patch')).toMatchObject({
      status: 'review',
      reviewRound: 1,
      prNumber: 87,
      qaAgentId: 'qa-1',
      latestHeadSha: 'abc123',
    });
  });

  it('updates only the captured task generation including its bound agent', async () => {
    await seedTask({
      id: 'task-update-guard',
      status: 'review',
      phase: 'code',
      signalToken: 'token-1',
      agentId: 'dev-1',
      reviewRound: 2,
      pendingPrSignalToken: 'pending-token-1',
    });

    await expect(manager.updateTaskIfStatus(
      'task-update-guard',
      'review',
      { pendingPrSignalToken: undefined },
      {
        phase: 'code',
        signalToken: 'token-1',
        agentId: 'dev-2',
        reviewRound: 2,
      },
    )).resolves.toBe(false);
    expect(await taskStore.get('task-update-guard')).toMatchObject({
      agentId: 'dev-1',
      pendingPrSignalToken: 'pending-token-1',
    });

    await expect(manager.updateTaskIfStatus(
      'task-update-guard',
      'review',
      { pendingPrSignalToken: undefined },
      {
        phase: 'code',
        signalToken: 'token-1',
        agentId: 'dev-1',
        reviewRound: 2,
      },
    )).resolves.toBe(true);
    const updated = await taskStore.get('task-update-guard');
    expect(updated?.pendingPrSignalToken).toBeUndefined();
  });
});

describe('AgentManager.redispatchTaskPromptAfterReplRestart', () => {
  function restartManager(): AgentManager {
    return makeManager({ config: CONFIG, skillRegistry: freshRegistry() });
  }

  function spyDispatch(m: AgentManager): {
    clearSpy: ReturnType<typeof vi.spyOn>;
    continueSpy: ReturnType<typeof vi.spyOn>;
    holdSpy: ReturnType<typeof vi.spyOn>;
    armedWith: () => Promise<unknown[][]>;
  } {
    const clearSpy = vi.spyOn(m, 'clearAwaitingHuman').mockResolvedValue(true);
    const continueSpy = vi.spyOn(m, 'continueSession').mockImplementation(async (...args) => {
      const opts = args[3] as { armBeforeInject?: (ctx: object) => Promise<boolean> };
      return opts.armBeforeInject ? opts.armBeforeInject({}) : true;
    });
    const holdSpy = vi.spyOn(m, 'markAwaitingHuman').mockResolvedValue(true);
    const watcherSpy = vi.spyOn(
      m as unknown as { setupPhaseSignalWatcher: (...args: unknown[]) => Promise<boolean> },
      'setupPhaseSignalWatcher',
    ).mockResolvedValue(true);
    const armedWith = async (): Promise<unknown[][]> => watcherSpy.mock.calls;
    return { clearSpy, continueSpy, holdSpy, armedWith };
  }

  async function rotatedTaskToken(taskId: string, oldToken: string): Promise<string> {
    const token = (await taskStore.get(taskId))?.signalToken;
    expect(token).toEqual(expect.any(String));
    expect(token).not.toBe(oldToken);
    return token!;
  }

  function expectReplayArm(
    calls: unknown[][],
    taskId: string,
    agentId: string,
    expectedKinds: readonly string[],
    oldToken: string,
    newToken: string,
  ): void {
    expect(calls).toEqual([[
      taskId,
      agentId,
      expectedKinds,
      newToken,
      expect.objectContaining({
        skipSnapshot: true,
        onlyReplaceOwnToken: true,
        replaceFromToken: oldToken,
        replaceScope: 'agent',
        preparedReplay: expect.any(Object),
      }),
    ]]);
  }

  it('replays the initial develop prompt for a dev holder with in-flight-safe options', async () => {
    const m = restartManager();
    await seedTask({
      id: 'task-dev-restart',
      status: 'in_progress',
      signalToken: 'dev-token-1',
      pendingPrSignalToken: 'dev-token-1',
    });
    const { continueSpy, armedWith } = spyDispatch(m);

    expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-dev-restart')).toBe(true);
    const newToken = await rotatedTaskToken('task-dev-restart', 'dev-token-1');
    expect((await taskStore.get('task-dev-restart'))?.pendingPrSignalToken).toBe(newToken);
    expect(continueSpy).toHaveBeenCalledWith(
      'task-dev-restart',
      'dev-1',
      'develop',
      expect.objectContaining({
        signalToken: newToken,
        allowDirtyWorkdir: true,
        armBeforeInject: expect.any(Function),
      }),
    );
    expect((continueSpy.mock.calls[0]![3] as { bypassTaskStatusGate?: boolean }).bypassTaskStatusGate)
      .toBeUndefined();
    expectReplayArm(await armedWith(), 'task-dev-restart', 'dev-1', ['spec-done', 'pr-created'], 'dev-token-1', newToken);
  });

  it('replays a git code phase without server Spec documents', async () => {
    const m = restartManager();
    await seedTask({
      id: 'task-git-code-restart',
      status: 'in_progress',
      phase: 'code',
      specReviewRound: 2,
      signalToken: 'git-code-token',
    });
    await seedAgent({ id: 'dev-1', taskId: 'task-git-code-restart' });
    const { continueSpy, holdSpy, armedWith } = spyDispatch(m);

    expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-git-code-restart')).toBe(true);
    const newToken = await rotatedTaskToken('task-git-code-restart', 'git-code-token');
    expect(holdSpy).not.toHaveBeenCalled();
    expect(continueSpy).toHaveBeenCalledWith(
      'task-git-code-restart',
      'dev-1',
      'code',
      expect.objectContaining({
        signalToken: newToken,
        allowDirtyWorkdir: true,
      }),
    );
    expect(continueSpy.mock.calls[0]?.[3]).not.toHaveProperty('specDocuments');
    expectReplayArm(
      await armedWith(),
      'task-git-code-restart',
      'dev-1',
      ['pr-created'],
      'git-code-token',
      newToken,
    );
  });

  it('finalizes an interrupted git code bootstrap after replay', async () => {
    const m = restartManager();
    await seedTask({
      id: 'task-git-code-boot-restart',
      status: 'in_progress',
      phase: 'code',
      specReviewRound: 1,
      signalToken: 'git-code-boot-token',
    });
    await seedAgent({
      id: 'dev-1',
      taskId: 'task-git-code-boot-restart',
      bootstrappingTaskId: 'task-git-code-boot-restart',
    });
    const { continueSpy, holdSpy } = spyDispatch(m);

    expect(await m.redispatchTaskPromptAfterReplRestart(
      'dev-1',
      'task-git-code-boot-restart',
    )).toBe(true);
    expect(continueSpy).toHaveBeenCalledOnce();
    expect(holdSpy).not.toHaveBeenCalled();
    expect((await agentStore.get('dev-1'))?.bootstrappingTaskId).toBeUndefined();
  });

  it('replays spec fixing from PR feedback', async () => {
    const m = restartManager();
    await seedTask({
      id: 'task-git-spec-fix-restart',
      status: 'fixing',
      phase: 'spec',
      specReviewRound: 2,
      signalToken: 'git-spec-fix-token',
    });
    await seedAgent({ id: 'dev-1', taskId: 'task-git-spec-fix-restart' });
    const { continueSpy, holdSpy } = spyDispatch(m);

    expect(await m.redispatchTaskPromptAfterReplRestart(
      'dev-1',
      'task-git-spec-fix-restart',
    )).toBe(true);
    expect(holdSpy).not.toHaveBeenCalled();
    expect(continueSpy).toHaveBeenCalledWith(
      'task-git-spec-fix-restart',
      'dev-1',
      'fix',
      expect.objectContaining({
        allowDirtyWorkdir: true,
      }),
    );
    expect(continueSpy.mock.calls[0]?.[3]).not.toHaveProperty('serverPriorFindings');
  });

  it('replays the PR-feedback fix prompt for a github fixing pass', async () => {
    const m = restartManager();
    await seedTask({
      id: 'task-dev-fix-restart',
      status: 'fixing',
      phase: 'code',
      reviewRound: 1,
      signalToken: 'dev-fix-token',
      pendingPrSignalToken: 'initial-pr-token',
    });
    const { continueSpy, armedWith } = spyDispatch(m);

    expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-dev-fix-restart')).toBe(true);
    const newToken = await rotatedTaskToken('task-dev-fix-restart', 'dev-fix-token');
    expect((await taskStore.get('task-dev-fix-restart'))?.pendingPrSignalToken).toBe('initial-pr-token');
    expect(continueSpy).toHaveBeenCalledWith(
      'task-dev-fix-restart',
      'dev-1',
      'fix',
      expect.objectContaining({
        signalToken: newToken,
        allowDirtyWorkdir: true,
      }),
    );
    expect((continueSpy.mock.calls[0]![3] as { serverPriorFindings?: string }).serverPriorFindings)
      .toBeUndefined();
    expectReplayArm(await armedWith(), 'task-dev-fix-restart', 'dev-1', ['pr-fixed'], 'dev-fix-token', newToken);
  });

  it('replays the PR-feedback fix prompt when the fixing pass never persisted a phase', async () => {
    const m = restartManager();
    await seedTask({
      id: 'task-dev-fix-nophase-restart',
      status: 'fixing',
      reviewRound: 1,
      signalToken: 'dev-fix-nophase-token',
    });
    const { continueSpy, armedWith } = spyDispatch(m);

    expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-dev-fix-nophase-restart')).toBe(true);
    const newToken = await rotatedTaskToken('task-dev-fix-nophase-restart', 'dev-fix-nophase-token');
    expect(continueSpy).toHaveBeenCalledWith(
      'task-dev-fix-nophase-restart',
      'dev-1',
      'fix',
      expect.objectContaining({
        signalToken: newToken,
        allowDirtyWorkdir: true,
      }),
    );
    expectReplayArm(await armedWith(), 'task-dev-fix-nophase-restart', 'dev-1', ['pr-fixed'], 'dev-fix-nophase-token', newToken);
  });

  it('arms replay watchers without consuming the stale pane snapshot', async () => {
    const m = restartManager();
    await seedTask({
      id: 'task-snap-restart',
      status: 'in_progress',
      signalToken: 'snap-token-1',
    });
    const { armedWith } = spyDispatch(m);

    expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-snap-restart')).toBe(true);
    const newToken = await rotatedTaskToken('task-snap-restart', 'snap-token-1');
    expectReplayArm(await armedWith(), 'task-snap-restart', 'dev-1', ['spec-done', 'pr-created'], 'snap-token-1', newToken);
  });

  it('persists the same rotated token that is rendered into the replay prompt', async () => {
    const m = manager;
    const oldToken = 'prompt-old-token';
    await seedTask({ id: 'task-prompt-token', status: 'in_progress', signalToken: oldToken });
    await seedAgent({
      id: 'dev-1', taskId: 'task-prompt-token', paneId: '%0',
      workdir: '/tmp/repo/.baxian-worktrees/wt',
    });
    stubEnsureSession(m);
    const injected: string[] = [];
    stubInject(m, async (_tmux, _paneId, prompt) => {
      injected.push(prompt);
      return { acked: true, composerDelivered: true };
    });

    expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-prompt-token')).toBe(true);

    const newToken = await rotatedTaskToken('task-prompt-token', oldToken);
    expect(injected).toHaveLength(1);
    expect(injected[0]).toContain(`token: ${newToken}`);
    expect(injected[0]).not.toContain(`token: ${oldToken}`);
  });

  it('tears down the replay arm and aborts the paste when the pass advances during arming', async () => {
    const m = manager;
    await seedTask({
      id: 'task-arm-drift',
      status: 'in_progress',
      signalToken: 'arm-stale-1',
    });
    await seedAgent({
      id: 'dev-1', taskId: 'task-arm-drift', paneId: '%0',
      workdir: '/tmp/repo/.baxian-worktrees/wt',
    });
    stubEnsureSession(m);
    const watcherSpy = vi.spyOn(
      m as unknown as { setupPhaseSignalWatcher: (...args: unknown[]) => Promise<boolean> },
      'setupPhaseSignalWatcher',
    ).mockImplementation(async () => {
      const fresh = await taskStore.get('task-arm-drift');
      await taskStore.set({ ...fresh!, phase: 'code', signalToken: 'arm-rotated-2' });
      return true;
    });
    const injected: string[] = [];
    stubInject(m, async (_tmux, _paneId, prompt) => {
      injected.push(prompt);
      return { acked: true, composerDelivered: true };
    });

    await expect(m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-arm-drift'))
      .resolves.toBe(false);
    expect(watcherSpy).toHaveBeenCalledTimes(1);
    expect(injected).toEqual([]);
  });

  it('aborts the paste when the pass rotates after arming but before inject', async () => {
    const m = manager;
    await seedTask({
      id: 'task-paste-drift',
      status: 'in_progress',
      signalToken: 'paste-stale-1',
    });
    await seedAgent({
      id: 'dev-1', taskId: 'task-paste-drift', paneId: '%0',
      workdir: '/tmp/repo/.baxian-worktrees/wt',
    });
    stubEnsureSession(m);
    let armed = false;
    const watcherSpy = vi.spyOn(
      m as unknown as { setupPhaseSignalWatcher: (...args: unknown[]) => Promise<boolean> },
      'setupPhaseSignalWatcher',
    ).mockImplementation(async () => {
      armed = true;
      return true;
    });
    let drifted = false;
    const realUpdate = agentStore.update.bind(agentStore);
    vi.spyOn(agentStore, 'update').mockImplementation(async (id, updater) => {
      if (armed && !drifted) {
        drifted = true;
        const fresh = await taskStore.get('task-paste-drift');
        await taskStore.set({ ...fresh!, phase: 'code', signalToken: 'paste-rotated-2' });
      }
      return realUpdate(id, updater);
    });
    const injected: string[] = [];
    stubInject(m, async (_tmux, _paneId, prompt) => {
      injected.push(prompt);
      return { acked: true, composerDelivered: true };
    });

    await expect(m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-paste-drift'))
      .resolves.toBe(false);
    expect(watcherSpy).toHaveBeenCalledTimes(1);
    expect(injected).toEqual([]);
  });

  it('finalizes the bootstrap marker and delivery evidence after replaying an interrupted initial develop', async () => {
    const m = manager;
    await seedTask({
      id: 'task-boot-replay',
      status: 'in_progress',
      signalToken: 'boot-token-1',
    });
    await seedAgent({
      id: 'dev-1', taskId: 'task-boot-replay', paneId: '%0',
      workdir: '/tmp/repo', bootstrappingTaskId: 'task-boot-replay',
    });
    vi.spyOn(m, 'clearAwaitingHuman').mockResolvedValue(true);
    const continueSpy = vi.spyOn(m, 'continueSession').mockResolvedValue(true);

    expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-boot-replay')).toBe(true);
    expect(continueSpy).toHaveBeenCalled();
    // An undelivered bootstrap keeps the fresh-dispatch clean gate: no dirty-workdir bypass.
    expect((continueSpy.mock.calls[0]![3] as { allowDirtyWorkdir?: boolean }).allowDirtyWorkdir)
      .toBeUndefined();
    expect((await agentStore.get('dev-1'))?.bootstrappingTaskId).toBeUndefined();
    expect(events.some(e =>
      e.type === 'session.started' && e.taskId === 'task-boot-replay' && e.data.phase === 'develop',
    )).toBe(true);
  });

  it('keeps the bootstrap marker and holds the rotated pass when the replay is not delivered', async () => {
    const m = manager;
    await seedTask({
      id: 'task-boot-keep',
      status: 'in_progress',
      signalToken: 'boot-token-2',
    });
    await seedAgent({
      id: 'dev-1', taskId: 'task-boot-keep', paneId: '%0',
      workdir: '/tmp/repo', bootstrappingTaskId: 'task-boot-keep',
    });
    vi.spyOn(m, 'clearAwaitingHuman').mockResolvedValue(true);
    vi.spyOn(m, 'continueSession').mockResolvedValue(false);

    expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-boot-keep')).toBe(true);
    expect(await rotatedTaskToken('task-boot-keep', 'boot-token-2')).toEqual(expect.any(String));
    expect((await agentStore.get('dev-1'))?.bootstrappingTaskId).toBe('task-boot-keep');
    expect((await agentStore.get('dev-1'))?.awaitingPhase).toBe('restart-redispatch-failed');
    expect(events.some(e => e.type === 'session.started' && e.taskId === 'task-boot-keep')).toBe(false);
  });

  it('hold CAS distinguishes generations rewritten within the same millisecond', async () => {
    const m = manager;
    await seedTask({ id: 'task-aba-hold', status: 'in_progress' });
    await seedAgent({ id: 'dev-1', taskId: 'task-aba-hold', paneId: '%0' });
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-07-01T00:00:00.000Z') });
    try {
      await m.markAwaitingHuman('dev-1', 'hold-x', 'first generation');
      const gen1 = await agentStore.get('dev-1');
      const entry = {
        phase: gen1?.awaitingPhase,
        since: gen1?.awaitingSince,
        nonce: gen1?.awaitingNonce,
      };

      await m.clearAwaitingHuman('dev-1');
      await m.markAwaitingHuman('dev-1', 'hold-x', 'second generation');
      const gen2 = await agentStore.get('dev-1');
      expect(gen2?.awaitingSince).toBe(gen1?.awaitingSince);
      expect(gen2?.awaitingNonce).not.toBe(gen1?.awaitingNonce);

      expect(await m.clearAwaitingHuman('dev-1', { expectedHold: entry })).toBe(false);
      expect((await agentStore.get('dev-1'))?.status).toBe('awaiting_human');
      expect((await agentStore.get('dev-1'))?.awaitingReason).toBe('second generation');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not replay a delivered bootstrap held on a failed marker clear', async () => {
    const m = manager;
    await seedTask({
      id: 'task-boot-delivered',
      status: 'in_progress',
      signalToken: 'boot-token-3',
    });
    await seedAgent({
      id: 'dev-1', taskId: 'task-boot-delivered', paneId: '%0',
      workdir: '/tmp/repo', bootstrappingTaskId: 'task-boot-delivered',
      status: 'awaiting_human',
      awaitingPhase: 'bootstrap-marker-clear-failed',
      awaitingReason: 'marker clear failed after delivery',
      awaitingSince: NOW,
    });
    const continueSpy = vi.spyOn(m, 'continueSession').mockResolvedValue(true);

    expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-boot-delivered')).toBe(true);
    expect(continueSpy).not.toHaveBeenCalled();
    const state = await agentStore.get('dev-1');
    expect(state?.status).toBe('awaiting_human');
    expect(state?.awaitingPhase).toBe('restart-redispatch-failed');
    expect(state?.awaitingReason).toMatch(/already delivered/);
  });

  it('aborts the replay before arming when the pass moved on mid-dispatch', async () => {
    const m = manager;
    await seedTask({
      id: 'task-drift-restart',
      status: 'in_progress',
      signalToken: 'stale-token-1',
    });
    await seedAgent({
      id: 'dev-1', taskId: 'task-drift-restart', paneId: '%0',
      workdir: '/tmp/repo/.baxian-worktrees/wt',
    });
    stubEnsureSession(m);
    vi.spyOn(m, 'ensureSession').mockImplementation(async (agentId) => {
      const fresh = await taskStore.get('task-drift-restart');
      await taskStore.set({ ...fresh!, phase: 'code', signalToken: 'rotated-token-2' });
      return {
        ok: true, createdSession: false, freshRuntime: false, paneId: '%0',
        workdir: (await agentStore.get(agentId))?.workdir ?? '/tmp/repo',
      };
    });
    const watcherSpy = vi.spyOn(
      m as unknown as { setupPhaseSignalWatcher: (...args: unknown[]) => Promise<boolean> },
      'setupPhaseSignalWatcher',
    ).mockResolvedValue(true);
    const injected: string[] = [];
    stubInject(m, async (_tmux, _paneId, prompt) => {
      injected.push(prompt);
      return { acked: true, composerDelivered: true };
    });

    await expect(m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-drift-restart'))
      .resolves.toBe(false);
    expect(watcherSpy).not.toHaveBeenCalled();
    expect(injected).toEqual([]);
  });

  it('rotates an embedded git post-approve token without losing episode metadata', async () => {
    const m = restartManager();
    await seedTask({
      id: 'task-postapprove-git-restart',
      status: 'approved',
      signalToken: 'task-token-git',
      postApproveGeneration: 'feedfeedfeed',
      postApproveHeadSha: 'a'.repeat(40),
      postApproveToken: 'git-pa-token-1',
      postApprovePhase: 'installed',
      redispatchCount: 4,
      pendingRedispatch: true,
      consumedFeedback: { review_1: 17 },
    });
    const confirm = vi.spyOn(m, 'confirmPostApprovePromptDelivered').mockResolvedValue();
    const { continueSpy } = spyDispatch(m);

    expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-postapprove-git-restart')).toBe(true);

    const task = await taskStore.get('task-postapprove-git-restart');
    expect(task?.postApproveToken).not.toBe('git-pa-token-1');
    expect(task).toMatchObject({
      postApproveGeneration: 'feedfeedfeed',
      postApproveHeadSha: 'a'.repeat(40),
      postApprovePhase: 'installed',
      redispatchCount: 4,
      pendingRedispatch: true,
      consumedFeedback: { review_1: 17 },
    });
    expect(continueSpy).toHaveBeenCalledWith(
      'task-postapprove-git-restart',
      'dev-1',
      'post-approve',
      expect.objectContaining({ signalToken: task!.postApproveToken }),
    );
    expect(confirm).toHaveBeenCalledWith('task-postapprove-git-restart', {
      generation: 'feedfeedfeed',
      headSha: 'a'.repeat(40),
      token: task!.postApproveToken,
    });
  });

  it('holds the post-approve replay when neither completion nor approved head survive', async () => {
    const m = restartManager();
    await seedTask({
      id: 'task-postapprove-lost',
      status: 'approved',
      signalToken: 'tok-x',
    });
    const { continueSpy, holdSpy } = spyDispatch(m);

    expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-postapprove-lost')).toBe(true);
    expect(continueSpy).not.toHaveBeenCalled();
    expect(await m.getPostApproveCompletion('task-postapprove-lost')).toBeNull();
    expect(holdSpy).toHaveBeenCalledWith(
      'dev-1',
      'restart-redispatch-failed',
      expect.any(String),
      expect.objectContaining({ expectedTaskId: 'task-postapprove-lost' }),
    );
  });

  it('holds the rebuild when only a drifted latestHeadSha is persisted', async () => {
    const m = restartManager();
    await seedTask({
      id: 'task-postapprove-drifted',
      status: 'approved',
      latestHeadSha: 'unreviewed-sha-B',
    });
    const { continueSpy, holdSpy } = spyDispatch(m);

    expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-postapprove-drifted')).toBe(true);
    expect(continueSpy).not.toHaveBeenCalled();
    expect(await m.getPostApproveCompletion('task-postapprove-drifted')).toBeNull();
    expect(holdSpy).toHaveBeenCalledWith(
      'dev-1',
      'restart-redispatch-failed',
      expect.any(String),
      expect.objectContaining({ expectedTaskId: 'task-postapprove-drifted' }),
    );
  });

  it('markAwaitingHuman reports whether the hold generation write landed', async () => {
    const m = restartManager();
    await seedTask({ id: 'task-mark-cas', status: 'in_progress', signalToken: 'mc-T1' });
    await seedAgent({
      id: 'dev-1', taskId: 'task-mark-cas',
      status: 'awaiting_human', awaitingPhase: 'phase-a', awaitingReason: 'r', awaitingSince: NOW,
    });

    expect(await m.markAwaitingHuman('dev-1', 'phase-b', 'r2', {
      expectedTaskId: 'task-mark-cas',
      expectedHold: { phase: 'phase-x', since: NOW },
    })).toBe(false);
    expect((await agentStore.get('dev-1'))?.awaitingPhase).toBe('phase-a');

    expect(await m.markAwaitingHuman('dev-1', 'phase-b', 'r2', {
      expectedTaskId: 'task-mark-cas',
      expectedHold: { phase: 'phase-a', since: NOW },
    })).toBe(true);
    expect((await agentStore.get('dev-1'))?.awaitingPhase).toBe('phase-b');
  });

  it('aborts the replay when the entry hold vanished before the clear', async () => {
    const m = restartManager();
    await seedTask({ id: 'task-entry-clear', status: 'in_progress', signalToken: 'ec-T1' });
    await seedAgent({
      id: 'dev-1', taskId: 'task-entry-clear', paneId: '%0',
      status: 'awaiting_human',
      awaitingPhase: 'restart-redispatch-failed',
      awaitingReason: 'pre-restart hold',
      awaitingSince: NOW,
    });
    const continueSpy = vi.spyOn(m, 'continueSession').mockResolvedValue(true);
    const realGet = taskStore.get.bind(taskStore);
    let reads = 0;
    vi.spyOn(taskStore, 'get').mockImplementation(async (id) => {
      const value = await realGet(id);
      if (id === 'task-entry-clear') {
        reads += 1;
        if (reads === 2) await m.clearAwaitingHuman('dev-1');
      }
      return value;
    });

    await expect(m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-entry-clear')).resolves.toBe(false);
    expect(continueSpy).not.toHaveBeenCalled();
  });

  it('a successor hold landing after the currentness read still survives the clear', async () => {
    const m = manager;
    await seedTask({ id: 'task-hold-cas', status: 'in_progress', signalToken: 'hc-T1' });
    await seedAgent({
      id: 'dev-1', taskId: 'task-hold-cas', paneId: '%0',
      workdir: '/tmp/repo/.baxian-worktrees/wt',
    });
    const realGet = taskStore.get.bind(taskStore);
    let reads = 0;
    vi.spyOn(taskStore, 'get').mockImplementation(async (id) => {
      const value = await realGet(id);
      if (id === 'task-hold-cas') {
        reads += 1;
        if (reads === 2 && value) {
          await m.markAwaitingHuman(
            'dev-1',
            'code-dispatch-failed',
            'successor hold after currentness read',
            expect.objectContaining({ expectedTaskId: 'task-hold-cas' }),
          );
          await taskStore.set({ ...value, phase: 'code', signalToken: 'hc-T2' });
        }
      }
      return value;
    });

    await expect(m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-hold-cas')).resolves.toBe(false);
    const binding = await agentStore.get('dev-1');
    expect(binding?.status).toBe('awaiting_human');
    expect(binding?.awaitingPhase).toBe('code-dispatch-failed');
    expect(binding?.awaitingReason).toBe('successor hold after currentness read');
  });

  it('a stale replay never clears a hold written by the successor pass', async () => {
    const m = manager;
    await seedTask({ id: 'task-hold-race', status: 'in_progress', signalToken: 'hr-T1' });
    await seedAgent({
      id: 'dev-1', taskId: 'task-hold-race', paneId: '%0',
      workdir: '/tmp/repo/.baxian-worktrees/wt',
    });
    const clearSpy = vi.spyOn(m, 'clearAwaitingHuman');
    const realGet = taskStore.get.bind(taskStore);
    let hooked = false;
    vi.spyOn(taskStore, 'get').mockImplementation(async (id) => {
      const value = await realGet(id);
      if (id === 'task-hold-race' && !hooked && value) {
        hooked = true;
        await m.markAwaitingHuman(
          'dev-1',
          'code-dispatch-failed',
          'successor hold',
          expect.objectContaining({ expectedTaskId: 'task-hold-race' }),
        );
        await taskStore.set({ ...value, phase: 'code', signalToken: 'hr-T2' });
      }
      return value;
    });

    await expect(m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-hold-race')).resolves.toBe(false);
    expect(clearSpy).not.toHaveBeenCalled();
    const binding = await agentStore.get('dev-1');
    expect(binding?.status).toBe('awaiting_human');
    expect(binding?.awaitingPhase).toBe('code-dispatch-failed');
  });

  it('escalates an own-generation arm failure into the recoverable hold path', async () => {
    const m = manager;
    await seedTask({
      id: 'task-arm-fail',
      status: 'in_progress',
      signalToken: 'arm-fail-1',
    });
    await seedAgent({
      id: 'dev-1', taskId: 'task-arm-fail', paneId: '%0',
      workdir: '/tmp/repo/.baxian-worktrees/wt',
    });
    stubEnsureSession(m);
    vi.spyOn(
      m as unknown as { setupPhaseSignalWatcher: (...args: unknown[]) => Promise<boolean> },
      'setupPhaseSignalWatcher',
    ).mockResolvedValue(false);
    const injected: string[] = [];
    stubInject(m, async (_tmux, _paneId, prompt) => {
      injected.push(prompt);
      return { acked: true, composerDelivered: true };
    });

    await expect(m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-arm-fail'))
      .resolves.toBe(true);
    expect(injected).toEqual([]);
    const held = await agentStore.get('dev-1');
    expect(held?.status).toBe('awaiting_human');
    expect(held?.awaitingPhase).toBe('restart-redispatch-failed');
    expect(held?.awaitingReason).toMatch(/failed to arm/);
  });

  it('a post-clear replay throw is held on the live generation, not the stale entry hold', async () => {
    const m = manager;
    await seedTask({
      id: 'task-throw-held',
      status: 'in_progress',
      signalToken: 'throw-held-1',
    });
    await seedAgent({
      id: 'dev-1', taskId: 'task-throw-held', paneId: '%0',
      workdir: '/tmp/repo/.baxian-worktrees/wt',
      status: 'awaiting_human', awaitingPhase: 'restart-redispatch-failed', awaitingSince: NOW,
    });
    stubEnsureSession(m);
    vi.spyOn(
      m as unknown as { setupPhaseSignalWatcher: (...args: unknown[]) => Promise<boolean> },
      'setupPhaseSignalWatcher',
    ).mockResolvedValue(true);
    stubInject(m, async () => {
      throw new Error('enter scrub failed mid-delivery');
    });

    await expect(m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-throw-held'))
      .resolves.toBe(true);
    const held = await agentStore.get('dev-1');
    expect(held?.status).toBe('awaiting_human');
    expect(held?.awaitingPhase).toBe('restart-redispatch-failed');
    expect(held?.awaitingReason).toMatch(/enter scrub failed mid-delivery/);
    // The entry hold was cleared before the throw; the failure hold must be a fresh generation.
    expect(held?.awaitingSince).not.toBe(NOW);
  });

  it('a replay throw after a successor rotation exits without holding the successor', async () => {
    const m = manager;
    await seedTask({
      id: 'task-throw-rotated',
      status: 'in_progress',
      signalToken: 'throw-rot-1',
    });
    await seedAgent({
      id: 'dev-1', taskId: 'task-throw-rotated', paneId: '%0',
      workdir: '/tmp/repo/.baxian-worktrees/wt',
    });
    stubEnsureSession(m);
    vi.spyOn(
      m as unknown as { setupPhaseSignalWatcher: (...args: unknown[]) => Promise<boolean> },
      'setupPhaseSignalWatcher',
    ).mockResolvedValue(true);
    stubInject(m, async () => {
      const fresh = await taskStore.get('task-throw-rotated');
      await taskStore.set({ ...fresh!, signalToken: 'throw-rot-2' });
      throw new Error('paste transport died');
    });

    await expect(m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-throw-rotated'))
      .resolves.toBe(false);
    const after = await agentStore.get('dev-1');
    expect(after?.status).not.toBe('awaiting_human');
  });

  it('exits quietly when the arm failed because the pass already moved on', async () => {
    const m = manager;
    await seedTask({
      id: 'task-arm-fail-drift',
      status: 'in_progress',
      signalToken: 'arm-fail-2',
    });
    await seedAgent({
      id: 'dev-1', taskId: 'task-arm-fail-drift', paneId: '%0',
      workdir: '/tmp/repo/.baxian-worktrees/wt',
    });
    stubEnsureSession(m);
    vi.spyOn(
      m as unknown as { setupPhaseSignalWatcher: (...args: unknown[]) => Promise<boolean> },
      'setupPhaseSignalWatcher',
    ).mockImplementation(async () => {
      const fresh = await taskStore.get('task-arm-fail-drift');
      await taskStore.set({ ...fresh!, phase: 'code', signalToken: 'arm-fail-rotated' });
      return false;
    });
    const injected: string[] = [];
    stubInject(m, async (_tmux, _paneId, prompt) => {
      injected.push(prompt);
      return { acked: true, composerDelivered: true };
    });

    await expect(m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-arm-fail-drift'))
      .resolves.toBe(false);
    expect(injected).toEqual([]);
  });

  it('aborts the paste when the pass rotates while waiting for the pane mutex', async () => {
    const m = manager;
    await seedTask({
      id: 'task-mutex-drift',
      status: 'in_progress',
      signalToken: 'mutex-stale-1',
    });
    await seedAgent({
      id: 'dev-1', taskId: 'task-mutex-drift', paneId: '%0',
      workdir: '/tmp/repo/.baxian-worktrees/wt',
    });
    stubEnsureSession(m);
    vi.spyOn(
      m as unknown as { setupPhaseSignalWatcher: (...args: unknown[]) => Promise<boolean> },
      'setupPhaseSignalWatcher',
    ).mockResolvedValue(true);
    vi.spyOn(
      m as unknown as { acquireCompactGuard: (agentId: string) => Promise<void> },
      'acquireCompactGuard',
    ).mockImplementation(async () => {
      const fresh = await taskStore.get('task-mutex-drift');
      await taskStore.set({ ...fresh!, phase: 'code', signalToken: 'mutex-rotated-2' });
    });
    const stepsSpy = vi.spyOn(
      m as unknown as { injectAndAwaitAckSteps: (...args: unknown[]) => Promise<unknown> },
      'injectAndAwaitAckSteps',
    ).mockResolvedValue({ acked: true, composerDelivered: true });

    await expect(m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-mutex-drift'))
      .resolves.toBe(false);
    expect(stepsSpy).not.toHaveBeenCalled();
  });

  it('holds an in-flight holder whose signal token is missing', async () => {
    const m = restartManager();
    await seedTask({
      id: 'task-no-token',
      status: 'in_progress',
    });
    const { continueSpy, holdSpy } = spyDispatch(m);

    expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-no-token')).toBe(true);
    expect(continueSpy).not.toHaveBeenCalled();
    expect(holdSpy).toHaveBeenCalledWith(
      'dev-1',
      'restart-redispatch-failed',
      expect.any(String),
      expect.objectContaining({ expectedTaskId: 'task-no-token' }),
    );
  });

  it('leaves non-working statuses to the waiting transition', async () => {
    const m = restartManager();
    await seedTask({
      id: 'task-in-review',
      status: 'review',
      phase: 'code',
      qaAgentId: 'qa-1',
      signalToken: 'tok-b',
    });
    await seedTask({
      id: 'task-spec-ready',
      status: 'spec-ready',
      phase: 'spec',
      signalToken: 'tok-c',
    });
    const { continueSpy, holdSpy } = spyDispatch(m);

    expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-in-review')).toBe(false);
    expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 'task-spec-ready')).toBe(false);
    expect(continueSpy).not.toHaveBeenCalled();
    expect(holdSpy).not.toHaveBeenCalled();
  });
});

describe('AgentManager.parkTaskAtSpecReady / submitSpecVerdict', () => {
  const watcherStub = () => ({
    start: vi.fn(async () => true),
    stop: vi.fn(),
    stopAgentIfToken: vi.fn(),
    has: vi.fn(() => false),
  });
  function specManager(): AgentManager {
    return makeManager({
      config: CONFIG,
      skillRegistry: freshRegistry(),
      phaseSignalWatcher: watcherStub() as never,
    });
  }

  async function seedSpecTask(overrides: Partial<TaskState> = {}): Promise<TaskState> {
    return seedTask({
      id: 'task-spec-1',
      branch: 'bx/task-spec-1',
      preferredAgentId: 'dev-1',
      agentId: 'dev-1',
      devAgentId: 'dev-1',
      qaAgentId: 'qa-1',
      phase: 'spec',
      ...overrides,
    });
  }

  it('parks a review task at spec-ready, retains qaAgentId, marks Dev waiting, and releases QA', async () => {
    const m = specManager();
    await seedSpecTask({ status: 'review', specReviewRound: 1 });
    await seedAgent({ id: 'dev-1', taskId: 'task-spec-1' });
    await seedAgent({ id: 'qa-1', taskId: 'task-spec-1' });
    const releaseSpy = vi.spyOn(m, 'releaseAgentForTask').mockResolvedValue(true);
    const waitingSpy = vi.spyOn(m, 'markAgentWaiting').mockResolvedValue(true);

    const result = await m.parkTaskAtSpecReady('task-spec-1');
    expect(result?.status).toBe('spec-ready');
    expect(result?.phase).toBe('spec');
    expect(result?.qaAgentId).toBe('qa-1');
    expect((await taskStore.get('task-spec-1'))?.qaAgentId).toBe('qa-1');
    const parkedGeneration = {
      status: 'spec-ready',
      phase: 'spec',
      signalToken: undefined,
      agentId: 'dev-1',
      reviewRound: 0,
      specReviewRound: 1,
    };
    expect(waitingSpy).toHaveBeenCalledWith(
      'dev-1',
      'task-spec-1',
      { expectedTask: parkedGeneration },
    );
    expect(releaseSpy).toHaveBeenCalledWith(
      'qa-1',
      'task-spec-1',
      'idle',
      { expectedTask: parkedGeneration },
    );
  });

  it('parks from fixing with an explicit specReviewRound patch', async () => {
    const m = specManager();
    await seedSpecTask({ status: 'fixing', specReviewRound: 1 });
    await seedAgent({ id: 'dev-1', taskId: 'task-spec-1' });
    vi.spyOn(m, 'markAgentWaiting').mockResolvedValue(true);

    const result = await m.parkTaskAtSpecReady('task-spec-1', { specReviewRound: 2 });
    expect(result?.status).toBe('spec-ready');
    expect(result?.specReviewRound).toBe(2);
  });

  it('does not park or release participants for a stale captured generation', async () => {
    const m = specManager();
    const original = await seedSpecTask({
      status: 'review',
      specReviewRound: 1,
      signalToken: 'old-token',
    });
    await seedAgent({ id: 'dev-1', taskId: 'task-spec-1' });
    await seedAgent({ id: 'qa-1', taskId: 'task-spec-1' });
    const releaseSpy = vi.spyOn(m, 'releaseAgentForTask');
    const waitingSpy = vi.spyOn(m, 'markAgentWaiting');
    await seedSpecTask({
      status: 'review',
      specReviewRound: 2,
      signalToken: 'successor-token',
    });

    const result = await m.parkTaskAtSpecReady('task-spec-1', {
      expectedTask: {
        status: original.status,
        phase: original.phase,
        signalToken: original.signalToken,
        agentId: original.agentId,
        reviewRound: original.reviewRound,
        specReviewRound: original.specReviewRound,
      },
    });

    expect(result).toBeNull();
    expect(releaseSpy).not.toHaveBeenCalled();
    expect(waitingSpy).not.toHaveBeenCalled();
    expect(await taskStore.get('task-spec-1')).toMatchObject({
      status: 'review',
      specReviewRound: 2,
      signalToken: 'successor-token',
    });
  });

  it('does not park or release participants when the parked generation is superseded', async () => {
    const m = specManager();
    await seedSpecTask({
      status: 'review',
      specReviewRound: 1,
      signalToken: 'same-token',
    });
    await seedAgent({ id: 'dev-1', taskId: 'task-spec-1' });
    await seedAgent({ id: 'qa-1', taskId: 'task-spec-1' });
    const transitionTaskStatus = m.transitionTaskStatus.bind(m);
    vi.spyOn(m, 'transitionTaskStatus').mockImplementation(async (...args) => {
      const result = await transitionTaskStatus(...args);
      if (result) {
        await taskStore.set({
          ...result.task,
          specReviewRound: 2,
          updatedAt: new Date().toISOString(),
        });
      }
      return result;
    });

    const result = await m.parkTaskAtSpecReady('task-spec-1', {
      expectedTask: {
        status: 'review',
        phase: 'spec',
        signalToken: 'same-token',
        agentId: 'dev-1',
        reviewRound: 0,
        specReviewRound: 1,
      },
    });

    expect(result?.status).toBe('spec-ready');
    expect(await taskStore.get('task-spec-1')).toMatchObject({
      status: 'spec-ready',
      signalToken: 'same-token',
      specReviewRound: 2,
    });
    expect((await agentStore.get('dev-1'))?.status).not.toBe('waiting');
    expect((await agentStore.get('qa-1'))?.taskId).toBe('task-spec-1');
  });

});

describe('AgentManager.startSession status gate', () => {
  it('rejects terminal task even when bypassTaskStatusGate=true', async () => {
    await seedTask({ status: 'cancelled' });
    await seedAgent({ id: 'qa-1' });

    const result = await manager.startSession('task-1', 'qa-1', 'review', {
      bypassTaskStatusGate: true,
    });
    expect(result).toBe(false);
    expect((await taskStore.get('task-1'))?.status).toBe('cancelled');
  });
});

describe('AgentManager dispatch & skill provisioning', () => {
  function workdirRunner(): CommandRunner {
    return {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('git worktree add')) return { stdout: '', stderr: '', exitCode: 0 };
        if (cmd.includes('git rev-parse')) return { stdout: 'abc123\n', stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async () => undefined),
      execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
    };
  }

  type InjectAck = (tmux: TmuxManager, paneId: string, prompt: string, agentId: string, runtime: 'claude-code' | 'codex') => Promise<{ acked: boolean; composerDelivered: boolean }>;
  function spyInject(mgr: AgentManager, impl: InjectAck): void {
    vi.spyOn(mgr as unknown as { injectAndAwaitAck: InjectAck }, 'injectAndAwaitAck').mockImplementation(impl);
  }

  function capturePrompts(mgr: AgentManager, opts: { acked?: boolean; composerDelivered?: boolean } = {}): string[] {
    const prompts: string[] = [];
    const acked = opts.acked ?? true;
    const composerDelivered = opts.composerDelivered ?? true;
    spyInject(mgr, async (_tmux, _paneId, prompt) => {
      prompts.push(prompt);
      return { acked, composerDelivered };
    });
    return prompts;
  }

  function mockEnsureSession(over: { createdSession?: boolean; freshRuntime?: boolean; paneId?: string; workdir?: string } = {}): void {
    vi.spyOn(manager, 'ensureSession').mockImplementation(async (agentId) => ({
      ok: true,
      createdSession: false,
      freshRuntime: false,
      paneId: '%0',
      workdir: (await agentStore.get(agentId))?.workdir ?? '/tmp/repo',
      ...over,
    }));
    vi.spyOn(
      manager as unknown as { waitForReplPromptReady: (...args: unknown[]) => Promise<void> },
      'waitForReplPromptReady',
    ).mockResolvedValue(undefined);
    vi.spyOn(
      manager as unknown as { clearRuntimeForDispatchBoundary: (...args: unknown[]) => Promise<void> },
      'clearRuntimeForDispatchBoundary',
    ).mockResolvedValue(undefined);
  }

  function useWorkdirRunner(): void {
    (manager as unknown as { runnerFactory: () => CommandRunner }).runnerFactory = () => workdirRunner();
  }

  type ProvisionFn = (runner: CommandRunner, agent: AgentConfig, workdir: string) => Promise<void>;
  const provision = (mgr: AgentManager): ProvisionFn =>
    (mgr as unknown as { provisionRepoSkills: ProvisionFn }).provisionRepoSkills.bind(mgr);

  function agentConfig(over: Partial<AgentConfig> & { id: string }): AgentConfig {
    return { projectId: 'proj', runtime: 'claude-code', role: 'dev', mode: 'local', workdir: '/tmp/repo', ...over } as unknown as AgentConfig;
  }

  it('startSession develop prompt delegates completion kinds to skills', async () => {
    const t = await seedTask({ id: 'task-spec-route-1', branch: 'bx/task-spec-route-1', signalToken: 'devtok1234ab' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await acquireBoundLock('dev-1');

    mockEnsureSession({ freshRuntime: true });
    const prompts = capturePrompts(manager);
    useWorkdirRunner();

    const ok = await manager.startSession(t.id, 'dev-1', 'develop');
    expect(ok).toBe(true);
    expect(prompts[0]).toContain('token: devtok1234ab');
    expect(prompts[0]).not.toMatch(/^(?:spec-)?signal:/m);
  });

  it('startSession assertOwner gates on generation: a DELETE→recreate during ensureSession aborts before checkout', async () => {
    const t = await seedTask({ id: 'task-ss-aba', branch: 'bx/task-ss-aba', signalToken: 'ssaba1234ab' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await acquireBoundLock('dev-1');
    // ensureSession succeeds, but a DELETE→same-id recreate bumps the generation during it; the next
    // assertOwner (before waitForReplPromptReady / branch checkout) must fail closed on the stale generation.
    vi.spyOn(manager, 'ensureSession').mockImplementation(async (agentId) => {
      manager.bumpDeletionGeneration(agentId);
      return { ok: true, createdSession: false, freshRuntime: false, paneId: '%0', workdir: '/tmp/repo' };
    });
    const switchSpy = vi.spyOn(BranchManager.prototype, 'switchToTaskBranch');
    useWorkdirRunner();

    await expect(manager.startSession(t.id, 'dev-1', 'develop')).rejects.toThrow(/being deleted or was recreated/);
    expect(switchSpy).not.toHaveBeenCalled();
  });

  it('startSession develop prompt stays kind-free when the task snapshot has QA', async () => {
    const t = await seedTask({
      id: 'task-hasqa-1',
      branch: 'bx/task-hasqa-1',
      qaAgentId: 'qa-1',
      signalToken: 'devtok5678cd',
    });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await acquireBoundLock('dev-1');

    mockEnsureSession({ freshRuntime: true });
    const prompts = capturePrompts(manager);
    useWorkdirRunner();

    const ok = await manager.startSession(t.id, 'dev-1', 'develop');
    expect(ok).toBe(true);
    expect(prompts[0]).toContain('token: devtok5678cd');
    expect(prompts[0]).not.toMatch(/^(?:spec-)?signal:/m);
  });

  it('startSession marks bootstrappingTaskId during dispatch and clears it once the prompt is ack\'d', async () => {
    const t = await seedTask({ id: 'task-deliver-1', branch: 'bx/task-deliver-1' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await acquireBoundLock('dev-1');
    expect((await agentStore.get('dev-1'))?.bootstrappingTaskId).toBeUndefined();

    mockEnsureSession({ freshRuntime: true });
    let markerDuringInject: string | undefined;
    spyInject(manager, async () => {
      markerDuringInject = (await agentStore.get('dev-1'))?.bootstrappingTaskId;
      return { acked: true, composerDelivered: true };
    });
    let markerAtSessionStarted: string | undefined = 'unset';
    const realEmit = eventBus.emit.bind(eventBus);
    vi.spyOn(eventBus, 'emit').mockImplementation(async (ev) => {
      if (ev.type === 'session.started') markerAtSessionStarted = (await agentStore.get('dev-1'))?.bootstrappingTaskId;
      return realEmit(ev);
    });
    useWorkdirRunner();

    const ok = await manager.startSession(t.id, 'dev-1', 'develop');
    expect(ok).toBe(true);
    expect(markerDuringInject).toBe(t.id);
    expect(markerAtSessionStarted).toBeUndefined();
    expect((await agentStore.get('dev-1'))?.bootstrappingTaskId).toBeUndefined();
  });

  it('startSession holds (not destructively cleans up) when clearing the bootstrap marker fails after delivery', async () => {
    const t = await seedTask({ id: 'task-deliver-2', branch: 'bx/task-deliver-2' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await acquireBoundLock('dev-1');

    mockEnsureSession({ freshRuntime: true });
    useWorkdirRunner();

    let afterAck = false;
    let threwOnce = false;
    spyInject(manager, async () => { afterAck = true; return { acked: true, composerDelivered: true }; });
    const realUpdate = agentStore.update.bind(agentStore);
    vi.spyOn(agentStore, 'update').mockImplementation(async (id, updater) => {
      if (afterAck && !threwOnce) { threwOnce = true; throw new Error('marker-clear write blip'); }
      return realUpdate(id, updater);
    });
    const holdSpy = vi.spyOn(manager, 'markAwaitingHuman').mockResolvedValue(true);
    const parkSpy = vi.spyOn(BranchManager.prototype, 'parkOnDefaultDetached').mockResolvedValue(undefined);

    const ok = await manager.startSession(t.id, 'dev-1', 'develop');

    expect(ok).toBe(true);
    expect(parkSpy).not.toHaveBeenCalled();
    expect(holdSpy).toHaveBeenCalledWith(
      'dev-1', 'bootstrap-marker-clear-failed', expect.any(String), { expectedTaskId: t.id },
    );
  });

  it('startSession runs armBeforeInject before pasting the prompt', async () => {
    const t = await seedTask({ id: 'task-arm-before', branch: 'bx/task-arm-before' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await acquireBoundLock('dev-1');

    mockEnsureSession({ freshRuntime: true });
    const prompts = capturePrompts(manager);
    useWorkdirRunner();

    let promptsAtArm = -1;
    const ok = await manager.startSession(t.id, 'dev-1', 'develop', {
      armBeforeInject: async () => { promptsAtArm = prompts.length; return true; },
    });

    expect(ok).toBe(true);
    expect(promptsAtArm).toBe(0);
    expect(prompts.length).toBe(1);
  });

  it('startSession aborts without pasting when armBeforeInject returns false', async () => {
    const t = await seedTask({ id: 'task-arm-abort', branch: 'bx/task-arm-abort' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await acquireBoundLock('dev-1');

    mockEnsureSession({ freshRuntime: true });
    const prompts = capturePrompts(manager);
    useWorkdirRunner();

    const ok = await manager.startSession(t.id, 'dev-1', 'develop', {
      armBeforeInject: async () => false,
    });

    expect(ok).toBe(false);
    expect(prompts.length).toBe(0);
  });

  it('provisionRepoSkills materializes skills under .claude/skills for claude-code and .agents/skills for codex', async () => {
    function capturingRunner(): { exec: ReturnType<typeof vi.fn>; writeFile: ReturnType<typeof vi.fn>; execWithStdin: ReturnType<typeof vi.fn> } {
      return {
        exec: vi.fn(async (cmd: string): Promise<ExecResult> => ({
          stdout: cmd.includes('BX_SKILLS_NON_GIT') ? 'BX_SKILLS_OK\n' : '',
          stderr: '',
          exitCode: 0,
        })),
        writeFile: vi.fn(async (): Promise<void> => undefined),
        execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
      };
    }
    const stagedPaths = (r: ReturnType<typeof capturingRunner>): string[] =>
      r.execWithStdin.mock.calls
        .map(c => /cat > '([^']+)'/.exec(c[0] as string)?.[1])
        .filter((p): p is string => p !== undefined);
    const devAgent = agentConfig({ id: 'dev-1' });
    const devRunner = capturingRunner();
    await provision(manager)(devRunner as unknown as CommandRunner, devAgent, '/tmp/repo');
    const devStaged = stagedPaths(devRunner);
    expect(devStaged.some(p => /^\/tmp\/repo\/\.claude\/skills\/baxian-task-check\/SKILL\.md\.baxian-tmp-[0-9a-f]{12}$/.test(p))).toBe(true);
    expect(devStaged.every(p => /\.baxian-tmp-[0-9a-f]{12}$/.test(p))).toBe(true);
    expect(devStaged.every(p => !p.includes('/.agents/skills/'))).toBe(true);
    const devStageCmds = devRunner.execWithStdin.mock.calls.map(c => c[0] as string).filter(c => c.includes('cat > '));
    expect(devStageCmds.every(c => c.includes(`[ "$(cd -- '/tmp/repo' 2>/dev/null && pwd -P)" = '/tmp/repo' ]`))).toBe(true);
    const devMv = devRunner.exec.mock.calls.map(c => c[0] as string).filter(c => c.includes('mv -f'));
    expect(devMv.some(c => /\.claude\/skills\/baxian-task-check\/SKILL\.md\.baxian-tmp-[0-9a-f]{12}/.test(c))).toBe(true);
    expect(devMv.length).toBe(devStaged.length);
    const excludeCmd = devRunner.exec.mock.calls.map(c => c[0] as string).find(c => c.includes('info/exclude'));
    expect(excludeCmd).toBeDefined();
    expect(excludeCmd).toContain('.claude/skills/baxian-*');
    expect(excludeCmd).not.toContain("'.claude/skills/'");
    expect(excludeCmd).toContain('sh -c');
    expect(excludeCmd).toContain('show-prefix');
    const guardCmd = devRunner.exec.mock.calls.map(c => c[0] as string).find(c => c.includes('[ -L'));
    expect(guardCmd).toBeDefined();
    expect(guardCmd).toContain('sh -c');
    expect(guardCmd).toContain('find .claude/skills -maxdepth 1 -name');
    expect(guardCmd).toContain('baxian-*');
    expect(guardCmd).toContain('! -name');
    expect(guardCmd).toContain('readlink');
    expect(guardCmd).toContain('-type l -exec rm -f');
    expect(guardCmd).toContain('-type f ! -name');
    expect(guardCmd).toContain('SKILL.md');

    const qaAgent = agentConfig({ id: 'qa-1', runtime: 'codex', role: 'qa' });
    const qaRunner = capturingRunner();
    await provision(manager)(qaRunner as unknown as CommandRunner, qaAgent, '/tmp/repo');
    const qaStaged = stagedPaths(qaRunner);
    expect(qaStaged.some(p => p.startsWith('/tmp/repo/.agents/skills/baxian-pr-review/SKILL.md.baxian-tmp-'))).toBe(true);
    expect(qaStaged.every(p => !p.includes('/.claude/skills/'))).toBe(true);
  });

  it('provisionRepoSkills fails when info/exclude cannot protect injected skills', async () => {
    const runner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> =>
        cmd.includes('info/exclude')
          ? { stdout: '', stderr: 'fatal: not a git repository', exitCode: 1 }
          : { stdout: '', stderr: '', exitCode: 0 }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
      execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
    };
    const agent = agentConfig({ id: 'dev-1' });
    await expect(provision(manager)(runner as unknown as CommandRunner, agent, '/tmp/repo'))
      .rejects.toThrow(/skill exclusion probe failed/);
    expect(runner.writeFile).not.toHaveBeenCalled();
  });

  it('provisionRepoSkills re-materializes on every call — no skip cache (hot-reload of workdir/runtime + tamper safe)', async () => {
    const runner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => ({
        stdout: cmd.includes('BX_SKILLS_NON_GIT') ? 'BX_SKILLS_OK\n' : '',
        stderr: '',
        exitCode: 0,
      })),
      writeFile: vi.fn(async (): Promise<void> => undefined),
      execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
    };
    const agent = agentConfig({ id: 'dev-nocache', workdir: '/repo-a' });
    await provision(manager)(runner as unknown as CommandRunner, agent, '/repo-a');
    expect(runner.execWithStdin.mock.calls.length).toBeGreaterThan(0);
    runner.execWithStdin.mockClear();
    await provision(manager)(runner as unknown as CommandRunner, agent, '/repo-b');
    const written = runner.execWithStdin.mock.calls.map(c => c[0] as string);
    expect(written.some(p => p.includes('/repo-b/.claude/skills/baxian-task-check/SKILL.md'))).toBe(true);
  });

  it('provisionRepoSkills serializes concurrent same-dir provisioning (no overlapping cleanup)', async () => {
    let active = 0;
    let maxActive = 0;
    const runner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('[ -L')) {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise(r => setTimeout(r, 5));
          active -= 1;
        }
        return {
          stdout: cmd.includes('BX_SKILLS_NON_GIT') ? 'BX_SKILLS_OK\n' : '',
          stderr: '',
          exitCode: 0,
        };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
      execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
    };
    const agent = agentConfig({ id: 'dev-race', workdir: '/repo' });
    await Promise.all([
      provision(manager)(runner as unknown as CommandRunner, agent, '/repo'),
      provision(manager)(runner as unknown as CommandRunner, agent, '/repo'),
    ]);
    expect(maxActive).toBe(1);
  });

  it('provisionRepoSkills fails fast on a symlinked parent skills dir (no silent rm of user config)', async () => {
    const runner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> =>
        cmd.includes('BX_SKILLS_NON_GIT')
          ? { stdout: 'BX_SKILLS_OK\n', stderr: '', exitCode: 0 }
          : cmd.includes('[ -L')
          ? { stdout: '', stderr: 'baxian: .claude/skills is a symlink -> /shared/skills; replace it with a real directory', exitCode: 3 }
          : { stdout: '', stderr: '', exitCode: 0 }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
      execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
    };
    const agent = agentConfig({ id: 'dev-sym' });
    await expect(provision(manager)(runner as unknown as CommandRunner, agent, '/tmp/repo')).rejects.toThrow(/symlink-safe/);
    expect(runner.writeFile.mock.calls.length).toBe(0);
  });

  it('skill cleanup refuses a symlinked workdir root — external skills survive (real fs)', async () => {
    const { mkdtemp: mkTemp, rm: rmTemp, symlink: mkLink, readFile: readF } = await import('node:fs/promises');
    const { tmpdir: osTmp } = await import('node:os');
    const { LocalRunner } = await import('../../src/agent/runner.js');
    const base = await mkTemp(join(osTmp(), 'bx-skillroot-'));
    try {
      const outside = join(base, 'outside');
      const local = new LocalRunner();
      await local.exec(`mkdir -p '${join(outside, '.claude/skills/baxian-old')}'`);
      await local.exec(`printf victim > '${join(outside, '.claude/skills/baxian-old/SKILL.md')}'`);
      const workLink = join(base, 'work');
      await mkLink(outside, workLink);

      await expect(provision(manager)(local, agentConfig({ id: 'dev-rootlink' }), workLink))
        .rejects.toThrow(/skill exclusion probe failed|cannot make injected skills invisible|symlink-safe/);

      expect(await readF(join(outside, '.claude/skills/baxian-old/SKILL.md'), 'utf-8')).toBe('victim');
    } finally {
      await rmTemp(base, { recursive: true, force: true });
    }
  });

  it('skillDirLockKey canonicalizes host + workdir so equivalent agents serialize', async () => {
    const skillRegistry = new SkillRegistry(join(tempDir, 'skills'));
    await skillRegistry.scan();
    const cfg: BaxianConfig = { ...CONFIG, host: [{ id: 'box', hostname: 'h', user: 'u', port: 22 }] };
    const m = makeManager({ config: cfg, skillRegistry });
    const key = (a: object, w: string) =>
      (m as unknown as { skillDirLockKey: (a: AgentConfig, w: string) => string }).skillDirLockKey(a as AgentConfig, w);
    const byId = { runtime: 'claude-code', mode: 'remote', host: 'box' };
    const byInline = { runtime: 'claude-code', mode: 'remote', host: { hostname: 'h', user: 'u', port: 22 } };
    expect(key(byId, '/repo')).toBe(key(byInline, '/repo'));
    expect(key(byId, '/repo/')).toBe(key(byId, '/repo'));
    expect(key(byId, '/other')).not.toBe(key(byId, '/repo'));
    expect(key({ ...byId, runtime: 'codex' }, '/repo')).not.toBe(key(byId, '/repo'));
  });

  function managedCloneConfig(): BaxianConfig {
    return {
      review: { rounds: 2 },
      server: DEFAULT_SERVER_CONFIG,
      project: [{
        id: 'proj',
        repo: 'user/repo',
        merge: null,
        agent: [[
          { id: 'dev-1', runtime: 'claude-code', role: 'dev', mode: 'local' },
          { id: 'qa-1', runtime: 'codex', role: 'qa', mode: 'local' },
        ]],
      }],
    } as BaxianConfig;
  }

  async function makeManagedCloneManager(): Promise<AgentManager> {
    const skillRegistry = new SkillRegistry(join(tempDir, 'skills'));
    await skillRegistry.scan();
    return makeManager({ config: managedCloneConfig(), skillRegistry });
  }

  it('startSession develop surfaces an unresolvable origin/HEAD from fixed-Workdir branch switching', async () => {
    manager = await makeManagedCloneManager();
    const t = await seedTask({ id: 'task-nohead', branch: 'bx/task-nohead' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0', workdir: '/tmp/repo' });
    await acquireBoundLock('dev-1');

    mockEnsureSession({ freshRuntime: true });
    const switchSpy = vi.spyOn(BranchManager.prototype, 'switchToTaskBranch')
      .mockRejectedValue(new Error('Cannot resolve commit origin/HEAD'));

    await expect(manager.startSession(t.id, 'dev-1', 'develop')).rejects.toThrow(/origin\/HEAD/);
    expect(switchSpy).toHaveBeenCalledWith('/tmp/repo', t.id, t.branch, true, {});
    expect(await agentStore.get('dev-1')).toMatchObject({
      taskId: t.id,
      status: 'awaiting_human',
      awaitingPhase: 'checkout-preparation-failed',
    });
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  it('startSession holds the task and lock when the fixed Workdir is dirty', async () => {
    manager = await makeManagedCloneManager();
    const t = await seedTask({ id: 'task-dirty', branch: 'bx/task-dirty' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0', workdir: '/tmp/repo' });
    await acquireBoundLock('dev-1');

    mockEnsureSession({ freshRuntime: true });
    vi.spyOn(BranchManager.prototype, 'switchToTaskBranch')
      .mockRejectedValue(new DirtyWorkdirError('/tmp/repo'));

    await expect(manager.startSession(t.id, 'dev-1', 'develop')).rejects.toMatchObject({
      partial: expect.objectContaining({ handled: true }),
    });
    expect(await agentStore.get('dev-1')).toMatchObject({
      taskId: t.id,
      status: 'awaiting_human',
      awaitingPhase: 'dirty-workdir',
    });
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  it('startSession recheck 遇忙不落 hold：登记 qa-recheck pending 并抛 busyPending（#558 M2 B1）', async () => {
    manager = await makeManagedCloneManager();
    const t = await seedTask({
      id: 'task-busyq', branch: 'bx/task-busyq', status: 'review',
      platformBinding: GIT_BINDING, passToken: 'aaaaaaaaaaaa', failToken: 'bbbbbbbbbbbb', prNumber: 7, qaAgentId: 'qa-1', signalToken: 'tokA12345678',
    });
    await seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%0', workdir: '/tmp/repo-qa' });
    await acquireBoundLock('qa-1', t.id);

    mockEnsureSession();
    vi.spyOn(
      manager as unknown as { waitForReplPromptReady: (...args: unknown[]) => Promise<void> },
      'waitForReplPromptReady',
    ).mockRejectedValue(new ReplNotReadyError('%0', 'codex', '', 'stable idle not confirmed within 5000ms'));

    await expect(manager.startSession(t.id, 'qa-1', 'recheck', {
      dispatchPassToken: 'tokA12345678',
    })).rejects.toMatchObject({
      partial: expect.objectContaining({ handled: true, busyPending: true }),
    });
    const qa = await agentStore.get('qa-1');
    expect(qa?.status).toBeUndefined();
    expect(qa?.awaitingPhase).toBeUndefined();
    expect(qa?.taskId).toBe(t.id);
    expect(await lockManager.isLocked('qa-1')).toBe(true);
    expect(manager.getPendingDispatchRetry(t.id)).toMatchObject({
      kind: 'qa-recheck', agentId: 'qa-1', signalToken: 'tokA12345678',
      qaPhase: 'recheck',
    });
  });

  it('startSession 遇忙但 pass 已被接管（fence 令牌漂移）→ 不登记 pending，走原始失败路径', async () => {
    manager = await makeManagedCloneManager();
    const t = await seedTask({
      id: 'task-busysup', branch: 'bx/task-busysup', status: 'review',
      platformBinding: GIT_BINDING, passToken: 'aaaaaaaaaaaa', failToken: 'bbbbbbbbbbbb', prNumber: 9, qaAgentId: 'qa-1', signalToken: 'successor-tk',
    });
    await seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%0', workdir: '/tmp/repo-qa' });
    await acquireBoundLock('qa-1', t.id);

    mockEnsureSession();
    vi.spyOn(
      manager as unknown as { waitForReplPromptReady: (...args: unknown[]) => Promise<void> },
      'waitForReplPromptReady',
    ).mockRejectedValue(new ReplNotReadyError('%0', 'codex', '', 'stable idle not confirmed within 5000ms'));

    await expect(manager.startSession(t.id, 'qa-1', 'recheck', {
      dispatchPassToken: 'old-pass-tok1',
    })).rejects.toBeInstanceOf(ReplNotReadyError);
    expect(manager.getPendingDispatchRetry(t.id)).toBeUndefined();
  });

  it('startSession 遇忙且无 fence 令牌（或令牌核验读失败）→ fail closed 不登记', async () => {
    manager = await makeManagedCloneManager();
    const t = await seedTask({
      id: 'task-busynof', branch: 'bx/task-busynof', status: 'review',
      platformBinding: GIT_BINDING, passToken: 'aaaaaaaaaaaa', failToken: 'bbbbbbbbbbbb', prNumber: 10, qaAgentId: 'qa-1', signalToken: 'tokNF1234567',
    });
    await seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%0', workdir: '/tmp/repo-qa' });
    await acquireBoundLock('qa-1', t.id);

    mockEnsureSession();
    vi.spyOn(
      manager as unknown as { waitForReplPromptReady: (...args: unknown[]) => Promise<void> },
      'waitForReplPromptReady',
    ).mockRejectedValue(new ReplNotReadyError('%0', 'codex', '', 'stable idle not confirmed within 5000ms'));

    await expect(manager.startSession(t.id, 'qa-1', 'recheck')).rejects.toBeInstanceOf(ReplNotReadyError);
    expect(manager.getPendingDispatchRetry(t.id)).toBeUndefined();

    const queue = (manager as unknown as {
      queueQaBusyPendingRetry(
        taskId: string, agentId: string, phase: string, createdSession: boolean,
        err: unknown, dispatch: { passToken?: string; roundCounted?: boolean },
      ): Promise<unknown>;
    }).queueQaBusyPendingRetry.bind(manager);
    vi.spyOn(taskStore, 'get').mockRejectedValueOnce(new Error('store read failed'));
    await expect(queue(
      t.id, 'qa-1', 'recheck', false,
      new ReplNotReadyError('%0', 'codex', '', 'busy'),
      { passToken: 'tokNF1234567' },
    )).resolves.toBeNull();
    expect(manager.getPendingDispatchRetry(t.id)).toBeUndefined();
  });

  it('startSession recheck 边界段遇忙同样登记 pending 而非 hold', async () => {
    manager = await makeManagedCloneManager();
    const t = await seedTask({
      id: 'task-busyb', branch: 'bx/task-busyb', status: 'review',
      platformBinding: GIT_BINDING, passToken: 'aaaaaaaaaaaa', failToken: 'bbbbbbbbbbbb', prNumber: 8, qaAgentId: 'qa-1', signalToken: 'tokB12345678',
    });
    await seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%0', workdir: '/tmp/repo-qa' });
    await acquireBoundLock('qa-1', t.id);

    mockEnsureSession();
    vi.spyOn(
      manager as unknown as { switchToVerifiedReviewHead: (...args: unknown[]) => Promise<void> },
      'switchToVerifiedReviewHead',
    ).mockResolvedValue(undefined);
    vi.spyOn(
      manager as unknown as { clearRuntimeForDispatchBoundary: (...args: unknown[]) => Promise<void> },
      'clearRuntimeForDispatchBoundary',
    ).mockRejectedValue(new ReplNotReadyError('%0', 'codex', '', 'stable idle not confirmed within 5000ms'));

    await expect(manager.startSession(t.id, 'qa-1', 'recheck', {
      dispatchPassToken: 'tokB12345678',
    })).rejects.toMatchObject({
      partial: expect.objectContaining({ handled: true, busyPending: true }),
    });
    expect((await agentStore.get('qa-1'))?.status).toBeUndefined();
    expect(manager.getPendingDispatchRetry(t.id)).toMatchObject({ kind: 'qa-recheck', agentId: 'qa-1' });
  });

  it('startSession develop 边界段遇忙保持既有 hold 语义（非 QA 相位不登记 pending）', async () => {
    manager = await makeManagedCloneManager();
    const t = await seedTask({ id: 'task-busyd', branch: 'bx/task-busyd' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0', workdir: '/tmp/repo' });
    await acquireBoundLock('dev-1', t.id);

    mockEnsureSession();
    vi.spyOn(BranchManager.prototype, 'switchToTaskBranch').mockResolvedValue();
    vi.spyOn(
      manager as unknown as { clearRuntimeForDispatchBoundary: (...args: unknown[]) => Promise<void> },
      'clearRuntimeForDispatchBoundary',
    ).mockRejectedValue(new ReplNotReadyError('%0', 'claude-code', '', 'stable idle not confirmed within 5000ms'));

    await expect(manager.startSession(t.id, 'dev-1', 'develop')).rejects.toMatchObject({
      partial: expect.objectContaining({ handled: true }),
    });
    expect(await agentStore.get('dev-1')).toMatchObject({
      status: 'awaiting_human',
      awaitingPhase: 'checkout-preparation-failed',
    });
    expect(manager.getPendingDispatchRetry(t.id)).toBeUndefined();
  });

  it('注入阶段预注入忙碌检查命中：同样登记 pending 而非 cleanup/release（C3）', async () => {
    manager = await makeManagedCloneManager();
    const t = await seedTask({
      id: 'task-busyinj', branch: 'bx/task-busyinj', status: 'review',
      platformBinding: GIT_BINDING, passToken: 'aaaaaaaaaaaa', failToken: 'bbbbbbbbbbbb', prNumber: 12, qaAgentId: 'qa-1', signalToken: 'tokINJ123456',
    });
    await seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%0', workdir: '/tmp/repo-qa' });
    await acquireBoundLock('qa-1', t.id);

    mockEnsureSession();
    vi.spyOn(
      manager as unknown as { switchToVerifiedReviewHead: (...args: unknown[]) => Promise<void> },
      'switchToVerifiedReviewHead',
    ).mockResolvedValue(undefined);
    spyInject(manager, async () => {
      throw new ReplNotReadyError('%0', 'codex', '', 'pre-inject busy check: pane %0 is still running a turn; dispatch aborted');
    });
    const parkSpy = vi.spyOn(BranchManager.prototype, 'parkOnDefaultDetached').mockResolvedValue();

    await expect(manager.startSession(t.id, 'qa-1', 'recheck', {
      dispatchPassToken: 'tokINJ123456',
    })).rejects.toMatchObject({
      partial: expect.objectContaining({ handled: true, busyPending: true }),
    });
    expect(parkSpy).not.toHaveBeenCalled();
    const qa = await agentStore.get('qa-1');
    expect(qa?.taskId).toBe(t.id);
    expect(qa?.status).toBeUndefined();
    expect(manager.getPendingDispatchRetry(t.id)).toMatchObject({
      kind: 'qa-recheck', signalToken: 'tokINJ123456',
    });
  });

  it('pending 登记按代保留预算：同代刷新沿用 since/alerted，pass 换代即重置（R12）', async () => {
    manager = await makeManagedCloneManager();
    manager.registerPendingDispatchRetry('task-gen', { kind: 'qa-recheck', agentId: 'qa-1', signalToken: 'gen-a' });
    const first = manager.getPendingDispatchRetry('task-gen')!;
    manager.markPendingDispatchRetryBudgetAlerted('task-gen', { agentId: 'qa-1', signalToken: 'gen-a' });
    manager.markPendingDispatchRetryBudgetAlerted('task-gen', { agentId: 'qa-1', signalToken: 'gen-stale' });

    manager.registerPendingDispatchRetry('task-gen', { kind: 'qa-recheck', agentId: 'qa-1', signalToken: 'gen-a' });
    const sameGen = manager.getPendingDispatchRetry('task-gen')!;
    expect(sameGen.since).toBe(first.since);
    expect(sameGen.budgetAlerted).toBe(true);

    await new Promise(r => setTimeout(r, 2));
    manager.registerPendingDispatchRetry('task-gen', { kind: 'qa-recheck', agentId: 'qa-1', signalToken: 'gen-b' });
    const nextGen = manager.getPendingDispatchRetry('task-gen')!;
    expect(nextGen.since).toBeGreaterThan(first.since);
    expect(nextGen.budgetAlerted).toBeUndefined();
  });

  it('startSession 携带 pass guard 到 injectAndAwaitAck 的 paste fence（#563 R25）', async () => {
    manager = await makeManagedCloneManager();
    const t = await seedTask({
      id: 'task-fence2', branch: 'bx/task-fence2', status: 'review',
      platformBinding: GIT_BINDING, passToken: 'aaaaaaaaaaaa', failToken: 'bbbbbbbbbbbb', prNumber: 14, qaAgentId: 'qa-1', signalToken: 'tokF212345678'.slice(0, 12),
    });
    await seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%0', workdir: '/tmp/repo-qa' });
    await acquireBoundLock('qa-1', t.id);

    mockEnsureSession();
    vi.spyOn(
      manager as unknown as { switchToVerifiedReviewHead: (...args: unknown[]) => Promise<void> },
      'switchToVerifiedReviewHead',
    ).mockResolvedValue(undefined);
    let guardArg: unknown;
    vi.spyOn(
      manager as unknown as { injectAndAwaitAck: (...args: unknown[]) => Promise<unknown> },
      'injectAndAwaitAck',
    ).mockImplementation(async (...args: unknown[]) => {
      guardArg = args[5];
      return { acked: true, composerDelivered: true };
    });

    const started = await manager.startSession(t.id, 'qa-1', 'recheck', {
      dispatchPassToken: (await taskStore.get(t.id))!.signalToken,
    });

    expect(started).toBe(true);
    expect(typeof guardArg).toBe('function');
    await expect((guardArg as () => Promise<boolean>)()).resolves.toBe(true);
    const fresh = (await taskStore.get(t.id))!;
    await taskStore.set({ ...fresh, signalToken: 'rotated-mid99', updatedAt: new Date().toISOString() });
    await expect((guardArg as () => Promise<boolean>)()).resolves.toBe(false);
  });

  it('paste fence 的 guard 同时复核任务状态：cancelled（token 未变）判 false（#563 R31）', async () => {
    manager = await makeManagedCloneManager();
    const t = await seedTask({
      id: 'task-fence4', branch: 'bx/task-fence4', status: 'review',
      platformBinding: GIT_BINDING, passToken: 'aaaaaaaaaaaa', failToken: 'bbbbbbbbbbbb', prNumber: 16, qaAgentId: 'qa-1', signalToken: 'cancel-tok88',
    });
    await seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%0', workdir: '/tmp/repo-qa' });
    await acquireBoundLock('qa-1', t.id);

    mockEnsureSession();
    vi.spyOn(
      manager as unknown as { switchToVerifiedReviewHead: (...args: unknown[]) => Promise<void> },
      'switchToVerifiedReviewHead',
    ).mockResolvedValue(undefined);
    let guardArg: unknown;
    vi.spyOn(
      manager as unknown as { injectAndAwaitAck: (...args: unknown[]) => Promise<unknown> },
      'injectAndAwaitAck',
    ).mockImplementation(async (...args: unknown[]) => {
      guardArg = args[5];
      return { acked: true, composerDelivered: true };
    });

    const started = await manager.startSession(t.id, 'qa-1', 'recheck', {
      dispatchPassToken: 'cancel-tok88',
    });

    expect(started).toBe(true);
    await expect((guardArg as () => Promise<boolean>)()).resolves.toBe(true);
    const fresh = (await taskStore.get(t.id))!;
    await taskStore.set({ ...fresh, status: 'cancelled', updatedAt: new Date().toISOString() });
    await expect((guardArg as () => Promise<boolean>)()).resolves.toBe(false);
  });

  it('startSession 成功只按代清除本次派发的 pending：successor 登记不受影响', async () => {
    manager = await makeManagedCloneManager();
    const t = await seedTask({
      id: 'task-clearp', branch: 'bx/task-clearp', status: 'review',
      platformBinding: GIT_BINDING, passToken: 'aaaaaaaaaaaa', failToken: 'bbbbbbbbbbbb', prNumber: 11, qaAgentId: 'qa-1', signalToken: 'tokCL1234567',
    });
    await seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%0', workdir: '/tmp/repo-qa' });
    await acquireBoundLock('qa-1', t.id);
    manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: 'tokCL1234567' });

    mockEnsureSession();
    capturePrompts(manager);
    vi.spyOn(
      manager as unknown as { switchToVerifiedReviewHead: (...args: unknown[]) => Promise<void> },
      'switchToVerifiedReviewHead',
    ).mockResolvedValue(undefined);

    expect(await manager.startSession(t.id, 'qa-1', 'recheck', {
      dispatchPassToken: 'tokCL1234567',
    })).toBe(true);
    expect(manager.getPendingDispatchRetry(t.id)).toBeUndefined();

    manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: 'succ-tok1234' });
    expect(await manager.startSession(t.id, 'qa-1', 'recheck', {
      dispatchPassToken: 'tokCL1234567',
    })).toBe(true);
    expect(manager.getPendingDispatchRetry(t.id)).toMatchObject({ signalToken: 'succ-tok1234' });
  });

  it('startSession develop switches the fixed Workdir to the exact baxian task branch', async () => {
    manager = await makeManagedCloneManager();
    const t = await seedTask({ id: 'task-headok', branch: 'bx/task-headok' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0', workdir: '/tmp/repo' });
    await acquireBoundLock('dev-1');

    mockEnsureSession({ freshRuntime: true });
    capturePrompts(manager);
    const switchSpy = vi.spyOn(BranchManager.prototype, 'switchToTaskBranch').mockResolvedValue();

    const ok = await manager.startSession(t.id, 'dev-1', 'develop');
    expect(ok).toBe(true);
    expect(switchSpy).toHaveBeenCalledWith('/tmp/repo', t.id, t.branch, true, {});
  });

  it('startSession review checks out the remote PR branch detached in the QA Workdir', async () => {
    manager = await makeManagedCloneManager();
    const t = await seedTask({
      id: 'task-ghrev', branch: 'bx/task-ghrev', status: 'review',
      platformBinding: GIT_BINDING, passToken: 'aaaaaaaaaaaa', failToken: 'bbbbbbbbbbbb', prNumber: 7, signalToken: 'revtok1234ab',
      latestHeadSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    await seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%0', workdir: '/tmp/repo' });
    await acquireBoundLock('qa-1');

    mockEnsureSession({ freshRuntime: true });
    capturePrompts(manager);
    const switchSpy = vi.spyOn(BranchManager.prototype, 'switchToRemoteBranchDetached').mockResolvedValue();

    const ok = await manager.startSession(t.id, 'qa-1', 'review');
    expect(ok).toBe(true);
    expect(switchSpy).toHaveBeenCalledWith('/tmp/repo', t.branch, t.latestHeadSha);
  });

  it('resolves a moved review head through the driver, never the hardcoded gh path', async () => {
    manager = await makeManagedCloneManager();
    const OLD = 'a'.repeat(40);
    const NEW = 'c'.repeat(40);
    const t = await seedTask({
      id: 'task-moved', branch: 'bx/task-moved', status: 'review',
      platformBinding: GIT_BINDING, passToken: 'aaaaaaaaaaaa', failToken: 'bbbbbbbbbbbb',
      prNumber: 7, signalToken: 'movtok123456', latestHeadSha: OLD,
    });
    await seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%0', workdir: '/tmp/repo' });
    await acquireBoundLock('qa-1');
    mockEnsureSession({ freshRuntime: true });
    capturePrompts(manager);

    const driverSpy = vi.spyOn(manager, 'platformFetchPrView').mockResolvedValue({ headSha: NEW } as never);
    let call = 0;
    const switchSpy = vi.spyOn(BranchManager.prototype, 'switchToRemoteBranchDetached')
      .mockImplementation(async () => {
        if (call++ === 0) throw new ReviewHeadMismatchError('bx/task-moved', OLD, NEW);
      });

    const ok = await manager.startSession(t.id, 'qa-1', 'review');

    expect(ok).toBe(true);
    expect(driverSpy).toHaveBeenCalledWith('task-moved');
    expect(switchSpy).toHaveBeenLastCalledWith('/tmp/repo', 'bx/task-moved', NEW);
  });
});

describe('AgentManager runtime menu marker', () => {
  it('emits human.intervention once while a menu remains visible', async () => {
    let captures = 0;
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        const runtimeFact = claimedRuntimeFact(cmd, () => '%0');
        if (runtimeFact) return runtimeFact;
        if (cmd.includes('capture-pane')) {
          captures += 1;
          const frame = captures <= 2
            ? 'Enter to confirm · Esc to cancel'
            : '⏵⏵ bypass permissions on /tmp/repo\n\n>';
          return { stdout: `BX_PANE_OK\n${frame}`, stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
      execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
    };
    manager = makeManager({ skillRegistry: freshRegistry(), runnerFactory: () => runner });
    manager['runtimeMenuPollIntervalMs'] = 5;
    await seedTask();
    await seedAgent({
      id: 'dev-1',
      taskId: 'task-1',
      paneId: '%0',
    });

    manager.startRuntimeMenuWatch('dev-1');
    await waitUntil(() => events.some(e => e.type === 'human.intervention'));
    await new Promise(resolve => setTimeout(resolve, 30));

    const interventions = events.filter(e => e.type === 'human.intervention');
    expect(interventions).toHaveLength(1);
    expect(interventions[0].data.phase).toBe('agent_runtime_menu_pending');
    expect((await agentStore.get('dev-1'))?.taskId).toBe('task-1');
  });
});

describe('cancelTask interrupts (ESC) then releases dev and qa panes without clearing', () => {
  it('sends ESC to both dev and qa, never /clear, then clears both bindings', async () => {
    const sentKeys: string[] = [];
    const localManager = makeManager({
      skillRegistry: freshRegistry(),
      runnerFactory: () => clearAwareRunner(sentKeys, pane => (pane === '%1' ? CODEX_PANE : CLAUDE_PANE)),
    });
    setCompactTiming(localManager);

    const t = await seedTask({ qaAgentId: 'qa-1' });
    await seedAgent({
      id: 'dev-1',
      taskId: t.id,
      paneId: '%0',
    });
    await seedAgent({
      id: 'qa-1',
      taskId: t.id,
      paneId: '%1',
    });
    await acquireBoundLock('dev-1');
    await acquireBoundLock('qa-1');

    const cancelled = await localManager.cancelTask(t.id);

    expect(cancelled.status).toBe('cancelled');
    const escKeys = sentKeys.filter(k => k.includes("'Escape'"));
    expect(escKeys.length).toBeGreaterThanOrEqual(2);
    expect(sentKeys.some(k => k.includes('send-keys -l') && k.includes('/clear'))).toBe(false);
    expect(sentKeys.some(k => k.includes('%1') && k.includes('C-c'))).toBe(false);
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect((await agentStore.get('qa-1'))?.taskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(false);
    expect(await lockManager.isLocked('qa-1')).toBe(false);
  });

  it('skips interrupt/clear and release when agent has been rebound to a new task (race protection)', async () => {
    const sentKeys: string[] = [];
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('send-keys')) {
          sentKeys.push(cmd);
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('display-message') && cmd.includes('pane_current_command')) {
          return { stdout: 'claude\n', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('capture-pane')) {
          return { stdout: '⏵⏵ bypass permissions on /tmp/repo\n\n>', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
      execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
    };
    const localManager = makeManager({ skillRegistry: freshRegistry(), runnerFactory: () => runner });

    const oldTask = task({ id: 'task-old' });
    const newTask = task({ id: 'task-new' });
    await taskStore.set(oldTask);
    await taskStore.set(newTask);
    await seedAgent({
      id: 'dev-1',
      taskId: oldTask.id,
      paneId: '%0',
    });
    await acquireBoundLock('dev-1');

    const realAgentGet = agentStore.get.bind(agentStore);
    let devGets = 0;
    let switched = false;
    // 首次 get 落在 markPaneCancelClearing 的 update 临界区内，在那里写 store 会卡死 per-id 互斥
    vi.spyOn(agentStore, 'get').mockImplementation(async (id: string) => {
      if (id === 'dev-1' && !switched && ++devGets >= 2) {
        switched = true;
        const cur = await realAgentGet(id);
        if (cur) {
          await agentStore.set({ ...cur, taskId: newTask.id, updatedAt: new Date().toISOString() });
        }
        return realAgentGet(id);
      }
      return realAgentGet(id);
    });

    const cancelled = await localManager.cancelTask(oldTask.id);

    expect(cancelled.status).toBe('cancelled');
    expect(sentKeys.filter(k => k.includes("'Escape'"))).toHaveLength(0);
    expect(sentKeys.filter(k => k.includes('/clear'))).toHaveLength(0);
    expect((await agentStore.get('dev-1'))?.taskId).toBe(newTask.id);
  });

  it('preserves binding and emits intervention when interrupt fails (no /clear)', async () => {
    const sentKeys: string[] = [];
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('send-keys')) sentKeys.push(cmd);
        if (cmd.includes('display-message') && cmd.includes('pane_current_command')) {
          return { stdout: 'claude\n', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('capture-pane')) {
          return { stdout: 'Tool use: Bash\nstill streaming...\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
      execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
    };
    const localManager = makeManager({ skillRegistry: freshRegistry(), runnerFactory: () => runner });

    mockInterruptPane(localManager, false);

    const t = await seedTask();
    await seedAgent({
      id: 'dev-1',
      taskId: t.id,
      paneId: '%0',
    });
    await acquireBoundLock('dev-1');

    const cancelled = await localManager.cancelTask(t.id);

    expect(cancelled.status).toBe('cancelled');
    expect(sentKeys.filter(k => k.includes('/clear'))).toHaveLength(0);
    const stateAfter = await agentStore.get('dev-1');
    expect(stateAfter?.taskId).toBe(t.id);
    expect(stateAfter?.status).toBe('awaiting_human');
    expect(stateAfter?.awaitingPhase).toBe('cancel-interrupt-failed');
    expect(await lockManager.isLocked('dev-1')).toBe(true);
    const failedEvents = events.filter(
      e => e.type === 'human.intervention' && (e.data as { phase?: string }).phase === 'cancel-interrupt-failed',
    );
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]).toMatchObject({
      type: 'human.intervention',
      projectId: 'proj',
      agentId: 'dev-1',
      taskId: t.id,
    });
  });

  it('keeps the mutex-busy hold reason and emits a single intervention when the pane mutex stays busy', async () => {
    const localManager = makeManager({ skillRegistry: freshRegistry(), runnerFactory: () => readyRunner() });
    Object.assign(localManager, { cancelInterruptGuardWaitMs: 30, compactIdlePollMs: 5 });
    stubClaimedPaneResolution(() => '%0');
    (localManager as unknown as { compactInFlight: Set<string> }).compactInFlight.add('dev-1');

    const t = await seedTask();
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await acquireBoundLock('dev-1');

    const cancelled = await localManager.cancelTask(t.id);

    expect(cancelled.status).toBe('cancelled');
    const dev = await agentStore.get('dev-1');
    expect(dev?.taskId).toBe(t.id);
    expect(dev?.awaitingPhase).toBe('cancel-interrupt-failed');
    expect(dev?.awaitingReason).toContain('pane mutex');
    expect(await lockManager.isLocked('dev-1')).toBe(true);
    const holdEvents = events.filter(
      e => e.type === 'human.intervention' && (e.data as { phase?: string }).phase === 'cancel-interrupt-failed',
    );
    expect(holdEvents).toHaveLength(1);
  });

  it('releases neither agent until both panes are interrupted, so a slow qa interrupt cannot expose a freed dev', async () => {
    const localManager = makeManager({ skillRegistry: freshRegistry(), runnerFactory: () => readyRunner() });

    const t = await seedTask({ qaAgentId: 'qa-1' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1' });
    await acquireBoundLock('dev-1');
    await acquireBoundLock('qa-1');

    let devStillHeldDuringQaInterrupt: boolean | undefined;
    vi.spyOn(localManager as unknown as { interruptPaneAndWaitReady: (state: { id: string }) => Promise<boolean> }, 'interruptPaneAndWaitReady')
      .mockImplementation(async (state) => {
        if (state.id === 'qa-1') {
          devStillHeldDuringQaInterrupt =
            (await agentStore.get('dev-1'))?.taskId === t.id && (await lockManager.isLocked('dev-1'));
        }
        return true;
      });

    await localManager.cancelTask(t.id);

    expect(devStillHeldDuringQaInterrupt).toBe(true);
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect((await agentStore.get('qa-1'))?.taskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(false);
    expect(await lockManager.isLocked('qa-1')).toBe(false);
  });

  it('refuses Resume while cancel cleanup is in flight, and the worker still completes both releases', async () => {
    const localManager = makeManager({ skillRegistry: freshRegistry(), runnerFactory: () => readyRunner() });

    const t = await seedTask({ qaAgentId: 'qa-1' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1' });
    await acquireBoundLock('dev-1');
    await acquireBoundLock('qa-1');

    let resumeDuringCancel: { resumed: boolean; reason?: string } | undefined;
    vi.spyOn(localManager as unknown as { interruptPaneAndWaitReady: (state: { id: string }) => Promise<boolean> }, 'interruptPaneAndWaitReady')
      .mockImplementation(async (state) => {
        if (state.id === 'qa-1') {
          resumeDuringCancel = await localManager.resumeAgent('dev-1');
        }
        return true;
      });

    await localManager.cancelTask(t.id);

    expect(resumeDuringCancel?.resumed).toBe(false);
    expect(resumeDuringCancel?.reason).toContain('in progress');
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect((await agentStore.get('qa-1'))?.taskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(false);
    expect(await lockManager.isLocked('qa-1')).toBe(false);
  });

  it('a duplicate cancel of an already-cancelling task does not clear the in-flight guard early', async () => {
    const localManager = makeManager({ skillRegistry: freshRegistry(), runnerFactory: () => readyRunner() });

    const t = await seedTask({ qaAgentId: 'qa-1' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1' });
    await acquireBoundLock('dev-1');
    await acquireBoundLock('qa-1');

    let resumeAfterDuplicateCancel: { resumed: boolean; reason?: string } | undefined;
    vi.spyOn(localManager as unknown as { interruptPaneAndWaitReady: (state: { id: string }) => Promise<boolean> }, 'interruptPaneAndWaitReady')
      .mockImplementation(async (state) => {
        if (state.id === 'qa-1') {
          await localManager.cancelTask(t.id);
          resumeAfterDuplicateCancel = await localManager.resumeAgent('dev-1');
        }
        return true;
      });

    await localManager.cancelTask(t.id);

    expect(resumeAfterDuplicateCancel?.resumed).toBe(false);
    expect(resumeAfterDuplicateCancel?.reason).toContain('in progress');
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect((await agentStore.get('qa-1'))?.taskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(false);
    expect(await lockManager.isLocked('qa-1')).toBe(false);
  });

  it('a dev whose interrupt fails does not strand qa — qa is still interrupted and released', async () => {
    const localManager = makeManager({ skillRegistry: freshRegistry(), runnerFactory: () => readyRunner() });

    const t = await seedTask({ qaAgentId: 'qa-1' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1' });
    await acquireBoundLock('dev-1');
    await acquireBoundLock('qa-1');

    vi.spyOn(localManager as unknown as { interruptPaneAndWaitReady: (state: { id: string }) => Promise<boolean> }, 'interruptPaneAndWaitReady')
      .mockImplementation(async (state) => state.id !== 'dev-1');

    await localManager.cancelTask(t.id);

    const dev = await agentStore.get('dev-1');
    expect(dev?.status).toBe('awaiting_human');
    expect(dev?.awaitingPhase).toBe('cancel-interrupt-failed');
    expect(dev?.taskId).toBe(t.id);
    const qa = await agentStore.get('qa-1');
    expect(qa?.taskId).toBeUndefined();
    expect(await lockManager.isLocked('qa-1')).toBe(false);
  });

  it('does not stale-mark a rebound agent when it is reassigned mid-cleanup (release+reassign race)', async () => {
    const localManager = makeManager({ skillRegistry: freshRegistry(), runnerFactory: () => readyRunner() });

    const t = await seedTask();
    await taskStore.set(task({ id: 'task-new' }));
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await acquireBoundLock('dev-1');

    vi.spyOn(localManager as unknown as { interruptPaneAndWaitReady: () => Promise<boolean> }, 'interruptPaneAndWaitReady')
      .mockImplementation(async () => {
        await agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: 'task-new', paneId: '%0', updatedAt: new Date().toISOString() });
        return true;
      });

    await localManager.cancelTask(t.id);

    const dev = await agentStore.get('dev-1');
    expect(dev?.taskId).toBe('task-new');
    expect(dev?.status).not.toBe('awaiting_human');
    expect(dev?.awaitingPhase).toBeUndefined();
  });

  it('refuses release of a cancel-clearing pane unless it is cancel\'s own (fromCancelCleanup)', async () => {
    const t = await seedTask({ status: 'cancelled' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-clearing' });
    await acquireBoundLock('dev-1');

    expect(await manager.releaseAgentForTask('dev-1', t.id, 'idle')).toBe(false);
    expect(await manager.releaseAgentForTask('dev-1', t.id, 'idle', { allowAwaitingHuman: true })).toBe(false);
    expect((await agentStore.get('dev-1'))?.taskId).toBe(t.id);
    expect(await lockManager.isLocked('dev-1')).toBe(true);

    expect(await manager.releaseAgentForTask('dev-1', t.id, 'idle', { allowAwaitingHuman: true, fromCancelCleanup: true })).toBe(true);
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
  });

  it('blocks a concurrent terminal-task escape release while cancel is mid-cleanup', async () => {
    const localManager = makeManager({ skillRegistry: freshRegistry(), runnerFactory: () => readyRunner() });
    const t = await seedTask({ qaAgentId: 'qa-1' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1' });
    await acquireBoundLock('dev-1');
    await acquireBoundLock('qa-1');

    let escapeReleaseResult: boolean | undefined;
    vi.spyOn(localManager as unknown as { interruptPaneAndWaitReady: () => Promise<boolean> }, 'interruptPaneAndWaitReady')
      .mockImplementation(async () => {
        if (escapeReleaseResult === undefined) {
          escapeReleaseResult = await localManager.releaseAgentForTask('qa-1', t.id, 'idle');
        }
        return true;
      });

    const cancelled = await localManager.cancelTask(t.id);

    expect(cancelled.status).toBe('cancelled');
    expect(escapeReleaseResult).toBe(false);
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect((await agentStore.get('qa-1'))?.taskId).toBeUndefined();
  });

  it('cancel of one task does not block a rebound agent release by its new task', async () => {
    const localManager = makeManager({ skillRegistry: freshRegistry(), runnerFactory: () => readyRunner() });
    await taskStore.set(task({ id: 'task-old', agentId: 'dev-1', qaAgentId: 'qa-1' }));
    await taskStore.set(task({ id: 'task-new', agentId: 'dev-1' }));
    await seedAgent({ id: 'dev-1', taskId: 'task-new', paneId: '%0' });
    await seedAgent({ id: 'qa-1', taskId: 'task-old', paneId: '%1' });
    await acquireBoundLock('dev-1');
    await acquireBoundLock('qa-1');

    let devReleaseByNewTask: boolean | undefined;
    vi.spyOn(localManager as unknown as { interruptPaneAndWaitReady: () => Promise<boolean> }, 'interruptPaneAndWaitReady')
      .mockImplementation(async () => {
        if (devReleaseByNewTask === undefined) {
          devReleaseByNewTask = await localManager.releaseAgentForTask('dev-1', 'task-new', 'idle');
        }
        return true;
      });

    await localManager.cancelTask('task-old');

    expect(devReleaseByNewTask).toBe(true);
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect((await agentStore.get('qa-1'))?.taskId).toBeUndefined();
  });

  it('a stale cancel does not disturb the cancel-clearing hold of the agent\'s real owner', async () => {
    await taskStore.set(task({ id: 'task-a', agentId: 'dev-1' }));
    await taskStore.set(task({ id: 'task-b', agentId: 'dev-1' }));
    await seedAgent({ id: 'dev-1', taskId: 'task-a', paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-clearing' });

    await manager.cancelTask('task-b');

    const dev = await agentStore.get('dev-1');
    expect(dev?.taskId).toBe('task-a');
    expect(dev?.awaitingPhase).toBe('cancel-clearing');
    expect(await manager.releaseAgentForTask('dev-1', 'task-a', 'idle')).toBe(false);
    expect((await agentStore.get('dev-1'))?.taskId).toBe('task-a');
  });

  it('Resume releases a stale cancel-clearing hold whose task already reached a terminal status', async () => {
    const t = await seedTask({ status: 'cancelled' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-clearing' });
    await acquireBoundLock('dev-1');

    const res = await manager.resumeAgent('dev-1');
    expect(res.resumed).toBe(true);
    expect(res.releasedBinding).toBe(true);
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(false);
  });

  it('recover() holds a cancel-clearing agent bound to a cancelled task (restart mid-cleanup)', async () => {
    await taskStore.set(task({ id: 'task-x', status: 'cancelled', agentId: 'dev-1' }));
    await seedAgent({ id: 'dev-1', taskId: 'task-x', paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-clearing' });
    await acquireBoundLock('dev-1');
    vi.spyOn(manager as unknown as { ensureSession: () => Promise<{ paneId: string }> }, 'ensureSession')
      .mockResolvedValue({ paneId: '%0' });

    await manager.recover();

    const dev = await agentStore.get('dev-1');
    expect(dev?.taskId).toBe('task-x');
    expect(dev?.status).toBe('awaiting_human');
    expect(dev?.awaitingPhase).toBe('cancel-clearing');
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  it('does not auto-release a cancel-interrupt-failed pane (escape/handler), but Resume can', async () => {
    const t = await seedTask({ status: 'cancelled' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed' });
    await acquireBoundLock('dev-1');

    expect(await manager.releaseAgentForTask('dev-1', t.id, 'idle', { allowAwaitingHuman: true })).toBe(false);
    expect((await agentStore.get('dev-1'))?.taskId).toBe(t.id);
    expect(await lockManager.isLocked('dev-1')).toBe(true);

    const res = await manager.resumeAgent('dev-1');
    expect(res.resumed).toBe(true);
    expect(res.releasedBinding).toBe(true);
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
  });

  it('recover() holds a cancel-interrupt-failed agent (restart) instead of auto-releasing it', async () => {
    await taskStore.set(task({ id: 'task-y', status: 'cancelled', agentId: 'dev-1' }));
    await seedAgent({ id: 'dev-1', taskId: 'task-y', paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed' });
    await acquireBoundLock('dev-1');
    vi.spyOn(manager as unknown as { ensureSession: () => Promise<{ paneId: string }> }, 'ensureSession')
      .mockResolvedValue({ paneId: '%0' });

    await manager.recover();

    const dev = await agentStore.get('dev-1');
    expect(dev?.taskId).toBe('task-y');
    expect(dev?.awaitingPhase).toBe('cancel-interrupt-failed');
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });
});

describe('interruptPaneAndWaitReady composer recovery', () => {
  function callInterrupt(
    mgr: AgentManager,
    state: AgentBindingFacts,
    cfg: AgentConfig & { projectId: string },
  ): Promise<boolean> {
    return (mgr as unknown as {
      interruptPaneAndWaitReady: (s: AgentBindingFacts, c: AgentConfig & { projectId: string }) => Promise<boolean>;
    }).interruptPaneAndWaitReady(state, cfg);
  }
  function cfgOf(mgr: AgentManager, id: string): AgentConfig & { projectId: string } {
    return (mgr as unknown as {
      getAgentConfig: (id: string) => AgentConfig & { projectId: string };
    }).getAgentConfig(id);
  }
  const INTERRUPT_PANES: Record<string, string> = { 'qa-1': '%7', 'dev-1': '%3' };
  function stubInterruptPanes(): void {
    stubClaimedPaneResolution(id => INTERRUPT_PANES[id] ?? '%0');
  }
  function spyKeys(proc = 'node'): string[] {
    stubInterruptPanes();
    const keys: string[] = [];
    vi.spyOn(TmuxManager.prototype, 'sendKeysToPane').mockImplementation(async (_p, k) => { keys.push(k); });
    vi.spyOn(TmuxManager.prototype, 'displayMessage').mockResolvedValue(proc);
    return keys;
  }
  function spyClearFlow(dirty: string, afterCtrlC: string, opts: { proc?: string; cleanAfterCtrlC?: boolean } = {}): string[] {
    stubInterruptPanes();
    const proc = opts.proc ?? 'node';
    const cleanAfterCtrlC = opts.cleanAfterCtrlC ?? true;
    const keys: string[] = [];
    let cleared = false;
    vi.spyOn(TmuxManager.prototype, 'sendKeysToPane').mockImplementation(async (_p, k) => {
      keys.push(k);
      if (k === 'C-c') cleared = true;
    });
    vi.spyOn(TmuxManager.prototype, 'displayMessage').mockResolvedValue(proc);
    vi.spyOn(TmuxManager.prototype, 'waitReplReady').mockImplementation(async () => {
      if (cleared && cleanAfterCtrlC) return;
      throw new Error('repl not ready');
    });
    vi.spyOn(TmuxManager.prototype, 'capturePaneById').mockImplementation(async () => (cleared ? afterCtrlC : dirty));
    return keys;
  }

  const STUCK_COMPOSER =
    '› Title: 优化 Agent Pet 样式\n  1. Agent Pet 再放大一点点\n  2. ...\n  gpt-5.5 xhigh · ~/.baxian/repos/example-owner/example-repo\n';
  const BUSY_LOOKING_COMPOSER =
    '› 排查 codex 卡死，日志：\n  • Working (12s)\n  esc to interrupt\n  gpt-5.5 xhigh · ~/.baxian/repos/example-owner/example-repo\n';
  const LONG_COMPOSER_NO_GLYPH =
    'pasted diagnostics line\n'.repeat(14) + '  gpt-5.5 xhigh · ~/.baxian/repos/example-owner/example-repo\n';
  const CLEARED_BARE_PROMPT = '› \n  gpt-5.5 xhigh · ~/.baxian/repos/example-owner/example-repo\n';
  const NODE_HUMAN_SESSION = 'running diagnostics…\n> \n';
  const CLAUDE_DIRTY = '❯ 修复 web terminal 乱码\n';
  const CLAUDE_CLEARED = '❯ \n';
  const RUNNING_TURN_A = '• Working (12s)\n  esc to interrupt\n';
  const RUNNING_TURN_B = '• Working (13s)\n  esc to interrupt\n';
  const CLAUDE_RUN_A = '✶ Grooving… (12s)\n' + 'tool output\n'.repeat(12) + '❯ \n';
  const CLAUDE_RUN_B = '✶ Grooving… (13s)\n' + 'tool output\n'.repeat(12) + '❯ \n';
  const RUNTIME_MENU = 'Select a model\n  Enter to confirm · Esc to cancel\n';
  const GROWING_OUTPUT_A = 'building project…\n  compiled module 1\n';
  const GROWING_OUTPUT_B = 'building project…\n  compiled module 2\n';
  const BLOCKER_OVER_PROMPT = 'Allow command `rm -rf`?\n  Press Enter to confirm or Esc to cancel\n› \n';

  it('C-c clears an un-submitted composer and verifies it reached a clean composer (qa-1: codex)', async () => {
    Object.assign(manager, { runtimeLivenessProbeMs: 1, cleanComposerWaitMs: 20 });
    const keys = spyClearFlow(STUCK_COMPOSER, CLEARED_BARE_PROMPT);

    await seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(manager, (await agentStore.get('qa-1'))!, cfgOf(manager, 'qa-1'));

    expect(ok).toBe(true);
    expect(keys).toEqual(['Escape', 'C-c']);
  });

  it('C-c clears a dirty composer whose text contains "Working"/"esc to interrupt" (Issue A)', async () => {
    Object.assign(manager, { runtimeLivenessProbeMs: 1, cleanComposerWaitMs: 20 });
    const keys = spyClearFlow(BUSY_LOOKING_COMPOSER, CLEARED_BARE_PROMPT);

    await seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(manager, (await agentStore.get('qa-1'))!, cfgOf(manager, 'qa-1'));

    expect(ok).toBe(true);
    expect(keys).toEqual(['Escape', 'C-c']);
  });

  it('C-c clears a LONG composer whose `›` scrolled off — verified by the OUTCOME, not a visible glyph', async () => {
    Object.assign(manager, { runtimeLivenessProbeMs: 1, cleanComposerWaitMs: 20 });
    const keys = spyClearFlow(LONG_COMPOSER_NO_GLYPH, CLEARED_BARE_PROMPT);

    await seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(manager, (await agentStore.get('qa-1'))!, cfgOf(manager, 'qa-1'));

    expect(ok).toBe(true);
    expect(keys).toEqual(['Escape', 'C-c']);
  });

  it('C-c clears a Claude dirty composer and verifies the empty ❯ prompt (dev-1: claude-code)', async () => {
    Object.assign(manager, { runtimeLivenessProbeMs: 1, cleanComposerWaitMs: 20 });
    const keys = spyClearFlow(CLAUDE_DIRTY, CLAUDE_CLEARED, { proc: 'claude' });

    await seedAgent({ id: 'dev-1', paneId: '%3' });
    const ok = await callInterrupt(manager, (await agentStore.get('dev-1'))!, cfgOf(manager, 'dev-1'));

    expect(ok).toBe(true);
    expect(keys).toEqual(['Escape', 'C-c']);
  });

  it('holds (no C-c) when a turn is genuinely still running after ESC (screen changes between grabs)', async () => {
    Object.assign(manager, { runtimeLivenessProbeMs: 1 });
    const keys = spyKeys();
    vi.spyOn(TmuxManager.prototype, 'waitReplReady').mockRejectedValue(new Error('repl not ready'));
    vi.spyOn(TmuxManager.prototype, 'capturePaneById')
      .mockResolvedValueOnce(RUNNING_TURN_A)
      .mockResolvedValueOnce(RUNNING_TURN_B);

    await seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(manager, (await agentStore.get('qa-1'))!, cfgOf(manager, 'qa-1'));

    expect(ok).toBe(false);
    expect(keys).toEqual(['Escape']);
  });

  it('holds (no C-c) on a real running Claude turn whose high spinner advances between grabs (dev-1)', async () => {
    Object.assign(manager, { runtimeLivenessProbeMs: 1 });
    const keys = spyKeys('claude');
    vi.spyOn(TmuxManager.prototype, 'waitReplReady').mockRejectedValue(new Error('repl not ready'));
    vi.spyOn(TmuxManager.prototype, 'capturePaneById')
      .mockResolvedValueOnce(CLAUDE_RUN_A)
      .mockResolvedValueOnce(CLAUDE_RUN_B);

    await seedAgent({ id: 'dev-1', paneId: '%3' });
    const ok = await callInterrupt(manager, (await agentStore.get('dev-1'))!, cfgOf(manager, 'dev-1'));

    expect(ok).toBe(false);
    expect(keys).toEqual(['Escape']);
  });

  it('holds (no C-c) when the pane is no longer running the runtime (crashed to shell)', async () => {
    const keys = spyKeys('zsh');
    vi.spyOn(TmuxManager.prototype, 'waitReplReady').mockRejectedValue(new Error('repl not ready'));
    const captureSpy = vi.spyOn(TmuxManager.prototype, 'capturePaneById');

    await seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(manager, (await agentStore.get('qa-1'))!, cfgOf(manager, 'qa-1'));

    expect(ok).toBe(false);
    expect(keys).toEqual(['Escape']);
    expect(captureSpy).not.toHaveBeenCalled();
  });

  it('re-checks proc title right before C-c: holds (no C-c) if the runtime crashed to a shell during the liveness window', async () => {
    Object.assign(manager, { runtimeLivenessProbeMs: 1, cleanComposerWaitMs: 20 });
    stubInterruptPanes();
    const keys: string[] = [];
    vi.spyOn(TmuxManager.prototype, 'sendKeysToPane').mockImplementation(async (_p, k) => { keys.push(k); });
    vi.spyOn(TmuxManager.prototype, 'displayMessage')
      .mockResolvedValueOnce('node')
      .mockResolvedValue('zsh');
    vi.spyOn(TmuxManager.prototype, 'waitReplReady').mockRejectedValue(new Error('repl not ready'));
    const captureSpy = vi.spyOn(TmuxManager.prototype, 'capturePaneById')
      .mockResolvedValue('idle diagnostics output\n  gpt-5.5 xhigh · ~/repo\n');

    await seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(manager, (await agentStore.get('qa-1'))!, cfgOf(manager, 'qa-1'));

    expect(ok).toBe(false);
    expect(keys).toEqual(['Escape']);
    expect(captureSpy).toHaveBeenCalled();
  });

  it('holds (no C-c) when the screen is static but the OSC braille title ADVANCES across samples (live turn)', async () => {
    Object.assign(manager, { runtimeLivenessProbeMs: 1 });
    stubInterruptPanes();
    const keys: string[] = [];
    vi.spyOn(TmuxManager.prototype, 'sendKeysToPane').mockImplementation(async (_p, k) => { keys.push(k); });
    vi.spyOn(TmuxManager.prototype, 'displayMessage').mockResolvedValue('node');
    vi.spyOn(TmuxManager.prototype, 'readPaneTitle')
      .mockResolvedValueOnce('⠋ Working')
      .mockResolvedValue('⠙ Working');
    vi.spyOn(TmuxManager.prototype, 'waitReplReady').mockRejectedValue(new Error('repl not ready'));
    vi.spyOn(TmuxManager.prototype, 'capturePaneById').mockResolvedValue('quiet build output\n  no spinner here\n');

    await seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(manager, (await agentStore.get('qa-1'))!, cfgOf(manager, 'qa-1'));

    expect(ok).toBe(false);
    expect(keys).toEqual(['Escape']);
  });

  it('does NOT treat a STALE static working-shaped OSC title as live — C-c proceeds (else cancel-interrupt-failed)', async () => {
    Object.assign(manager, { runtimeLivenessProbeMs: 1, cleanComposerWaitMs: 20 });
    const keys = spyClearFlow(STUCK_COMPOSER, CLEARED_BARE_PROMPT);
    vi.spyOn(TmuxManager.prototype, 'readPaneTitle').mockResolvedValue('⠹ Working');

    await seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(manager, (await agentStore.get('qa-1'))!, cfgOf(manager, 'qa-1'));

    expect(ok).toBe(true);
    expect(keys).toEqual(['Escape', 'C-c']);
  });

  it('an ADVANCING OSC title is live even when the screen momentarily shows a ready-looking prompt', async () => {
    Object.assign(manager, { runtimeLivenessProbeMs: 1 });
    stubInterruptPanes();
    const keys: string[] = [];
    vi.spyOn(TmuxManager.prototype, 'sendKeysToPane').mockImplementation(async (_p, k) => { keys.push(k); });
    vi.spyOn(TmuxManager.prototype, 'displayMessage').mockResolvedValue('node');
    vi.spyOn(TmuxManager.prototype, 'readPaneTitle')
      .mockResolvedValueOnce('⠋ Working')
      .mockResolvedValue('⠙ Working');
    vi.spyOn(TmuxManager.prototype, 'waitReplReady').mockRejectedValue(new Error('repl not ready'));
    vi.spyOn(TmuxManager.prototype, 'capturePaneById').mockResolvedValue('› \n');

    await seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(manager, (await agentStore.get('qa-1'))!, cfgOf(manager, 'qa-1'));

    expect(ok).toBe(false);
    expect(keys).toEqual(['Escape']);
  });

  it('holds AFTER one C-c when a human `node` session never becomes a Codex composer (`>` ≠ `›`)', async () => {
    Object.assign(manager, { runtimeLivenessProbeMs: 1, cleanComposerWaitMs: 20 });
    const keys = spyClearFlow(NODE_HUMAN_SESSION, NODE_HUMAN_SESSION, { cleanAfterCtrlC: false });

    await seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(manager, (await agentStore.get('qa-1'))!, cfgOf(manager, 'qa-1'));

    expect(ok).toBe(false);
    expect(keys).toEqual(['Escape', 'C-c']);
  });

  it('holds AFTER C-c when a runtime menu does not dismiss to a clean composer', async () => {
    Object.assign(manager, { runtimeLivenessProbeMs: 1, cleanComposerWaitMs: 20 });
    const keys = spyClearFlow(RUNTIME_MENU, RUNTIME_MENU, { cleanAfterCtrlC: false });

    await seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(manager, (await agentStore.get('qa-1'))!, cfgOf(manager, 'qa-1'));

    expect(ok).toBe(false);
    expect(keys).toEqual(['Escape', 'C-c']);
  });

  it('holds (no C-c) on a live turn with NO busy marker — sampled for change, not gated on busy markers', async () => {
    Object.assign(manager, { runtimeLivenessProbeMs: 1 });
    const keys = spyKeys();
    vi.spyOn(TmuxManager.prototype, 'waitReplReady').mockRejectedValue(new Error('repl not ready'));
    vi.spyOn(TmuxManager.prototype, 'capturePaneById')
      .mockResolvedValueOnce(GROWING_OUTPUT_A)
      .mockResolvedValueOnce(GROWING_OUTPUT_B);

    await seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(manager, (await agentStore.get('qa-1'))!, cfgOf(manager, 'qa-1'));

    expect(ok).toBe(false);
    expect(keys).toEqual(['Escape']);
  });

  it('holds AFTER C-c when a bare `›` still sits under a permission/confirm blocker', async () => {
    Object.assign(manager, { runtimeLivenessProbeMs: 1, cleanComposerWaitMs: 20 });
    const keys = spyClearFlow(BLOCKER_OVER_PROMPT, BLOCKER_OVER_PROMPT, { cleanAfterCtrlC: false });

    await seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(manager, (await agentStore.get('qa-1'))!, cfgOf(manager, 'qa-1'));

    expect(ok).toBe(false);
    expect(keys).toEqual(['Escape', 'C-c']);
  });

  it('holds (cancel-interrupt-failed) without sending keys when the pane mutex stays busy past the wait window', async () => {
    Object.assign(manager, { cancelInterruptGuardWaitMs: 30, compactIdlePollMs: 5 });
    const keys = spyKeys();
    (manager as unknown as { compactInFlight: Set<string> }).compactInFlight.add('qa-1');
    await seedAgent({ id: 'qa-1', taskId: 'tBusy', paneId: '%7', status: 'awaiting_human', awaitingPhase: 'cancel-clearing' });

    const ok = await callInterrupt(manager, (await agentStore.get('qa-1'))!, cfgOf(manager, 'qa-1'));

    expect(ok).toBe(false);
    expect(keys).toEqual([]);
    expect((await agentStore.get('qa-1'))?.awaitingPhase).toBe('cancel-interrupt-failed');
  });

  it('waits for a busy pane mutex and proceeds once the in-flight dispatch releases it (no instant hold)', async () => {
    Object.assign(manager, { cancelInterruptGuardWaitMs: 2_000, compactIdlePollMs: 5 });
    const keys = spyKeys();
    vi.spyOn(TmuxManager.prototype, 'waitReplReady').mockResolvedValue(undefined);
    const inFlight = (manager as unknown as { compactInFlight: Set<string> }).compactInFlight;
    inFlight.add('qa-1');
    setTimeout(() => inFlight.delete('qa-1'), 25);

    await seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(manager, (await agentStore.get('qa-1'))!, cfgOf(manager, 'qa-1'));

    expect(ok).toBe(true);
    expect(keys).toEqual(['Escape']);
  });

  it('returns ready on ESC alone, without capturing or escalating, when the pane is already idle', async () => {
    const keys = spyKeys();
    vi.spyOn(TmuxManager.prototype, 'waitReplReady').mockResolvedValue(undefined);
    const captureSpy = vi.spyOn(TmuxManager.prototype, 'capturePaneById');

    await seedAgent({ id: 'qa-1', paneId: '%7' });
    const state = (await agentStore.get('qa-1'))!;
    const ok = await callInterrupt(manager, state, cfgOf(manager, 'qa-1'));

    expect(ok).toBe(true);
    expect(keys).toEqual(['Escape']);
    expect(captureSpy).not.toHaveBeenCalled();
  });

  it('injectAndAwaitAck aborts a dispatch whose bound task went terminal while waiting for the pane mutex', async () => {
    const t = await seedTask({ status: 'cancelled' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    const tmux = new TmuxManager(readyRunner());
    await expect(
      callInjectAndAwaitAck(manager, tmux, '%0', 'prompt', 'dev-1', 'claude-code'),
    ).rejects.toThrow(/went terminal/);
  });

  it('injectAndAwaitAck aborts when cancel marked the agent cancel-clearing before the task flips terminal', async () => {
    const t = await seedTask({ status: 'in_progress' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-clearing' });
    const tmux = new TmuxManager(readyRunner());
    await expect(
      callInjectAndAwaitAck(manager, tmux, '%0', 'prompt', 'dev-1', 'claude-code'),
    ).rejects.toThrow(/taken over by cancel/);
  });

  it('injectAndAwaitAck re-checks after the task read: aborts before paste if cancel lands during taskStore.get', async () => {
    const t = await seedTask({ status: 'in_progress' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    const injectSpy = vi.spyOn(TmuxManager.prototype, 'injectPrompt').mockResolvedValue(undefined as unknown as void);
    const realGet = taskStore.get.bind(taskStore);
    vi.spyOn(taskStore, 'get').mockImplementation(async (id: string) => {
      await agentStore.update('dev-1', (s) => (s ? { ...s, status: 'awaiting_human', awaitingPhase: 'cancel-clearing' } : AGENT_STORE_NOOP));
      return realGet(id);
    });
    const tmux = new TmuxManager(readyRunner());
    await expect(
      callInjectAndAwaitAck(manager, tmux, '%0', 'prompt', 'dev-1', 'claude-code'),
    ).rejects.toThrow(/taken over by cancel before paste/);
    expect(injectSpy).not.toHaveBeenCalled();
  });

  it('injectTextToAgent re-checks after the task read: aborts before paste if cancel lands during taskStore.get', async () => {
    const t = await seedTask({ status: 'in_progress' });
    await seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%0' });
    await acquireBoundLock('qa-1', t.id);
    const injectSpy = vi.spyOn(TmuxManager.prototype, 'injectPrompt').mockResolvedValue(undefined as unknown as void);
    const realGet = taskStore.get.bind(taskStore);
    vi.spyOn(taskStore, 'get').mockImplementation(async (id: string) => {
      await agentStore.update('qa-1', (s) => (s ? { ...s, status: 'awaiting_human', awaitingPhase: 'cancel-clearing' } : AGENT_STORE_NOOP));
      return realGet(id);
    });
    await expect(
      manager.injectTextToAgent('qa-1', 'file body', { expectedTaskId: t.id }),
    ).rejects.toThrow(/taken over by cancel before paste/);
    expect(injectSpy).not.toHaveBeenCalled();
  });

  it('injectTextToAgent aborts before paste when a DELETE→recreate bumps the generation during pane resolution', async () => {
    const t = await seedTask({ id: 'task-rf-aba', status: 'in_progress' });
    await seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%0' });
    await acquireBoundLock('qa-1', t.id);
    const injectSpy = vi.spyOn(TmuxManager.prototype, 'injectPrompt').mockResolvedValue(undefined as unknown as void);
    vi.spyOn(manager as unknown as { resolveClaimedPane: (...a: unknown[]) => Promise<unknown> }, 'resolveClaimedPane')
      .mockImplementation(async () => {
        manager.bumpDeletionGeneration('qa-1'); // DELETE→same-id recreate lands during the resolve await
        return { session: { sessionId: '$1', serverPid: '4242', serverStart: '1700000000' }, paneId: '%0', claim: 'qa-1' };
      });
    await expect(
      manager.injectTextToAgent('qa-1', 'file body', { expectedTaskId: t.id }),
    ).rejects.toThrow(/deleted or recreated before paste/);
    expect(injectSpy).not.toHaveBeenCalled();
  });

  it('cleanupRemovedAgentRuntime bounds every tmux probe/kill with a deadline (no unbounded hang holding the tombstone)', async () => {
    await seedAgent({ id: 'dev-1', paneId: '%5' });
    const timeouts: Array<number | undefined> = [];
    vi.spyOn(manager as unknown as { createRunnerFor: (a: unknown) => CommandRunner }, 'createRunnerFor')
      .mockReturnValue({
        exec: vi.fn(async (cmd: string, o?: { timeout?: number }) => {
          timeouts.push(o?.timeout);
          if (cmd.includes('list-sessions')) return { stdout: '4242|1700000000|$1|dev-1\n', stderr: '', exitCode: 0 };
          return { stdout: '', stderr: '', exitCode: 0 }; // kill if-shell → killed
        }),
        writeFile: vi.fn(async () => {}),
      } as unknown as CommandRunner);

    await manager.cleanupRemovedAgentRuntime(['dev-1']);

    // The snapshot probe and the kill both carry the bounded deadline.
    expect(timeouts.filter(t => t !== undefined).length).toBeGreaterThanOrEqual(2);
    expect(timeouts.filter(t => t !== undefined).every(t => t === 15_000)).toBe(true);
  });

  it('injectTextToAgent refuses to inject into a pane held by cancel cleanup', async () => {
    await seedTask({ id: 'task-rf-hold', status: 'in_progress' });
    await seedAgent({ id: 'qa-1', taskId: 'task-rf-hold', paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-clearing' });
    await expect(
      manager.injectTextToAgent('qa-1', 'file body', { expectedTaskId: 'task-rf-hold' }),
    ).rejects.toThrow(/taken over by cancel/);
  });

  it('injectTextToAgent refuses to inject when the bound task is already terminal', async () => {
    const t = await seedTask({ id: 'task-rf-terminal', status: 'cancelled' });
    await seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%0' });
    await acquireBoundLock('qa-1', t.id);
    await expect(
      manager.injectTextToAgent('qa-1', 'file body', { expectedTaskId: t.id }),
    ).rejects.toThrow(/terminal/);
  });

  it('injectTextToAgent refuses a newer lock generation for the same task', async () => {
    const t = await seedTask({ id: 'task-rf-rebound', status: 'in_progress' });
    await seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%0' });
    const oldToken = await acquireBoundLock('qa-1', t.id);
    expect(oldToken).toBeTruthy();
    await agentStore.update('qa-1', state => ({ ...state!, lockToken: oldToken!, updatedAt: NOW }));
    const injectSpy = vi.spyOn(TmuxManager.prototype, 'injectPrompt').mockResolvedValue(undefined as unknown as void);
    const realGet = taskStore.get.bind(taskStore);
    vi.spyOn(taskStore, 'get').mockImplementation(async (id: string) => {
      await lockManager.releaseIfOwner('qa-1', t.id, oldToken!);
      const newToken = await lockManager.acquire('qa-1', t.id);
      expect(newToken).toBeTruthy();
      await agentStore.update('qa-1', state => ({ ...state!, lockToken: newToken!, updatedAt: NOW }));
      return realGet(id);
    });

    await expect(
      manager.injectTextToAgent('qa-1', 'stale file body', { expectedTaskId: t.id }),
    ).rejects.toThrow(/exclusive lock changed/);
    expect(injectSpy).not.toHaveBeenCalled();
  });

  it('attachImageToRunningAgent refuses to paste into a pane held by cancel cleanup', async () => {
    await seedTask({ id: 'task-img-hold', status: 'in_progress' });
    await seedAgent({ id: 'qa-1', taskId: 'task-img-hold', paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-clearing' });
    await expect(
      manager.attachImageToRunningAgent('qa-1', Buffer.from('img'), 'png'),
    ).rejects.toThrow(/being cancelled/);
  });

  it('attachImageToRunningAgent refuses when the bound task is already terminal', async () => {
    const t = await seedTask({ id: 'task-img-terminal', status: 'cancelled' });
    await seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%0' });
    await expect(
      manager.attachImageToRunningAgent('qa-1', Buffer.from('img'), 'png'),
    ).rejects.toThrow(/terminal/);
  });

  it('attachImageToRunningAgent re-checks cancel state AFTER the slow host write — refuses the paste if cancel landed', async () => {
    await seedTask({ id: 'task-img-toctou', status: 'in_progress' });
    await seedAgent({ id: 'dev-1', taskId: 'task-img-toctou', paneId: '%0' });
    const injectSpy = vi.spyOn(TmuxManager.prototype, 'injectPrompt').mockResolvedValue(undefined as unknown as void);
    const localManager = makeManager({
      skillRegistry: freshRegistry(),
      runnerFactory: () => ({
        exec: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
        writeFile: vi.fn(async () => {
          await agentStore.update('dev-1', (s) => (s ? { ...s, status: 'awaiting_human', awaitingPhase: 'cancel-clearing' } : AGENT_STORE_NOOP));
        }),
      } as unknown as CommandRunner),
    });

    await expect(
      localManager.attachImageToRunningAgent('dev-1', Buffer.from('img'), 'png'),
    ).rejects.toThrow(/being cancelled/);
    expect(injectSpy).not.toHaveBeenCalled();
  });

  it('attachImageToRunningAgent re-checks the cancel hold AFTER its task read (closes the assertUploadStillValid gap)', async () => {
    await seedTask({ id: 'task-img-taskgap', status: 'in_progress' });
    await seedAgent({ id: 'dev-1', taskId: 'task-img-taskgap', paneId: '%0' });
    const injectSpy = vi.spyOn(TmuxManager.prototype, 'injectPrompt').mockResolvedValue(undefined as unknown as void);
    const realGet = taskStore.get.bind(taskStore);
    vi.spyOn(taskStore, 'get').mockImplementation(async (id: string) => {
      await agentStore.update('dev-1', (s) => (s ? { ...s, status: 'awaiting_human', awaitingPhase: 'cancel-clearing' } : AGENT_STORE_NOOP));
      return realGet(id);
    });
    const localManager = makeManager({
      skillRegistry: freshRegistry(),
      runnerFactory: () => ({
        exec: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
        writeFile: vi.fn(async () => undefined),
        execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
      } as unknown as CommandRunner),
    });
    await expect(
      localManager.attachImageToRunningAgent('dev-1', Buffer.from('img'), 'png'),
    ).rejects.toThrow(/being cancelled/);
    expect(injectSpy).not.toHaveBeenCalled();
  });

  it('cancel-interrupt guard wait is derived from the configured dispatch ack timeout (not the default)', () => {
    const m = makeManager({ skillRegistry: freshRegistry(), dispatchAckTimeoutMs: 60_000 }) as unknown as {
      cancelInterruptGuardWaitMs: number; dispatchAckTimeoutMs: number;
    };
    expect(m.dispatchAckTimeoutMs).toBe(60_000);
    expect(m.cancelInterruptGuardWaitMs).toBeGreaterThanOrEqual(60_000);
  });

  it('markAwaitingHuman does not let a generic hold overwrite a cancel-cleanup hold', async () => {
    await seedAgent({ id: 'dev-1', taskId: 'tX', status: 'awaiting_human', awaitingPhase: 'cancel-clearing' });

    await manager.markAwaitingHuman('dev-1', 'code-dispatch-failed', 'generic dispatch failure');
    expect((await agentStore.get('dev-1'))?.awaitingPhase).toBe('cancel-clearing');

  });

  it('markAwaitingHuman still allows the escalation cancel-clearing → cancel-interrupt-failed', async () => {
    await seedAgent({ id: 'dev-1', taskId: 'tX', status: 'awaiting_human', awaitingPhase: 'cancel-clearing' });
    await manager.markAwaitingHuman('dev-1', 'cancel-interrupt-failed', 'interrupt failed');
    expect((await agentStore.get('dev-1'))?.awaitingPhase).toBe('cancel-interrupt-failed');
  });

  it('markPaneCancelClearing still sets cancel-clearing from a non-hold binding (initial cancel)', async () => {
    await seedAgent({ id: 'dev-1', taskId: 'tX', paneId: '%0' });
    await (manager as unknown as { markPaneCancelClearing: (a: string, t: string) => Promise<void> })
      .markPaneCancelClearing('dev-1', 'tX');
    expect((await agentStore.get('dev-1'))?.awaitingPhase).toBe('cancel-clearing');
  });

  it('cancel-interrupt guard wait covers the dispatch ack window (so cancel-during-ack is not dropped to hold)', () => {
    const m = manager as unknown as { cancelInterruptGuardWaitMs: number; dispatchAckTimeoutMs: number };
    expect(m.cancelInterruptGuardWaitMs).toBeGreaterThanOrEqual(m.dispatchAckTimeoutMs);
  });
});

describe('AgentManager dispatchPostMergeCleanup', () => {
  it('keeps the binding and lock when no runtime pane is available for safe release', async () => {
    const execs: string[] = [];
    manager = makeManager({ runnerFactory: () => recordingRunner(execs) });
    await seedAgent({ id: 'dev-1', taskId: 'task-x' });

    await manager.dispatchPostMergeCleanup('dev-1', { taskId: 'task-x', branch: 'bx/task-x' });

    expect(await agentStore.get('dev-1')).toMatchObject({
      taskId: 'task-x',
      status: 'awaiting_human',
      awaitingPhase: 'branch-cleanup-pending',
    });
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  it('runs the full cycle: idle → /clear → release, with NO agent dialogue', async () => {
    const execs: string[] = [];
    const promptInjections: string[] = [];
    manager = makeManager({ runnerFactory: () => compactRunner(execs, captureInjection(promptInjections)) });
    setCompactTiming(manager);
    await seedAgent({ id: 'dev-1', paneId: '%5', taskId: 'merged-task', workdir: '/repo/main' });

    await manager.dispatchPostMergeCleanup('dev-1', { taskId: 'merged-task', branch: 'bx/merged-task' });
    await waitUntilAsync(async () => !(await agentStore.get('dev-1'))?.taskId);

    const joined = execs.join('\n');
    expect(promptInjections).toEqual([]);
    expect(joined).not.toMatch(/tmux (load|paste)-buffer/);
    expect(joined).toMatch(/send-keys -l -t %5 '\\''\/clear'\\''/);
    expect(joined).not.toMatch(/\/compact/);
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
  });

  it('skips the pane /clear when a DELETE→recreate bumps the generation mid-flight (ABA: reused pane id)', async () => {
    const execs: string[] = [];
    manager = makeManager({ runnerFactory: () => compactRunner(execs) });
    setCompactTiming(manager);
    await seedAgent({ id: 'dev-1', paneId: '%5', taskId: 'merged-task', workdir: '/repo/main' });

    // Bump the generation on the first state read (after the entry capture) → the pane side-effect gate closes.
    let bumped = false;
    const realGet = agentStore.get.bind(agentStore);
    vi.spyOn(agentStore, 'get').mockImplementation(async (id: string) => {
      const s = await realGet(id);
      if (id === 'dev-1' && !bumped) { bumped = true; manager.bumpDeletionGeneration('dev-1'); }
      return s;
    });

    await manager.dispatchPostMergeCleanup('dev-1', { taskId: 'merged-task', branch: 'bx/merged-task' });
    await new Promise(r => setTimeout(r, 50));

    expect(execs.join('\n')).not.toMatch(/send-keys.*\/clear/);
  });

  it('regreetHeldAgent aborts without injecting when a DELETE→recreate bumps the generation', async () => {
    const execs: string[] = [];
    manager = makeManager({ runnerFactory: () => recordingRunner(execs) });
    await seedAgent({ id: 'dev-1', paneId: '%0', status: 'awaiting_human', awaitingPhase: 'greeting_failed', awaitingSince: NOW });

    let bumped = false;
    const realGet = agentStore.get.bind(agentStore);
    vi.spyOn(agentStore, 'get').mockImplementation(async (id: string) => {
      const s = await realGet(id);
      if (id === 'dev-1' && !bumped) { bumped = true; manager.bumpDeletionGeneration('dev-1'); }
      return s;
    });

    expect(await manager.regreetHeldAgent('dev-1')).toBe(false);
    expect(execs.join('\n')).not.toMatch(/paste-buffer|send-keys/);
  });

  it('attachImageToRunningAgent aborts when a DELETE→recreate bumps the generation mid-upload', async () => {
    const execs: string[] = [];
    manager = makeManager({ runnerFactory: () => recordingRunner(execs) });
    await seedAgent({ id: 'dev-1', paneId: '%0' });

    let bumped = false;
    const realGet = agentStore.get.bind(agentStore);
    vi.spyOn(agentStore, 'get').mockImplementation(async (id: string) => {
      const s = await realGet(id);
      if (id === 'dev-1' && !bumped) { bumped = true; manager.bumpDeletionGeneration('dev-1'); }
      return s;
    });

    await expect(manager.attachImageToRunningAgent('dev-1', Buffer.from('x'), 'png'))
      .rejects.toThrow(/deleted or recreated/);
  });

  it('handleDialogPendingFromRuntime refuses when the caller generation no longer matches (DELETE→recreate)', async () => {
    await seedAgent({ id: 'dev-1', paneId: '%0', taskId: 'task-x' });
    const gen = manager.deletionGenerationOf('dev-1');
    manager.bumpDeletionGeneration('dev-1'); // incarnation replaced since the caller captured gen
    const err = new EnsureSessionError({ createdSession: false, agentId: 'dev-1', dialogPending: true }, 'dialog');

    const handled = await manager.handleDialogPendingFromRuntime('dev-1', err, { expectedGeneration: gen });

    expect(handled).toBe(false);
    expect((await agentStore.get('dev-1'))?.awaitingPhase).toBeUndefined();
  });

  it('temporarily claims an exact lock before cleaning an unbound idle agent', async () => {
    const execs: string[] = [];
    manager = makeManager({ runnerFactory: () => compactRunner(execs) });
    setCompactTiming(manager);
    await seedAgent({ id: 'dev-1', paneId: '%5', workdir: '/repo/main' });

    await manager.dispatchPostMergeCleanup('dev-1', { taskId: 'merged-task', branch: 'bx/merged-task' });
    await waitUntilAsync(async () =>
      !(await agentStore.get('dev-1'))?.taskId && !(await lockManager.isLocked('dev-1')),
    );

    expect(execs.join('\n')).toMatch(/send-keys -l -t %5 '\\''\/clear'\\''/);
    expect(await lockManager.isLocked('dev-1')).toBe(false);
  });

  it('releases after post-merge clear when a small claude pane hides the footer ready anchor', async () => {
    const execs: string[] = [];
    manager = makeManager({ runnerFactory: () => smallPaneClaudeCompactRunner(execs) });
    setCompactTiming(manager);
    await seedAgent({ id: 'dev-1', paneId: '%5', taskId: 'merged-task', workdir: '/repo/main' });

    await manager.dispatchPostMergeCleanup('dev-1', { taskId: 'merged-task', branch: 'bx/merged-task' });
    await waitUntilAsync(async () => !(await agentStore.get('dev-1'))?.taskId);

    expect(execs.join('\n')).toMatch(/send-keys -l -t %5 '\\''\/clear'\\''/);
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
  });

  it('never force-deletes a local branch during post-merge cleanup', async () => {
    const execs: string[] = [];
    manager = makeManager({ runnerFactory: () => compactRunner(execs) });
    setCompactTiming(manager);
    await seedAgent({ id: 'dev-1', paneId: '%5', workdir: '/repo/main-clone', taskId: 'merged-task' });

    await manager.dispatchPostMergeCleanup('dev-1', { taskId: 'merged-task', branch: 'bx/task-merge' });
    await waitUntilAsync(async () => !(await agentStore.get('dev-1'))?.taskId);

    expect(execs.join('\n')).not.toContain('git branch -D');
    expect(execs.join('\n')).toMatch(/send-keys -l -t %5 '\\''\/clear'\\''/);
  });

  it('holds taskId on the binding during local branch cleanup and releases after', async () => {
    const execs: string[] = [];
    let taskIdDuringCheckoutCleanup: string | undefined;
    manager = makeManager({ runnerFactory: () => compactRunner(execs) });
    setCompactTiming(manager);
    await seedTask({ id: 'merged-task', branch: 'bx/merged-task', status: 'merged' });
    await seedAgent({ id: 'dev-1', paneId: '%5', workdir: '/repo/main', taskId: 'merged-task' });
    vi.spyOn(BranchManager.prototype, 'cleanupTaskBranch').mockImplementation(async () => {
      taskIdDuringCheckoutCleanup = (await agentStore.get('dev-1'))?.taskId;
      return { status: 'deleted' };
    });

    await manager.dispatchPostMergeCleanup('dev-1', { taskId: 'merged-task', branch: 'bx/merged-task' });
    await waitUntilAsync(async () => !(await agentStore.get('dev-1'))?.taskId);

    expect(taskIdDuringCheckoutCleanup).toBe('merged-task');
    expect(execs.join('\n')).toMatch(/send-keys -l -t %5 '\\''\/clear'\\''/);
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
  });

  it('post-merge wrap-up never invokes the retired force-delete path', async () => {
    const BUSY = '⏵⏵ bypass permissions on /tmp/repo\n\n· Compacting… (3s)\n  esc to interrupt\n';
    const IDLE = '⏵⏵ bypass permissions on /tmp/repo\n\n>';
    let busyLeft = 0;
    const execs: string[] = [];
    manager = makeManager({
      runnerFactory: () => ({
        exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
          execs.push(cmd);
          const runtimeFact = claimedRuntimeFact(cmd, () => '%5');
          if (runtimeFact) return runtimeFact;
          if (cmd.includes('send-keys') && cmd.includes("'Enter'")) busyLeft = 3;
          if (cmd.includes('display-message') && cmd.includes('pane_current_command') && !cmd.includes('capture-pane')) {
            return { stdout: 'BX_PANE_OKclaude\n', stderr: '', exitCode: 0 };
          }
          if (cmd.includes('capture-pane')) {
            let frame = IDLE;
            if (busyLeft > 0) { busyLeft--; frame = BUSY; }
            if (cmd.includes('history_size')) return { stdout: `BX_PANE_OK|0\n${frame}`, stderr: '', exitCode: 0 };
            return { stdout: `BX_PANE_OK\n${frame}`, stderr: '', exitCode: 0 };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        }),
        writeFile: vi.fn(async (): Promise<void> => undefined),
        execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
      }) as unknown as CommandRunner,
    });
    setCompactTiming(manager);
    await seedAgent({ id: 'dev-1', paneId: '%5', workdir: '/repo/main', taskId: 'merged-task' });

    await manager.dispatchPostMergeCleanup('dev-1', { taskId: 'merged-task', branch: 'bx/merged-task' });
    await waitUntilAsync(async () => !(await agentStore.get('dev-1'))?.taskId);

    const joined = execs.join('\n');
    expect(joined).not.toContain('git branch -D');
    expect(joined).toMatch(/send-keys -l -t %5 '\\''\/clear'\\''/);
    expect(joined).not.toMatch(/\/compact/);
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
  });

  it('releases a binding without workdir because branch deletion is centralized elsewhere', async () => {
    const execs: string[] = [];
    manager = makeManager({ runnerFactory: () => compactRunner(execs) });
    setCompactTiming(manager);
    await seedAgent({ id: 'dev-1', paneId: '%5', taskId: 'merged-task' });

    await manager.dispatchPostMergeCleanup('dev-1', { taskId: 'merged-task', branch: 'bx/merged-task' });
    await waitUntilAsync(async () => !(await agentStore.get('dev-1'))?.taskId);

    const joined = execs.join('\n');
    expect(joined).not.toContain('git branch -D');
    expect(joined).toMatch(/send-keys -l -t %5 '\\''\/clear'\\''/);
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
  });

  it('treats a fast /clear (busy seen only briefly) as success, not a failed start', async () => {
    const execs: string[] = [];
    manager = makeManager({ runnerFactory: () => compactRunner(execs, undefined, 1) });
    setCompactTiming(manager);
    await seedAgent({ id: 'dev-1', paneId: '%5', taskId: 'merged-task', workdir: '/repo/main' });

    await manager.dispatchPostMergeCleanup('dev-1', { taskId: 'merged-task', branch: 'bx/merged-task' });
    await waitUntilAsync(async () => !(await agentStore.get('dev-1'))?.taskId);

    const binding = await agentStore.get('dev-1');
    expect(execs.join('\n')).toMatch(/send-keys -l -t %5 '\\''\/clear'\\''/);
    expect(binding?.taskId).toBeUndefined();
    expect(binding?.status).not.toBe('awaiting_human');
  });

  it('bails without touching the agent when its binding has moved to a different task', async () => {
    const execs: string[] = [];
    manager = makeManager({ runnerFactory: () => compactRunner(execs) });
    setCompactTiming(manager, 50, 5);
    await seedAgent({ id: 'dev-1', paneId: '%5', workdir: '/repo/main', taskId: 'next-task' });

    await manager.dispatchPostMergeCleanup('dev-1', { taskId: 'merged-task', branch: 'bx/task-merge' });
    await new Promise(r => setTimeout(r, 60));

    const joined = execs.join('\n');
    expect(joined).not.toContain('git fetch --prune origin');
    expect(joined).not.toContain("send-keys -l -t %5 '\\''/clear'\\''");
    const binding = await agentStore.get('dev-1');
    expect(binding?.taskId).toBe('next-task');
  });

  it('dispatchPendingTask refuses an agent still bound to a just-merged task (post-merge cleanup in flight → Start disabled)', async () => {
    await seedAgent({ id: 'dev-1', paneId: '%5', taskId: 'merged-task' });
    await seedTask({ id: 'next-task', status: 'pending', agentId: 'dev-1', preferredAgentId: 'dev-1' });

    const result = await manager.dispatchPendingTask('next-task', 'dev-1');

    expect(result.errorCode).toBe(409);
    expect((await taskStore.get('next-task'))?.status).toBe('pending');
  });

  it('dispatchPendingTask rejects the binding when a DELETE→recreate bumps the generation after entry', async () => {
    await seedAgent({ id: 'dev-1' });
    await seedTask({ id: 'pend-task', status: 'pending', agentId: 'dev-1', preferredAgentId: 'dev-1' });
    // The generation capture must precede the agent config/state reads: bump it on the first
    // post-capture state read so a DELETE→same-id recreate in that window closes the gate.
    let bumped = false;
    const realGet = agentStore.get.bind(agentStore);
    vi.spyOn(agentStore, 'get').mockImplementation(async (id: string) => {
      const state = await realGet(id);
      if (id === 'dev-1' && !bumped) {
        bumped = true;
        manager.bumpDeletionGeneration('dev-1');
      }
      return state;
    });

    const result = await manager.dispatchPendingTask('pend-task', 'dev-1');

    expect(result.errorCode).toBe(409);
    expect((await realGet('dev-1'))?.taskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(false);
    expect((await taskStore.get('pend-task'))?.status).toBe('pending');
  });

  it('a pending task reference prevents deletion from tombstoning its participant', async () => {
    await seedAgent({ id: 'dev-1' });
    await seedTask({ id: 'pend-ser', status: 'pending', agentId: 'dev-1', preferredAgentId: 'dev-1' });

    const claim = await manager.scanOpenThenClaimDeletion(['dev-1']);

    expect(claim).toEqual({ ok: false, code: 'referencing', taskId: 'pend-ser' });
    expect((await taskStore.get('pend-ser'))?.status).toBe('pending');
    expect(manager.isDeletionInFlight('dev-1')).toBe(false);
  });

  it('dispatchPendingTask rejects when a non-dispatched participant (QA) is deleted+recreated before the active write', async () => {
    await seedAgent({ id: 'dev-1' });
    await seedTask({ id: 'pend-qa', status: 'pending', preferredAgentId: '', agentId: '' });
    // Unassigned task dispatched to dev-1 snapshots qa-1 from its group; bump qa-1's generation right after the
    // binding commit (between the participant snapshot and the active write) so the re-check rejects the stale qa.
    const realUpdate = agentStore.update.bind(agentStore);
    let bumped = false;
    vi.spyOn(agentStore, 'update').mockImplementation(async (id: string, cb) => {
      const result = await realUpdate(id, cb);
      if (id === 'dev-1' && !bumped) { bumped = true; manager.bumpDeletionGeneration('qa-1'); }
      return result;
    });

    const result = await manager.dispatchPendingTask('pend-qa', 'dev-1');

    expect(result.errorCode).toBe(409);
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(false);
    expect((await taskStore.get('pend-qa'))?.status).toBe('pending');
  });

  it('keeps the binding and exact lock when runtime idleness cannot be proven', async () => {
    const execs: string[] = [];
    const alwaysBusy = '⏵⏵ bypass permissions on /tmp/repo\n\n· Compacting… (3s)\n  esc to interrupt\n';
    manager = makeManager({ runnerFactory: () => capturePaneRunner(execs, () => alwaysBusy) });
    setCompactTiming(manager, 50, 5);
    await seedAgent({ id: 'dev-1', paneId: '%5', taskId: 'merged-task', workdir: '/repo/main' });

    await manager.dispatchPostMergeCleanup('dev-1', { taskId: 'merged-task', branch: 'bx/merged-task' });
    await waitUntilAsync(async () => (await agentStore.get('dev-1'))?.awaitingPhase === 'post-merge-cleanup-not-idle', 5000);

    const binding = await agentStore.get('dev-1');
    expect(binding).toMatchObject({
      taskId: 'merged-task',
      status: 'awaiting_human',
      awaitingPhase: 'post-merge-cleanup-not-idle',
    });
    expect(await lockManager.isOwner('dev-1', 'merged-task', binding!.lockToken!)).toBe(true);
  });

  it('does not write taskId when paneId changes between initial read and update (race with retry/restart)', async () => {
    const execs: string[] = [];
    manager = makeManager({ runnerFactory: () => compactRunner(execs) });
    setCompactTiming(manager);
    await seedAgent({ id: 'dev-1', paneId: '%5' });

    const origUpdate = agentStore.update.bind(agentStore);
    vi.spyOn(agentStore, 'update').mockImplementationOnce(async (id, cb) => {
      const cur = await agentStore.get(id);
      if (cur) await agentStore.set({ ...cur, paneId: '%99' });
      return origUpdate(id, cb);
    });

    await manager.dispatchPostMergeCleanup('dev-1', { taskId: 'merged-task', branch: 'bx/merged-task' });
    await new Promise(r => setTimeout(r, 60));

    const binding = await agentStore.get('dev-1');
    expect(binding?.taskId).toBeUndefined();
    expect(binding?.paneId).toBe('%99');
    expect(await lockManager.isLocked('dev-1')).toBe(false);
    expect(execs.join('\n')).not.toContain('git fetch');
    expect(execs.join('\n')).not.toContain('/clear');
  });

  it('stops touching the pane on retry when binding is released/rebound between attempts', async () => {
    const execs: string[] = [];
    const BUSY = '⏵⏵ bypass permissions on /tmp/repo\n\n· Compacting… (3s)\n  esc to interrupt\n';
    let captureCount = 0;
    let rebindExecIdx = -1;
    manager = makeManager({
      runnerFactory: () => capturePaneRunner(execs, async () => {
        captureCount++;
        if (captureCount === 3) {
          const cur = await agentStore.get('dev-1');
          if (cur) await agentStore.set({ ...cur, taskId: 'new-review-task', updatedAt: new Date().toISOString() });
          rebindExecIdx = execs.length;
        }
        return BUSY;
      }),
    });
    setCompactTiming(manager, 50, 5);
    await seedAgent({ id: 'dev-1', paneId: '%5', taskId: 'merged-task', workdir: '/repo/main' });

    await manager.dispatchPostMergeCleanup('dev-1', { taskId: 'merged-task', branch: 'bx/merged-task' });
    await new Promise(r => setTimeout(r, 500));

    expect(execs.filter(c => c.includes('send-keys') && c.includes('C-c'))).toHaveLength(1);
    expect(rebindExecIdx).toBeGreaterThanOrEqual(0);
    expect(execs.slice(rebindExecIdx).filter(c => c.includes('send-keys'))).toHaveLength(0);
    const binding = await agentStore.get('dev-1');
    expect(binding?.taskId).toBe('new-review-task');
  });

  it('stops touching the pane when the same task acquires a newer lock generation', async () => {
    const execs: string[] = [];
    const busy = '⏵⏵ bypass permissions on /tmp/repo\n\n· Compacting… (3s)\n  esc to interrupt\n';
    let captureCount = 0;
    let generationChangedAt = -1;
    manager = makeManager({
      runnerFactory: () => capturePaneRunner(execs, async () => {
        captureCount++;
        if (captureCount === 3) {
          const current = (await agentStore.get('dev-1'))!;
          await lockManager.releaseIfOwner('dev-1', 'merged-task', current.lockToken!);
          const newToken = await lockManager.acquire('dev-1', 'merged-task');
          expect(newToken).toBeTruthy();
          await agentStore.update('dev-1', state => ({
            ...state!,
            lockToken: newToken!,
            updatedAt: new Date().toISOString(),
          }));
          generationChangedAt = execs.length;
        }
        return busy;
      }),
    });
    setCompactTiming(manager, 50, 5);
    await seedAgent({ id: 'dev-1', paneId: '%5', taskId: 'merged-task', workdir: '/repo/main' });

    await manager.dispatchPostMergeCleanup('dev-1', { taskId: 'merged-task', branch: 'bx/merged-task' });
    await new Promise(r => setTimeout(r, 500));

    expect(generationChangedAt).toBeGreaterThanOrEqual(0);
    expect(execs.slice(generationChangedAt).filter(c => c.includes('send-keys'))).toHaveLength(0);
    const binding = await agentStore.get('dev-1');
    expect(binding?.taskId).toBe('merged-task');
    expect(await lockManager.isOwner('dev-1', 'merged-task', binding!.lockToken!)).toBe(true);
  });
});

describe('AgentManager awaiting_human lifecycle', () => {
  it('markAwaitingHuman sets status + emits intervention, preserving binding and lock', async () => {
    const t = await seedTask();
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
    });
    await acquireBoundLock('dev-1');

    await manager.markAwaitingHuman('dev-1', 'test-phase', 'test reason');

    const state = await agentStore.get('dev-1');
    expect(state?.status).toBe('awaiting_human');
    expect(state?.awaitingPhase).toBe('test-phase');
    expect(state?.awaitingReason).toBe('test reason');
    expect(state?.awaitingSince).toBeTruthy();
    expect(state?.taskId).toBe(t.id);
    expect(await lockManager.isLocked('dev-1')).toBe(true);

    const emitted = events.filter(
      e => e.type === 'human.intervention' && (e.data as { phase?: string }).phase === 'test-phase',
    );
    expect(emitted).toHaveLength(1);
  });

  it.each([
    { name: 'terminal task clears binding + releases lock', taskStatus: 'cancelled' as const, expectRelease: true },
    { name: 'active task clears status only, keeps binding', taskStatus: 'in_progress' as const, expectRelease: false },
  ])('resumeAgent on awaiting_human (cancel-interrupt-failed): $name', async ({ taskStatus, expectRelease }) => {
    const t = await seedTask({ status: taskStatus });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed' });
    await acquireBoundLock('dev-1');

    const result = await manager.resumeAgent('dev-1');

    expect(result).toEqual({ resumed: true, releasedBinding: expectRelease });
    const state = await agentStore.get('dev-1');
    expect(state?.status).toBeUndefined();
    if (expectRelease) {
      expect(state?.taskId).toBeUndefined();
      expect(state?.awaitingPhase).toBeUndefined();
    } else {
      expect(state?.taskId).toBe(t.id);
    }
    expect(await lockManager.isLocked('dev-1')).toBe(!expectRelease);
  });

  it.each([
    'agent_dialog_resolved_runtime',
    'signal-arm-failed:spec-done,pr-created',
  ])('resumeAgent REFUSES on awaitingPhase=%s + active task', async (phase) => {
    const t = await seedTask({ status: 'in_progress' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0', status: 'awaiting_human', awaitingPhase: phase });
    await acquireBoundLock('dev-1');

    const result = await manager.resumeAgent('dev-1');

    expect(result).toMatchObject({ resumed: false, releasedBinding: false });
    expect(result.reason).toBeTruthy();
    expect((await agentStore.get('dev-1'))?.status).toBe('awaiting_human');
    expect((await agentStore.get('dev-1'))?.taskId).toBe(t.id);
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  it('resumeAgent ALLOWS release on awaitingPhase=agent_dialog_resolved_runtime (slowPoll detected REPL ready)', async () => {
    const t = await seedTask({ status: 'failed' });
    await taskStore.set(t);
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'agent_dialog_resolved_runtime',
    });
    await acquireBoundLock('dev-1');

    const result = await manager.resumeAgent('dev-1');

    expect(result).toEqual({ resumed: true, releasedBinding: true });
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(false);
  });

  it('resumeAgent refuses when awaitingPhase=agent_dialog_pending (pane still blocked on dialog)', async () => {
    const t = task({ status: 'failed' });
    await taskStore.set(t);
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'agent_dialog_pending',
    });
    await acquireBoundLock('dev-1');

    const result = await manager.resumeAgent('dev-1');

    expect(result).toMatchObject({ resumed: false, releasedBinding: false });
    expect(result.reason).toBeTruthy();
    expect((await agentStore.get('dev-1'))?.status).toBe('awaiting_human');
    expect((await agentStore.get('dev-1'))?.awaitingPhase).toBe('agent_dialog_pending');
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  it('resumeAgent on agent that is not awaiting_human: noop', async () => {
    await seedAgent({ id: 'dev-1' });

    const result = await manager.resumeAgent('dev-1');

    expect(result).toMatchObject({ resumed: false, releasedBinding: false });
  });

  it('resumeAgent refuses when creationToken still set (bootstrap dialog unresolved)', async () => {
    await seedAgent({
      id: 'dev-1', creationToken: 'tok-still-pending',
      paneId: '%0',
      status: 'awaiting_human',
      awaitingPhase: 'agent_dialog_pending',
    });

    const result = await manager.resumeAgent('dev-1');

    expect(result).toMatchObject({ resumed: false, releasedBinding: false });
    expect(result.reason).toBeTruthy();
    expect((await agentStore.get('dev-1'))?.status).toBe('awaiting_human');
    expect((await agentStore.get('dev-1'))?.creationToken).toBe('tok-still-pending');
  });

  it.each([
    { name: 'active task (fixing) refuses', taskId: 'task-qa-stale', taskStatus: 'fixing' as const, expectRelease: false },
    { name: 'terminal task (cancelled) releases', taskId: 'task-qa-cancelled', taskStatus: 'cancelled' as const, expectRelease: true },
  ])('resumeAgent on dev-wait-gate-failed-after-qa-started: $name', async ({ taskId, taskStatus, expectRelease }) => {
    const t = await seedTask({ id: taskId, status: taskStatus });
    await seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1', status: 'awaiting_human', awaitingPhase: 'dev-wait-gate-failed-after-qa-started' });
    await acquireBoundLock('qa-1');

    const result = await manager.resumeAgent('qa-1');

    expect(result).toMatchObject({ resumed: expectRelease, releasedBinding: expectRelease });
    if (!expectRelease) expect(result.reason).toBeTruthy();
    expect((await agentStore.get('qa-1'))?.taskId).toBe(expectRelease ? undefined : t.id);
    if (!expectRelease) expect((await agentStore.get('qa-1'))?.status).toBe('awaiting_human');
    expect(await lockManager.isLocked('qa-1')).toBe(!expectRelease);
  });

  it('releaseAgentForTask with allowAwaitingHuman=true bypasses gate (explicit recovery path)', async () => {
    const t = await seedTask();
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'dispatch-failed:ack_unknown',
    });
    await acquireBoundLock('dev-1');

    const ok = await manager.releaseAgentForTask('dev-1', t.id, 'idle', { allowAwaitingHuman: true });

    expect(ok).toBe(true);
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(false);
  });

  it('validateTaskDispatch ALLOWS create against awaiting_human agent (queues to pending; dispatch-time gates availability)', async () => {
    await seedAgent({
      id: 'dev-1', status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed',
    });

    await expect(
      manager.validateTaskDispatch('proj', {
        title: 'x', description: 'y', preferredAgentId: 'dev-1',
      }),
    ).resolves.toBeUndefined();
  });

  it('resumeAgent no longer triggers drainQueue (pending tasks wait for explicit dispatchPendingTask)', async () => {
    const t = await seedTask({ id: 'task-resume-drain', status: 'cancelled' });
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed',
    });
    await acquireBoundLock('dev-1');

    const result = await manager.resumeAgent('dev-1');

    expect(result.resumed).toBe(true);
    expect(result.releasedBinding).toBe(true);
    expect('drainQueue' in (manager as unknown as Record<string, unknown>)).toBe(false);
  });

  it.each([
    { name: 'task terminal → bypass even without opt', agentId: 'dev-1', paneId: '%0', taskStatus: 'merged' as const, phase: 'dispatch-failed:ack_unknown', opt: undefined, expectedOk: true },
    { name: 'dev-wait-gate-failed + active task refuses', agentId: 'qa-1', paneId: '%1', taskStatus: 'fixing' as const, phase: 'dev-wait-gate-failed-after-qa-started', opt: undefined, expectedOk: false },
    { name: 'dev-wait-gate-failed WITH allowAwaitingHuman releases', agentId: 'qa-1', paneId: '%1', taskStatus: 'approved' as const, phase: 'dev-wait-gate-failed-after-qa-started', opt: { allowAwaitingHuman: true }, expectedOk: true },
    { name: 'dispatch-failed:ack_unknown without opt refuses', agentId: 'qa-1', paneId: '%1', taskStatus: 'review' as const, phase: 'dispatch-failed:ack_unknown', opt: undefined, expectedOk: false },
    { name: 'dispatch-failed:ack_unknown WITH allowAwaitingHuman releases', agentId: 'qa-1', paneId: '%1', taskStatus: 'approved' as const, phase: 'dispatch-failed:ack_unknown', opt: { allowAwaitingHuman: true }, expectedOk: true },
  ])('releaseAgentForTask gate: $name', async ({ agentId, paneId, taskStatus, phase, opt, expectedOk }) => {
    const t = await seedTask({ status: taskStatus });
    await seedAgent({ id: agentId, taskId: t.id, paneId, status: 'awaiting_human', awaitingPhase: phase });
    await acquireBoundLock(agentId);

    const ok = await manager.releaseAgentForTask(agentId, t.id, 'idle', opt);

    expect(ok).toBe(expectedOk);
    expect((await agentStore.get(agentId))?.taskId).toBe(expectedOk ? undefined : t.id);
    expect(await lockManager.isLocked(agentId)).toBe(!expectedOk);
  });

  it.each([
    { name: 'bound task still active refuses', boundTaskId: undefined, taskStatus: 'review' as const, expectRelease: false },
    { name: 'bound task TERMINAL releases', boundTaskId: undefined, taskStatus: 'failed' as const, expectRelease: true },
    { name: 'bound task MISSING releases', boundTaskId: 'ghost-task', taskStatus: undefined, expectRelease: true },
  ])('resumeAgent on dispatch-failed:ack_unknown: $name', async ({ boundTaskId, taskStatus, expectRelease }) => {
    let taskId = boundTaskId ?? 'ghost-task';
    if (taskStatus) {
      const t = await seedTask({ status: taskStatus });
      taskId = t.id;
    }
    await seedAgent({ id: 'qa-1', taskId, paneId: '%1', status: 'awaiting_human', awaitingPhase: 'dispatch-failed:ack_unknown' });
    await acquireBoundLock('qa-1');

    const result = await manager.resumeAgent('qa-1');

    expect(result).toMatchObject({ resumed: expectRelease, releasedBinding: expectRelease });
    if (!expectRelease) {
      expect(result.reason).toContain('Confirm the uncertain review dispatch');
    }
    const after = await agentStore.get('qa-1');
    if (expectRelease) {
      expect(after?.taskId).toBeUndefined();
      if (taskStatus === 'failed') expect(after?.status).toBeUndefined();
    } else {
      expect(after?.status).toBe('awaiting_human');
      expect(after?.taskId).toBe(taskId);
    }
    expect(await lockManager.isLocked('qa-1')).toBe(!expectRelease);
  });

  it('handleDialogPendingFromRuntime also releases partner agents on task fail (UI Retry path truly opens)', async () => {
    const t = await seedTask({ id: 'task-partner-cleanup', status: 'in_progress', qaAgentId: 'qa-1' });
    await seedAgent({
      id: 'qa-1', taskId: t.id, paneId: '%1',
    });
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
    });
    await acquireBoundLock('qa-1');
    await acquireBoundLock('dev-1');

    const err = new EnsureSessionError(
      { createdSession: false, agentId: 'qa-1', dialogPending: true },
      'runtime dialog',
    );
    await manager.handleDialogPendingFromRuntime('qa-1', err);

    expect((await taskStore.get(t.id))?.status).toBe('failed');
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(false);
    expect((await agentStore.get('qa-1'))?.status).toBe('awaiting_human');
  });

  it('handleDialogPendingFromRuntime fails active task (prompt not injected; UI Retry path opens)', async () => {
    const t = await seedTask({ status: 'in_progress' });
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
    });
    await acquireBoundLock('dev-1');

    const err = new EnsureSessionError(
      { createdSession: false, agentId: 'dev-1', dialogPending: true },
      'runtime dialog',
    );
    const handled = await manager.handleDialogPendingFromRuntime('dev-1', err);

    expect(handled).toBe(true);
    expect((await taskStore.get(t.id))?.status).toBe('failed');
    expect((await agentStore.get('dev-1'))?.status).toBe('awaiting_human');
    expect((await agentStore.get('dev-1'))?.awaitingPhase).toBe('agent_dialog_pending');
    expect(err.partial.handled).toBe(true);
  });

  it('handleDialogPendingFromRuntime task fail SKIPS when outcome moved task past dispatch phase expected status', async () => {
    const t = await seedTask({ id: 'task-outcome-arrived', status: 'approved' });
    await taskStore.set(t);
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
    });
    await acquireBoundLock('dev-1');

    const err = new EnsureSessionError(
      { createdSession: false, agentId: 'dev-1', dialogPending: true },
      'late dialog after outcome',
    );
    const handled = await manager.handleDialogPendingFromRuntime('dev-1', err, { expectedFromStatuses: ['in_progress'] });

    expect(handled).toBe(true);
    expect((await taskStore.get(t.id))?.status).toBe('approved');
    expect((await agentStore.get('dev-1'))?.status).toBe('awaiting_human');
  });

  it('handleDialogPendingFromRuntime task fail WORKS when task still in dispatch expected fromStatus', async () => {
    const t = await seedTask({ id: 'task-still-in-progress', status: 'in_progress' });
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
    });
    await acquireBoundLock('dev-1');

    const err = new EnsureSessionError(
      { createdSession: false, agentId: 'dev-1', dialogPending: true },
      'dialog during in_progress dispatch',
    );
    const handled = await manager.handleDialogPendingFromRuntime('dev-1', err, { expectedFromStatuses: ['in_progress'] });

    expect(handled).toBe(true);
    expect((await taskStore.get(t.id))?.status).toBe('failed');
    expect((await agentStore.get('dev-1'))?.status).toBe('awaiting_human');
  });

  it('handleDialogPendingFromRuntime task fail is serialized via transitionTaskStatus (does not overwrite concurrent terminal)', async () => {
    const t = await seedTask({ id: 'task-already-cancelled', status: 'cancelled' });
    await taskStore.set(t);
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
    });
    await acquireBoundLock('dev-1');

    const err = new EnsureSessionError(
      { createdSession: false, agentId: 'dev-1', dialogPending: true },
      'runtime dialog after cancel',
    );
    const handled = await manager.handleDialogPendingFromRuntime('dev-1', err);

    expect(handled).toBe(true);
    expect((await taskStore.get(t.id))?.status).toBe('cancelled');
    expect((await agentStore.get('dev-1'))?.status).toBe('awaiting_human');
  });

  it('handleDialogPendingFromRuntime: retry path (state empty + createdSession=true) probes tmux paneId and marks awaiting_human', async () => {
    await seedAgent({ id: 'dev-1' });
    const probingRunner: CommandRunner = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes('list-sessions')) {
          return { stdout: '4242|1700000000|$1|dev-1\n', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('list-panes')) {
          return { stdout: '%99 claude\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async () => undefined),
      execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
    };
    (manager as unknown as { runnerFactory: () => CommandRunner }).runnerFactory = () => probingRunner;

    const err = new EnsureSessionError(
      { createdSession: true, agentId: 'dev-1', dialogPending: true },
      'retry path runtime dialog',
    );
    const handled = await manager.handleDialogPendingFromRuntime('dev-1', err);

    expect(handled).toBe(true);
    const state = await agentStore.get('dev-1');
    expect(state?.paneId).toBe('%99');
    expect(state?.status).toBe('awaiting_human');
    expect(state?.awaitingPhase).toBe('agent_dialog_pending');
  });

  it('handleDialogPendingFromRuntime: retry path with tmux probe failure returns false (caller rollbacks)', async () => {
    await seedAgent({ id: 'dev-1' });
    const failingProbeRunner: CommandRunner = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes('list-panes')) {
          return { stdout: '', stderr: 'session not found', exitCode: 1 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async () => undefined),
      execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
    };
    (manager as unknown as { runnerFactory: () => CommandRunner }).runnerFactory = () => failingProbeRunner;

    const err = new EnsureSessionError(
      { createdSession: true, agentId: 'dev-1', dialogPending: true },
      'retry path runtime dialog',
    );
    const handled = await manager.handleDialogPendingFromRuntime('dev-1', err);

    expect(handled).toBe(false);
    const state = await agentStore.get('dev-1');
    expect(state?.status).toBeUndefined();
    expect(state?.paneId).toBeUndefined();
  });

  it('handleDialogPendingFromRuntime retry path: paneId guard rejects writes when fresh agent already has paneId (DELETE+recreate covered)', async () => {
    await seedAgent({ id: 'dev-1', paneId: '%new' });
    const probingRunner: CommandRunner = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes('list-panes')) {
          return { stdout: '%old claude\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async () => undefined),
      execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
    };
    (manager as unknown as { runnerFactory: () => CommandRunner }).runnerFactory = () => probingRunner;

    const err = new EnsureSessionError(
      { createdSession: true, agentId: 'dev-1', dialogPending: true },
      'stale retry runtime dialog',
    );
    const handled = await manager.handleDialogPendingFromRuntime('dev-1', err);

    expect(handled).toBe(true);
    const state = await agentStore.get('dev-1');
    expect(state?.paneId).toBe('%new');
    expect(state?.status).toBe('awaiting_human');
  });

  it('handleDialogPendingFromRuntime: state empty + createdSession=false returns false (no generation evidence available)', async () => {
    await seedAgent({ id: 'dev-1' });

    const err = new EnsureSessionError(
      { createdSession: false, agentId: 'dev-1', dialogPending: true },
      'adopt path runtime dialog',
    );
    const handled = await manager.handleDialogPendingFromRuntime('dev-1', err);

    expect(handled).toBe(false);
    const state = await agentStore.get('dev-1');
    expect(state?.status).toBeUndefined();
  });

  it.each([
    { name: 'noop when binding has shifted to a different task', boundTaskId: 'task-new', expectedTaskId: 'task-old', expectWrite: false },
    { name: 'writes when binding still matches', boundTaskId: 'task-current', expectedTaskId: 'task-current', expectWrite: true },
  ])('markAwaitingHuman with expectedTaskId guard: $name', async ({ boundTaskId, expectedTaskId, expectWrite }) => {
    await seedAgent({ id: 'qa-1', taskId: boundTaskId, paneId: '%0' });

    await manager.markAwaitingHuman('qa-1', 'dispatch-failed:ack_unknown', 'ack_unknown', { expectedTaskId });

    const state = await agentStore.get('qa-1');
    if (expectWrite) {
      expect(state?.status).toBe('awaiting_human');
      expect(state?.awaitingPhase).toBe('dispatch-failed:ack_unknown');
    } else {
      expect(state?.status).toBeUndefined();
      expect(state?.awaitingPhase).toBeUndefined();
      expect(state?.taskId).toBe('task-new');
    }
  });

  it.each([
    { name: 'expectedCreationToken=null noop when token has been set', seededToken: 'tok-recreated', expectedToken: null, reason: 'stale runtime callback', expectWrite: false, checkNoEmit: false },
    { name: 'noop on token mismatch', seededToken: 'tok-new', expectedToken: 'tok-old', reason: 'stale token holder', expectWrite: false, checkNoEmit: true },
    { name: 'writes on token match', seededToken: 'tok-match', expectedToken: 'tok-match', reason: 'good', expectWrite: true, checkNoEmit: false },
  ])('markAwaitingHuman with expectedCreationToken: $name (DELETE+recreate race)', async ({ seededToken, expectedToken, reason, expectWrite, checkNoEmit }) => {
    await seedAgent({ id: 'dev-1', creationToken: seededToken });

    await manager.markAwaitingHuman('dev-1', 'agent_dialog_pending', reason, { expectedCreationToken: expectedToken });

    const state = await agentStore.get('dev-1');
    if (expectWrite) {
      expect(state?.status).toBe('awaiting_human');
    } else {
      expect(state?.status).toBeUndefined();
      expect(state?.awaitingPhase).toBeUndefined();
    }
    if (checkNoEmit) {
      const emitted = events.filter(
        e => e.type === 'human.intervention' && (e.data as { phase?: string }).phase === 'agent_dialog_pending',
      );
      expect(emitted).toHaveLength(0);
    }
  });

  it('releaseAgentForTask refuses to release when status=awaiting_human (no allowAwaitingHuman opt)', async () => {
    const t = await seedTask();
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed',
    });
    await acquireBoundLock('dev-1');

    const ok = await manager.releaseAgentForTask('dev-1', t.id, 'idle');

    expect(ok).toBe(false);
    expect((await agentStore.get('dev-1'))?.status).toBe('awaiting_human');
    expect((await agentStore.get('dev-1'))?.taskId).toBe(t.id);
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  it('canDispatchWithBinding rejects awaiting_human agent even if taskId cleared', async () => {
    expect(canDispatchWithBinding({
      id: 'dev-1', projectId: 'proj', updatedAt: NOW, status: 'awaiting_human',
    })).toBe(false);
    expect(canDispatchWithBinding({
      id: 'dev-1', projectId: 'proj', updatedAt: NOW, status: 'ok',
    })).toBe(true);
    expect(canDispatchWithBinding({
      id: 'dev-1', projectId: 'proj', updatedAt: NOW,
    })).toBe(true);
  });

  it('canDispatchWithBinding rejects same-task reentry when awaiting_human (cannot bypass via reentry phase)', async () => {
    await seedTask({ id: 'task-reentry-block' });
    await seedAgent({
      id: 'dev-1', taskId: 'task-reentry-block', paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed',
    });
    await acquireBoundLock('dev-1');

    const ok = await manager.acquireAgentForTask('dev-1', 'task-reentry-block', 'fix');
    expect(ok).toBe(false);
  });
});

function ackInterventions(): BaxianEvent[] {
  return events.filter(
    e => e.type === 'human.intervention' && (e.data as { phase?: string }).phase === 'dispatch-ack-timeout',
  );
}

type SnapRunner = CommandRunner & { sawEnter: () => boolean };
function snapRunner(
  frame: (enterSent: boolean) => string,
  scrollback: (enterSent: boolean) => number = () => 0,
): SnapRunner {
  let enterSent = false;
  return {
    exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
      if (cmd.includes('send-keys') && cmd.includes('Enter')) {
        enterSent = true;
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('history_size')) {
        return { stdout: `BX_PANE_OK|${scrollback(enterSent)}\n${frame(enterSent)}`, stderr: '', exitCode: 0 };
      }
      if (cmd.includes('capture-pane')) {
        return { stdout: 'BX_PANE_OK\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    }),
    writeFile: vi.fn(async (): Promise<void> => undefined),
    execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
    sawEnter: () => enterSent,
  } as unknown as SnapRunner;
}

async function runAck(
  runner: CommandRunner,
  opts: { ackMs: number; settleMs: number; prompt?: string; lock?: boolean } = { ackMs: 150, settleMs: 150 },
): Promise<{ result?: AckResult; caught?: unknown; taskId: string }> {
  const localManager = makeInjectManager(runner, opts.ackMs, opts.settleMs);
  const t = await seedTask();
  await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
  if (opts.lock !== false) await acquireBoundLock('dev-1');
  const tmux = new TmuxManager(runner);
  try {
    const result = await callInjectAndAwaitAck(localManager, tmux, '%0', opts.prompt ?? 'hello prompt', 'dev-1', 'claude-code');
    return { result, taskId: t.id };
  } catch (caught) {
    return { caught, taskId: t.id };
  }
}

describe('injectAndAwaitAck pre-paste generation guard', () => {
  it('aborts between the pane mutex and the paste when the replay generation moved on', async () => {
    const localManager = makeInjectManager(readyRunner(), 150, 150);
    const t = await seedTask();
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await acquireBoundLock('dev-1');
    const injectSpy = vi.spyOn(TmuxManager.prototype, 'injectPrompt').mockResolvedValue(undefined);
    const guard = vi.fn<[], Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);

    const result = await callInjectAndAwaitAck(
      localManager, new TmuxManager(readyRunner()), '%0', 'prompt', 'dev-1', 'claude-code', guard,
    );

    expect(result).toEqual({ acked: false, composerDelivered: false, aborted: true });
    expect(injectSpy).not.toHaveBeenCalled();
    expect(guard).toHaveBeenCalledTimes(2);
  });

  it('re-checks the fence inside the paste and never issues the remote paste command', async () => {
    const runner = readyRunner();
    const localManager = makeInjectManager(runner, 150, 150);
    const t = await seedTask();
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await acquireBoundLock('dev-1');
    const guard = vi.fn<[], Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);

    const result = await callInjectAndAwaitAck(
      localManager, new TmuxManager(runner), '%0', 'prompt', 'dev-1', 'claude-code', guard,
    );

    expect(result).toEqual({ acked: false, composerDelivered: false, aborted: true });
    const cmds = (runner.exec as ReturnType<typeof vi.fn>).mock.calls.map(call => String(call[0]));
    expect(cmds.some(cmd => cmd.includes('paste-buffer'))).toBe(false);
    expect(guard).toHaveBeenCalledTimes(3);
  });

  it('a rotation landing during the staging exec aborts before the paste ever starts', async () => {
    const t = await seedTask({ signalToken: 'stage-T1' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await acquireBoundLock('dev-1');
    const base = readyRunner();
    const runner = {
      ...base,
      execWithStdin: vi.fn(async (cmd: string, stdin: Buffer) => {
        if (cmd.includes('load-buffer')) {
          const fresh = await taskStore.get(t.id);
          await taskStore.set({ ...fresh!, signalToken: 'stage-T2' });
        }
        return (base.execWithStdin as (cmd: string, stdin: Buffer) => Promise<ExecResult>)(cmd, stdin);
      }),
    } as unknown as CommandRunner;
    const localManager = makeInjectManager(runner, 150, 150);
    const guard = async (): Promise<boolean> =>
      (await taskStore.get(t.id))?.signalToken === 'stage-T1';

    const result = await callInjectAndAwaitAck(
      localManager, new TmuxManager(runner), '%0', 'prompt', 'dev-1', 'claude-code', guard,
    );

    expect(result).toEqual({ acked: false, composerDelivered: false, aborted: true });
    const cmds = (runner.exec as ReturnType<typeof vi.fn>).mock.calls.map(call => String(call[0]));
    expect(cmds.some(cmd => cmd.includes('paste-buffer'))).toBe(false);
  });

  it('serializes the final fence and the paste against task mutations', async () => {
    const t = await seedTask({ signalToken: 'lock-T1' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await acquireBoundLock('dev-1');
    let releasePaste!: () => void;
    const pasteGate = new Promise<void>((resolve) => { releasePaste = resolve; });
    const base = readyRunner();
    const runner = {
      ...base,
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes('paste-buffer')) await pasteGate;
        return (base.exec as (cmd: string) => Promise<ExecResult>)(cmd);
      }),
    } as unknown as CommandRunner;
    const localManager = makeInjectManager(runner, 150, 150);
    const guard = async (): Promise<boolean> =>
      (await taskStore.get(t.id))?.signalToken === 'lock-T1';

    const ackPromise = callInjectAndAwaitAck(
      localManager, new TmuxManager(runner), '%0', 'prompt', 'dev-1', 'claude-code', guard,
    );
    const pasteStarted = (): boolean =>
      (runner.exec as ReturnType<typeof vi.fn>).mock.calls.some(call => String(call[0]).includes('paste-buffer'));
    for (let i = 0; i < 400 && !pasteStarted(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(pasteStarted()).toBe(true);

    let rotated = false;
    const rotatePromise = localManager
      .updateTask(t.id, { signalToken: 'lock-T2' })
      .then(() => { rotated = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(rotated).toBe(false);

    releasePaste();
    const result = await ackPromise;
    await rotatePromise;

    expect(rotated).toBe(true);
    expect((await taskStore.get(t.id))?.signalToken).toBe('lock-T2');
    // The queued rotation lands right after the paste slot, so the Enter fence
    // catches it and the submission is aborted instead of committing stale T1.
    expect(result).toEqual({ acked: false, composerDelivered: false, aborted: true });
    const cmds = (runner.exec as ReturnType<typeof vi.fn>).mock.calls.map(call => String(call[0]));
    expect(cmds.some(cmd => cmd.includes('send-keys') && cmd.includes('Enter'))).toBe(false);
  });

  it('cleans up the staged buffer when the paste exec fails', async () => {
    const t = await seedTask({ signalToken: 'fail-T1' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await acquireBoundLock('dev-1');
    const base = readyRunner();
    const runner = {
      ...base,
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes('paste-buffer')) return { stdout: '', stderr: 'pane vanished', exitCode: 1 };
        return (base.exec as (cmd: string) => Promise<ExecResult>)(cmd);
      }),
    } as unknown as CommandRunner;
    const localManager = makeInjectManager(runner, 150, 150);

    await expect(callInjectAndAwaitAck(
      localManager, new TmuxManager(runner), '%0', 'prompt', 'dev-1', 'claude-code', async () => true,
    )).rejects.toThrow(/pane vanished/);
    const cmds = (runner.exec as ReturnType<typeof vi.fn>).mock.calls.map(call => String(call[0]));
    expect(cmds.some(cmd => cmd.includes('delete-buffer'))).toBe(true);
  });

  it('cleans up the staged buffer when the paste transport dies with an unknown outcome', async () => {
    const t = await seedTask({ signalToken: 'lost-T1' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await acquireBoundLock('dev-1');
    const base = readyRunner();
    const runner = {
      ...base,
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes('paste-buffer')) throw new Error('ssh transport lost');
        return (base.exec as (cmd: string) => Promise<ExecResult>)(cmd);
      }),
    } as unknown as CommandRunner;
    const localManager = makeInjectManager(runner, 150, 150);

    await expect(callInjectAndAwaitAck(
      localManager, new TmuxManager(runner), '%0', 'prompt', 'dev-1', 'claude-code', async () => true,
    )).rejects.toThrow(/ssh transport lost/);
    const cmds = (runner.exec as ReturnType<typeof vi.fn>).mock.calls.map(call => String(call[0]));
    expect(cmds.some(cmd => cmd.includes('delete-buffer'))).toBe(true);
  });

  it('reconciles a consumed buffer after an unknown paste outcome by scrubbing the composer', async () => {
    const t = await seedTask({ signalToken: 'unknown-T1' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await acquireBoundLock('dev-1');
    const base = readyRunner();
    const runner = {
      ...base,
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes('paste-buffer')) throw new Error('ssh reply lost');
        if (cmd.includes('delete-buffer')) return { stdout: '', stderr: 'no buffer', exitCode: 1 };
        return (base.exec as (cmd: string) => Promise<ExecResult>)(cmd);
      }),
    } as unknown as CommandRunner;
    const localManager = makeInjectManager(runner, 150, 150);

    await expect(callInjectAndAwaitAck(
      localManager, new TmuxManager(runner), '%0', 'prompt', 'dev-1', 'claude-code', async () => true,
    )).rejects.toThrow(/ssh reply lost/);
    const cmds = (runner.exec as ReturnType<typeof vi.fn>).mock.calls.map(call => String(call[0]));
    const composerScrubs = cmds.filter(cmd => cmd.includes('send-keys') && cmd.includes('C-c'));
    expect(composerScrubs.length).toBeGreaterThanOrEqual(2);
  });

  it('ack resends re-check the fence and never re-submit a rotated composer', async () => {
    const t = await seedTask({ signalToken: 'resend-T1' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await acquireBoundLock('dev-1');
    const base = readyRunner();
    const runner = {
      ...base,
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes('send-keys') && cmd.includes('Enter')) {
          const fresh = await taskStore.get(t.id);
          await taskStore.set({ ...fresh!, signalToken: 'resend-T2' });
        }
        return (base.exec as (cmd: string) => Promise<ExecResult>)(cmd);
      }),
    } as unknown as CommandRunner;
    const localManager = makeInjectManager(runner, 400, 150);
    Object.assign(localManager, { dispatchAckResendIntervalMs: 30 });
    const guard = async (): Promise<boolean> =>
      (await taskStore.get(t.id))?.signalToken === 'resend-T1';

    const result = await callInjectAndAwaitAck(
      localManager, new TmuxManager(runner), '%0', 'prompt', 'dev-1', 'claude-code', guard,
    );

    expect(result).toEqual({ acked: false, composerDelivered: false, aborted: true });
    const cmds = (runner.exec as ReturnType<typeof vi.fn>).mock.calls.map(call => String(call[0]));
    const enterSends = cmds.filter(cmd => cmd.includes('send-keys') && cmd.includes('Enter'));
    expect(enterSends).toHaveLength(1);
    const composerScrubs = cmds.filter(cmd => cmd.includes('send-keys') && cmd.includes('C-c'));
    expect(composerScrubs.length).toBeGreaterThanOrEqual(2);
  });

  it('escalates when the stale composer cannot be scrubbed after a fence-rejected Enter', async () => {
    const t = await seedTask({ signalToken: 'scrub-T1' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await acquireBoundLock('dev-1');
    let pasted = false;
    let releaseSnapshot!: () => void;
    const snapGate = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
    const base = readyRunner();
    const runner = {
      ...base,
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes('paste-buffer')) pasted = true;
        if (pasted && cmd.includes('history_size')) await snapGate;
        if (pasted && cmd.includes('send-keys') && cmd.includes('C-c')) {
          return { stdout: '', stderr: 'pane is gone', exitCode: 1 };
        }
        return (base.exec as (cmd: string) => Promise<ExecResult>)(cmd);
      }),
    } as unknown as CommandRunner;
    const localManager = makeInjectManager(runner, 150, 150);
    const guard = async (): Promise<boolean> =>
      (await taskStore.get(t.id))?.signalToken === 'scrub-T1';

    const ackPromise = callInjectAndAwaitAck(
      localManager, new TmuxManager(runner), '%0', 'prompt', 'dev-1', 'claude-code', guard,
    );
    for (let i = 0; i < 400 && !pasted; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(pasted).toBe(true);
    await localManager.updateTask(t.id, { signalToken: 'scrub-T2' });
    releaseSnapshot();

    await expect(ackPromise).rejects.toThrow(/composer/);
  });

  it('aborts before Enter when the pass rotates after the paste', async () => {
    const t = await seedTask({ signalToken: 'enter-T1' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await acquireBoundLock('dev-1');
    let pasted = false;
    let releaseSnapshot!: () => void;
    const snapGate = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
    const base = readyRunner();
    const runner = {
      ...base,
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes('paste-buffer')) pasted = true;
        if (pasted && cmd.includes('history_size')) await snapGate;
        return (base.exec as (cmd: string) => Promise<ExecResult>)(cmd);
      }),
    } as unknown as CommandRunner;
    const localManager = makeInjectManager(runner, 150, 150);
    const guard = async (): Promise<boolean> =>
      (await taskStore.get(t.id))?.signalToken === 'enter-T1';

    const ackPromise = callInjectAndAwaitAck(
      localManager, new TmuxManager(runner), '%0', 'prompt', 'dev-1', 'claude-code', guard,
    );
    for (let i = 0; i < 400 && !pasted; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(pasted).toBe(true);
    await localManager.updateTask(t.id, { signalToken: 'enter-T2' });
    releaseSnapshot();

    const result = await ackPromise;
    expect(result).toEqual({ acked: false, composerDelivered: false, aborted: true });
    const cmds = (runner.exec as ReturnType<typeof vi.fn>).mock.calls.map(call => String(call[0]));
    expect(cmds.some(cmd => cmd.includes('send-keys') && cmd.includes('Enter'))).toBe(false);
  });
});

describe('injectAndAwaitAck ack timeout', () => {
  it('emits human.intervention dispatch-ack-timeout, does not throw, does not send C-c after submit', async () => {
    const sentCommands: string[] = [];
    const stuckRunner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        sentCommands.push(cmd);
        if (cmd.includes('capture-pane')) {
          const header = cmd.includes('history_size') ? 'BX_PANE_OK|42' : 'BX_PANE_OK';
          return { stdout: `${header}\nstuck-screen\n`, stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
      execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
    };
    const localManager = makeManager({
      skillRegistry: freshRegistry(),
      runnerFactory: () => stuckRunner,
      dispatchAckTimeoutMs: 50,
    });

    const t = await seedTask();
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await acquireBoundLock('dev-1');

    const tmux = new TmuxManager(stuckRunner);

    await expect(
      callInjectAndAwaitAck(localManager, tmux, '%0', 'hello prompt', 'dev-1', 'claude-code'),
    ).resolves.toEqual({ acked: false, composerDelivered: true });

    const interventions = ackInterventions();
    expect(interventions).toHaveLength(1);
    expect(interventions[0]).toMatchObject({
      type: 'human.intervention',
      projectId: 'proj',
      agentId: 'dev-1',
      taskId: t.id,
    });
    expect((interventions[0].data as { paneId?: string }).paneId).toBe('%0');

    const firstEnterIdx = sentCommands.findIndex(c => c.includes('send-keys') && c.includes('Enter'));
    expect(firstEnterIdx).toBeGreaterThanOrEqual(0);
    const postSubmitCc = sentCommands.slice(firstEnterIdx).filter(c => c.includes('send-keys') && c.includes('C-c'));
    expect(postSubmitCc).toHaveLength(0);

    expect((await taskStore.get(t.id))?.status).toBe('in_progress');
    expect((await agentStore.get('dev-1'))?.taskId).toBe(t.id);
    expect(await lockManager.isLocked('dev-1')).toBe(true);

    const ackTimeoutEvent = interventions[0];
    expect((ackTimeoutEvent.data as { note?: string }).note).toMatch(/REPL did not acknowledge/);
  });

  it('injectAndAwaitAck re-sends Enter when the first is swallowed, then acks', async () => {
    let enterCount = 0;
    const flakyRunner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('send-keys') && cmd.includes('Enter')) {
          enterCount++;
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('capture-pane')) {
          const visible = enterCount >= 2 ? 'working\n  esc to interrupt\n' : 'idle composer\n';
          const header = cmd.includes('history_size') ? 'BX_PANE_OK|0' : 'BX_PANE_OK';
          return { stdout: `${header}\n${visible}`, stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
      execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
    };
    const localManager = makeInjectManager(flakyRunner, 3000, 10);
    (localManager as unknown as { dispatchAckResendIntervalMs: number }).dispatchAckResendIntervalMs = 50;
    const tmux = new TmuxManager(flakyRunner);

    const result = await callInjectAndAwaitAck(localManager, tmux, '%0', 'hello prompt', 'dev-1', 'claude-code');

    expect(result).toEqual({ acked: true, composerDelivered: true });
    expect(enterCount).toBeGreaterThanOrEqual(2);
  });

  it('infrastructure failure during the post-Enter ack wait throws DispatchTerminalError, not human.intervention', async () => {
    let enterSent = false;
    const failingRunner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('send-keys') && cmd.includes('Enter')) {
          enterSent = true;
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('capture-pane')) {
          if (!enterSent) {
            const header = cmd.includes('history_size') ? 'BX_PANE_OK|10' : 'BX_PANE_OK';
            return { stdout: `${header}\nidle\n`, stderr: '', exitCode: 0 };
          }
          return { stdout: '', stderr: 'no such pane: %0', exitCode: 1 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
      execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
    };
    const { caught } = await runAck(failingRunner, { ackMs: 50, settleMs: 200, lock: false });
    expect(caught).toBeInstanceOf(DispatchTerminalError);
    expect(ackInterventions()).toHaveLength(0);
  });
});

describe('injectAndAwaitAck settles the pane before Enter', () => {
  it('settles the pane before Enter, then acks on submission evidence (idle→busy) after Enter', async () => {
    const order: string[] = [];
    const preEnter = [
      'box: read /img.png\n',
      'box: [Image #1]\n',
      'box: [Image #1]\n',
    ];
    let enterSent = false;
    let snap = 0;
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('send-keys') && cmd.includes('Enter')) {
          enterSent = true;
          order.push('enter');
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('history_size')) {
          order.push(enterSent ? 'snap-post' : 'snap-pre');
          const visible = enterSent
            ? 'box: [Image #1]\nThinking\n  esc to interrupt\n'
            : preEnter[Math.min(snap++, preEnter.length - 1)];
          return { stdout: `BX_PANE_OK|0\n${visible}`, stderr: '', exitCode: 0 };
        }
        if (cmd.includes('capture-pane')) {
          return { stdout: 'BX_PANE_OK\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
      execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
    };
    const { result } = await runAck(runner, { ackMs: 2000, settleMs: 2000 });

    expect(result).toEqual({ acked: true, composerDelivered: true });
    const enterIdx = order.indexOf('enter');
    expect(enterIdx).toBeGreaterThan(-1);
    const settleSnapsBeforeEnter = order.slice(0, enterIdx).filter(x => x === 'snap-pre').length;
    expect(settleSnapsBeforeEnter).toBeGreaterThanOrEqual(2);
    expect(order.indexOf('snap-post')).toBeGreaterThan(enterIdx);
  });
});

describe('injectAndAwaitAck never-settle + swallowed Enter is non-ackable', () => {
  it('does NOT false-ack from redraw deltas when the runtime never goes busy', async () => {
    let n = 0;
    let enterSent = false;
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('send-keys') && cmd.includes('Enter')) {
          enterSent = true;
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('history_size')) {
          return { stdout: `BX_PANE_OK|0\nframe ${n++}\n`, stderr: '', exitCode: 0 };
        }
        if (cmd.includes('capture-pane')) {
          return { stdout: `BX_PANE_OK\ncomposer still open ${n++}\n[Image #1] attaching\n`, stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
      execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
    };
    const { result, taskId } = await runAck(runner, { ackMs: 60, settleMs: 60 });

    expect(result).toEqual({ acked: false, composerDelivered: true });
    expect(enterSent).toBe(true);
    expect(ackInterventions()).toHaveLength(1);
    expect((await taskStore.get(taskId))?.status).toBe('in_progress');
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });
});

describe('injectAndAwaitAck post-approve edge cases', () => {
  it('acks a quick task on its brief idle-to-busy flash after Enter', async () => {
    const runner = snapRunner(enterSent => (enterSent ? 'working\n  esc to interrupt\n' : 'composer\n'), () => 5);
    const { result } = await runAck(runner, { ackMs: 1000, settleMs: 1000 });
    expect(result).toEqual({ acked: true, composerDelivered: true });
    expect(runner.sawEnter()).toBe(true);
  });

  it('does NOT ack on scrollback growth from an uncommitted attach redraw when runtime never gets busy', async () => {
    let h = 5;
    const runner = snapRunner(() => 'composer still open\n', enterSent => (enterSent ? ++h : h));
    const { result } = await runAck(runner, { ackMs: 150, settleMs: 80 });
    expect(result).toEqual({ acked: false, composerDelivered: true });
    expect(runner.sawEnter()).toBe(true);
    expect(ackInterventions()).toHaveLength(1);
  });

  it('a failed sendEnter is raw cleanup, not ack_unknown', async () => {
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('send-keys') && cmd.includes('Enter')) {
          return { stdout: '', stderr: 'no such pane: %0', exitCode: 1 };
        }
        if (cmd.includes('history_size')) {
          return { stdout: 'BX_PANE_OK|5\nidle\n', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('capture-pane')) {
          return { stdout: 'BX_PANE_OK\nidle\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
      execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
    };
    const { caught } = await runAck(runner, { ackMs: 100, settleMs: 100 });
    expect(caught).toBeInstanceOf(Error);
    expect(caught instanceof DispatchTerminalError && caught.reason === 'ack_unknown').toBe(false);
  });

  it('does NOT ack on busy text that was already in the pasted prompt when Enter is swallowed', async () => {
    const screen = `do X\n  esc to interrupt\n`;
    let pasted = false;
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('paste-buffer')) {
          pasted = true;
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('history_size')) {
          return { stdout: `BX_PANE_OK|3\n${pasted ? screen : '❯ \n'}`, stderr: '', exitCode: 0 };
        }
        if (cmd.includes('capture-pane')) {
          return { stdout: `BX_PANE_OK\n${pasted ? screen : '❯ \n'}`, stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
      execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
    };
    const { result } = await runAck(runner, { ackMs: 150, settleMs: 150, prompt: 'do X\n  esc to interrupt' });
    expect(result).toEqual({ acked: false, composerDelivered: false });
    expect(ackInterventions()).toHaveLength(1);
  });

  it('a pre-Enter settle/capture failure is not ack_unknown and never sends Enter', async () => {
    const sent: string[] = [];
    let snaps = 0;
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        sent.push(cmd);
        if (cmd.includes('history_size')) {
          snaps++;
          if (snaps === 1) return { stdout: 'BX_PANE_OK|1\ncomposer\n', stderr: '', exitCode: 0 };
          return { stdout: '', stderr: 'no such pane: %0', exitCode: 1 };
        }
        if (cmd.includes('capture-pane')) {
          return { stdout: 'BX_PANE_OK\ncomposer\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
      execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
    };
    const { caught } = await runAck(runner, { ackMs: 150, settleMs: 150 });
    expect(caught).toBeInstanceOf(Error);
    expect(caught instanceof DispatchTerminalError && caught.reason === 'ack_unknown').toBe(false);
    const enterCmds = sent.filter(c => c.includes('send-keys') && c.includes('Enter'));
    expect(enterCmds).toHaveLength(0);
  });
});

describe('injectAndAwaitAck makes the pane reuse-safe on pre-Enter failure', () => {
  const ccCmds = (sent: string[]): string[] =>
    sent.filter(c => c.includes('send-keys') && c.includes('C-c'));
  const hasSessionCmds = (sent: string[]): string[] =>
    sent.filter(c => c.includes('has-session'));

  function recordRunner(sent: string[], respond: (cmd: string) => ExecResult | undefined): CommandRunner {
    return {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        sent.push(cmd);
        return respond(cmd) ?? { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
      execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
    } as unknown as CommandRunner;
  }

  it('clears the composer draft after a pre-Enter capture failure → raw, never Enter, no kill probe', async () => {
    const sent: string[] = [];
    let snaps = 0;
    const runner = recordRunner(sent, cmd => {
      if (cmd.includes('history_size')) {
        snaps++;
        if (snaps === 1) return { stdout: 'BX_PANE_OK|1\ncomposer\n', stderr: '', exitCode: 0 };
        return { stdout: '', stderr: 'no such pane: %0', exitCode: 1 };
      }
      if (cmd.includes('capture-pane')) {
        return { stdout: 'BX_PANE_OK\ncomposer\n', stderr: '', exitCode: 0 };
      }
      return undefined;
    });
    const { caught } = await runAck(runner);
    expect(caught).toBeInstanceOf(Error);
    expect(caught instanceof DispatchTerminalError && caught.reason === 'ack_unknown').toBe(false);
    expect(ccCmds(sent)).toHaveLength(2);
    expect(hasSessionCmds(sent)).toHaveLength(0);
    expect(sent.filter(c => c.includes('send-keys') && c.includes('Enter'))).toHaveLength(0);
  });

  it.each([
    {
      name: 'clears the composer draft after a failed sendEnter → raw',
      onHasSession: undefined as ExecResult | undefined,
      failKeys: 'enter' as 'enter' | 'all',
      sendKeys: { stdout: '', stderr: 'no such pane: %0', exitCode: 1 },
      expectAckUnknown: false,
      expectCc: 2,
      hasSessionCount: undefined as number | undefined,
    },
    {
      name: 'a transient reuse-clear failure on a still-live session escalates to ack_unknown (no blind C-c)',
      onHasSession: { stdout: '', stderr: '', exitCode: 0 },
      failKeys: 'after-preclear' as 'enter' | 'after-preclear',
      sendKeys: { stdout: '', stderr: 'ssh: connect: connection timed out', exitCode: 1 },
      expectAckUnknown: true,
      expectCc: 1,
      hasSessionCount: 1,
    },
    {
      name: 'a reuse-clear failure on a CONFIRMED-DEAD session is reuse-safe → raw (next dispatch rebuilds fresh)',
      onHasSession: { stdout: '', stderr: "can't find session: dev-1", exitCode: 1 },
      failKeys: 'after-preclear' as 'enter' | 'after-preclear',
      sendKeys: { stdout: '', stderr: 'no such pane: %0', exitCode: 1 },
      expectAckUnknown: false,
      expectCc: 1,
      hasSessionCount: 1,
    },
    {
      name: 'an UNCONFIRMABLE session (reuse clear fails AND has-session probe fails) escalates to ack_unknown',
      onHasSession: { stdout: '', stderr: 'ssh: connect: connection timed out', exitCode: 2 },
      failKeys: 'after-preclear' as 'enter' | 'after-preclear',
      sendKeys: { stdout: '', stderr: 'ssh: connect: connection timed out', exitCode: 1 },
      expectAckUnknown: true,
      expectCc: 1,
      hasSessionCount: 1,
    },
  ])('$name', async ({ onHasSession, failKeys, sendKeys, expectAckUnknown, expectCc, hasSessionCount }) => {
    const sent: string[] = [];
    let sendKeysSeen = 0;
    const runner = recordRunner(sent, cmd => {
      if (cmd.includes('has-session')) return onHasSession;
      if (cmd.includes('send-keys')) {
        sendKeysSeen++;
        const preClearDone = sendKeysSeen > 2;
        if (failKeys === 'after-preclear' ? preClearDone : cmd.includes('Enter')) return sendKeys;
      }
      if (cmd.includes('history_size')) return { stdout: 'BX_PANE_OK|5\nidle\n', stderr: '', exitCode: 0 };
      if (cmd.includes('capture-pane')) return { stdout: 'BX_PANE_OK\nidle\n', stderr: '', exitCode: 0 };
      return undefined;
    });
    const { caught } = await runAck(runner);
    if (expectAckUnknown) {
      expect(caught).toBeInstanceOf(DispatchTerminalError);
      expect((caught as DispatchTerminalError).reason).toBe('ack_unknown');
    } else {
      expect(caught).toBeInstanceOf(Error);
      expect(caught instanceof DispatchTerminalError && caught.reason === 'ack_unknown').toBe(false);
    }
    expect(ccCmds(sent)).toHaveLength(expectCc);
    if (hasSessionCount !== undefined) expect(hasSessionCmds(sent)).toHaveLength(hasSessionCount);
  });

  it('does NOT touch the composer on a post-Enter ack_unknown — the prompt may be running', async () => {
    const sent: string[] = [];
    let enterSent = false;
    let enterIdx = -1;
    const runner = recordRunner(sent, cmd => {
      if (cmd.includes('send-keys') && cmd.includes('Enter')) {
        enterSent = true;
        enterIdx = sent.length - 1;
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('capture-pane') || cmd.includes('display-message')) {
        if (!enterSent) {
          const header = cmd.includes('history_size') ? 'BX_PANE_OK|10' : 'BX_PANE_OK';
          return { stdout: `${header}\nidle\n`, stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: 'no such pane: %0', exitCode: 1 };
      }
      return undefined;
    });
    const { caught } = await runAck(runner);
    expect(caught).toBeInstanceOf(DispatchTerminalError);
    expect((caught as DispatchTerminalError).reason).toBe('ack_unknown');
    expect(enterIdx).toBeGreaterThanOrEqual(0);
    expect(ccCmds(sent.slice(enterIdx))).toHaveLength(0);
    expect(hasSessionCmds(sent)).toHaveLength(0);
  });

  it('does NOT touch the composer on a clean ack', async () => {
    const sent: string[] = [];
    let enterSent = false;
    let enterIdx = -1;
    const runner = recordRunner(sent, cmd => {
      if (cmd.includes('send-keys') && cmd.includes('Enter')) {
        enterSent = true;
        enterIdx = sent.length - 1;
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('history_size')) {
        const visible = enterSent ? 'working\n  esc to interrupt\n' : 'composer\n';
        return { stdout: `BX_PANE_OK|5\n${visible}`, stderr: '', exitCode: 0 };
      }
      if (cmd.includes('capture-pane')) {
        return { stdout: 'BX_PANE_OK\ncomposer\n', stderr: '', exitCode: 0 };
      }
      return undefined;
    });
    const { result } = await runAck(runner);
    expect(result).toEqual({ acked: true, composerDelivered: true });
    expect(enterIdx).toBeGreaterThanOrEqual(0);
    expect(ccCmds(sent.slice(enterIdx))).toHaveLength(0);
    expect(hasSessionCmds(sent)).toHaveLength(0);
  });

  it('clears any leftover composer draft (space then C-c) before pasting the prompt', async () => {
    const sent: string[] = [];
    let enterSent = false;
    const runner = recordRunner(sent, cmd => {
      if (cmd.includes('send-keys') && cmd.includes('Enter')) {
        enterSent = true;
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('history_size')) {
        const visible = enterSent ? 'working\n  esc to interrupt\n' : 'composer\n';
        return { stdout: `BX_PANE_OK|5\n${visible}`, stderr: '', exitCode: 0 };
      }
      if (cmd.includes('capture-pane')) {
        return { stdout: 'BX_PANE_OK\ncomposer\n', stderr: '', exitCode: 0 };
      }
      return undefined;
    });
    const { result } = await runAck(runner);
    expect(result).toEqual({ acked: true, composerDelivered: true });
    const spaceIdx = sent.findIndex(c => c.includes('send-keys -l'));
    const ccIdx = sent.findIndex(c => c.includes('send-keys') && c.includes('C-c'));
    const pasteIdx = sent.findIndex(c => c.includes('paste-buffer'));
    expect(spaceIdx).toBeGreaterThanOrEqual(0);
    expect(ccIdx).toBeGreaterThan(spaceIdx);
    expect(pasteIdx).toBeGreaterThan(ccIdx);
  });

  it('aborts the dispatch without pasting when the pre-inject composer clear fails (unconfirmed clear must not paste onto a leftover draft)', async () => {
    const sent: string[] = [];
    let pasted = false;
    const runner = recordRunner(sent, cmd => {
      if (cmd.includes('send-keys -l')) {
        return { stdout: '', stderr: 'ssh: connect: connection timed out', exitCode: 1 };
      }
      if (cmd.includes('paste-buffer')) {
        pasted = true;
        return undefined;
      }
      if (cmd.includes('capture-pane')) {
        return { stdout: 'BX_PANE_OK\ncomposer\n', stderr: '', exitCode: 0 };
      }
      return undefined;
    });
    const { caught } = await runAck(runner);
    expect(caught).toBeInstanceOf(Error);
    expect(String((caught as Error).message)).toMatch(/guarded write/);
    expect(pasted).toBe(false);
    expect(sent.filter(c => c.includes('send-keys') && c.includes('Enter'))).toHaveLength(0);
  });

  it('a visible ready view overrides a stale working title: the draft is still cleared and the prompt pasted', async () => {
    const sent: string[] = [];
    let pasted = false;
    let enterSent = false;
    const runner = recordRunner(sent, cmd => {
      if (cmd.includes('pane_title')) {
        return { stdout: 'BX_PANE_OK⠹ Grooving…\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('capture-pane') && !cmd.includes('history_size')) {
        return { stdout: 'BX_PANE_OK\n❯ \n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('history_size')) {
        const visible = enterSent ? 'working\n  esc to interrupt\n' : '❯ \n';
        return { stdout: `BX_PANE_OK|5\n${visible}`, stderr: '', exitCode: 0 };
      }
      if (cmd.includes('paste-buffer')) {
        pasted = true;
        return undefined;
      }
      if (cmd.includes('send-keys') && cmd.includes('Enter')) {
        enterSent = true;
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return undefined;
    });
    await runAck(runner);
    expect(pasted).toBe(true);
    expect(sent.filter(c => c.includes('send-keys -l'))).toHaveLength(1);
    expect(ccCmds(sent)).toHaveLength(1);
  });

  it('aborts without pasting when only the OSC title shows working and no ready view is visible (narrow pane wraps the busy line)', async () => {
    const sent: string[] = [];
    let pasted = false;
    let captures = 0;
    const runner = recordRunner(sent, cmd => {
      if (cmd.includes('pane_title')) {
        return { stdout: 'BX_PANE_OK⠹ Grooving…\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('capture-pane') && !cmd.includes('history_size')) {
        captures++;
        return { stdout: `BX_PANE_OK\nsoft-wrapped output without any anchor line ${captures}\n`, stderr: '', exitCode: 0 };
      }
      if (cmd.includes('paste-buffer')) {
        pasted = true;
        return undefined;
      }
      return undefined;
    });
    const { caught } = await runAck(runner);
    expect(caught).toBeInstanceOf(Error);
    expect(String((caught as Error).message)).toMatch(/pre-inject busy check/);
    expect(pasted).toBe(false);
    expect(ccCmds(sent)).toHaveLength(0);
  });

  it('clears a busy-looking leftover draft even under a stale working title when the frame is static (no live turn)', async () => {
    const sent: string[] = [];
    let pasted = false;
    let enterSent = false;
    const DRAFT = '› 排查 codex 卡死，日志：\n  • Working (12s)\n  esc to interrupt\n';
    const runner = recordRunner(sent, cmd => {
      if (cmd.includes('pane_title')) {
        return { stdout: 'BX_PANE_OK⠹ Grooving…\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('capture-pane') && !cmd.includes('history_size')) {
        return { stdout: `BX_PANE_OK\n${DRAFT}`, stderr: '', exitCode: 0 };
      }
      if (cmd.includes('history_size')) {
        const visible = enterSent ? 'working\n  esc to interrupt\n' : '❯ \n';
        return { stdout: `BX_PANE_OK|5\n${visible}`, stderr: '', exitCode: 0 };
      }
      if (cmd.includes('paste-buffer')) {
        pasted = true;
        return undefined;
      }
      if (cmd.includes('send-keys') && cmd.includes('Enter')) {
        enterSent = true;
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return undefined;
    });
    await runAck(runner);
    expect(pasted).toBe(true);
    expect(sent.filter(c => c.includes('send-keys -l'))).toHaveLength(1);
    expect(ccCmds(sent)).toHaveLength(1);
  });

  it('aborts without pasting when the pane is visibly busy (pasting would feed the running turn or submit onto a leftover draft)', async () => {
    const sent: string[] = [];
    let pasted = false;
    let captures = 0;
    const runner = recordRunner(sent, cmd => {
      if (cmd.includes('pane_title')) {
        return { stdout: 'BX_PANE_OK⠹ Grooving…\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('capture-pane') && !cmd.includes('history_size')) {
        captures++;
        return { stdout: `BX_PANE_OK\n✶ Grooving… (${12 + captures}s)\n  esc to interrupt\n`, stderr: '', exitCode: 0 };
      }
      if (cmd.includes('paste-buffer')) {
        pasted = true;
        return undefined;
      }
      return undefined;
    });
    const { caught } = await runAck(runner);
    expect(caught).toBeInstanceOf(Error);
    expect(String((caught as Error).message)).toMatch(/pre-inject busy check/);
    expect(pasted).toBe(false);
    expect(sent.filter(c => c.includes('send-keys -l'))).toHaveLength(0);
    expect(ccCmds(sent)).toHaveLength(0);
  });

  it('clears a leftover draft whose text merely looks busy: an idle title plus a static frame rules out a running turn', async () => {
    const sent: string[] = [];
    let pasted = false;
    let enterSent = false;
    const DRAFT = '❯ 排查 codex 卡死，日志：\n  • Working (12s)\n  esc to interrupt\n';
    const runner = recordRunner(sent, cmd => {
      if (cmd.includes('pane_title')) {
        return { stdout: 'BX_PANE_OKdev-1\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('capture-pane') && !cmd.includes('history_size')) {
        return { stdout: `BX_PANE_OK\n${DRAFT}`, stderr: '', exitCode: 0 };
      }
      if (cmd.includes('history_size')) {
        const visible = enterSent ? 'working\n  esc to interrupt\n' : '❯ \n';
        return { stdout: `BX_PANE_OK|5\n${visible}`, stderr: '', exitCode: 0 };
      }
      if (cmd.includes('paste-buffer')) {
        pasted = true;
        return undefined;
      }
      if (cmd.includes('send-keys') && cmd.includes('Enter')) {
        enterSent = true;
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return undefined;
    });
    await runAck(runner);
    expect(pasted).toBe(true);
    expect(sent.filter(c => c.includes('send-keys -l'))).toHaveLength(1);
    expect(ccCmds(sent)).toHaveLength(1);
  });

  it('aborts when the text looks busy, the title is idle, but the frame is advancing (a real turn with a lost title)', async () => {
    const sent: string[] = [];
    let pasted = false;
    let captures = 0;
    const runner = recordRunner(sent, cmd => {
      if (cmd.includes('pane_title')) {
        return { stdout: 'BX_PANE_OKdev-1\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('capture-pane') && !cmd.includes('history_size')) {
        captures++;
        return { stdout: `BX_PANE_OK\n✶ Grooving… (${12 + captures}s)\n  esc to interrupt\n`, stderr: '', exitCode: 0 };
      }
      if (cmd.includes('paste-buffer')) {
        pasted = true;
        return undefined;
      }
      return undefined;
    });
    const { caught } = await runAck(runner);
    expect(caught).toBeInstanceOf(Error);
    expect(String((caught as Error).message)).toMatch(/pre-inject busy check/);
    expect(pasted).toBe(false);
    expect(ccCmds(sent)).toHaveLength(0);
  });

  it('re-validates the binding after the pre-inject clear: a task cancelled during the clear is never pasted', async () => {
    const sent: string[] = [];
    let pasted = false;
    const runner = recordRunner(sent, cmd => {
      if (cmd.includes('paste-buffer')) {
        pasted = true;
        return undefined;
      }
      if (cmd.includes('capture-pane')) {
        return { stdout: 'BX_PANE_OK\n❯ \n', stderr: '', exitCode: 0 };
      }
      return undefined;
    });
    const localManager = makeInjectManager(runner, 150, 150);
    const t = await seedTask();
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await acquireBoundLock('dev-1');
    const tmux = new TmuxManager(runner);
    vi.spyOn(TmuxManager.prototype, 'clearComposerDraft').mockImplementation(async () => {
      const cur = await taskStore.get(t.id);
      if (cur) await taskStore.set({ ...cur, status: 'cancelled' });
    });
    await expect(
      callInjectAndAwaitAck(localManager, tmux, '%0', 'hello prompt', 'dev-1', 'claude-code'),
    ).rejects.toThrow(/went terminal before paste/);
    expect(pasted).toBe(false);
  });
});

describe('injectAndAwaitAck busy-baseline is non-ackable', () => {
  it.each([
    {
      name: 'composer "clears" after submit but baseline was busy → still non-ackable',
      settleMs: 150,
      frames: () => (enterSent: boolean) => (enterSent ? 'running the task now\n' : 'review:\n  esc to interrupt\n'),
    },
    {
      name: 'swallowed Enter plus ongoing attach redraw is non-ackable',
      settleMs: 80,
      frames: () => { let n = 0; return () => `review:\n  esc to interrupt\n[Image #1] frame ${n++}\n`; },
    },
    {
      name: 'settled busy baseline plus late attach redraw and swallowed Enter is non-ackable',
      settleMs: 150,
      frames: () => { let post = 0; return (enterSent: boolean) => (enterSent ? `review:\n  esc to interrupt\n[Image #1] frame ${post++}\n` : 'review:\n  esc to interrupt\n'); },
    },
  ])('$name', async ({ frames, settleMs }) => {
    const runner = snapRunner(frames());
    const { result } = await runAck(runner, { ackMs: 150, settleMs, prompt: 'review:\n  esc to interrupt' });
    expect(result).toEqual({ acked: false, composerDelivered: false });
    expect(ackInterventions().length).toBeGreaterThanOrEqual(1);
  });
});

describe('AgentManager max_rounds manual actions', () => {
  function maxRoundsTask(overrides: Partial<TaskState> = {}): TaskState {
    const value = task({
      id: 'task-mr',
      status: 'max_rounds',
      reviewRound: 2,
      prNumber: 42,
      prUrl: 'https://github.com/user/repo/pull/42',
      branch: 'bx/task-mr',
      phase: 'code',
      deliveryConfirmation: { phase: 'code', source: 'signal', at: NOW },
      replyActorId: '77',
      replyActorStatus: 'verified',
      ...overrides,
    });
    if (value.phase === undefined) delete value.deliveryConfirmation;
    else if (!Object.hasOwn(overrides, 'deliveryConfirmation')) {
      value.deliveryConfirmation = { phase: value.phase, source: 'signal', at: NOW };
    }
    return value;
  }

  describe('markTaskComplete', () => {
    it('claims merge-ready before merging, then emits pr.merged to drive the cleanup chain', async () => {
      await taskStore.set(maxRoundsTask());
      const mergeSpy = vi.spyOn(manager, 'mergePr').mockImplementation(async () => {
        expect((await taskStore.get('task-mr'))?.status).toBe('merge-ready');
      });

      const result = await manager.markTaskComplete('task-mr');

      expect(mergeSpy).toHaveBeenCalledWith('task-mr', { humanOverride: true });
      const merged = events.find(e => e.type === 'pr.merged' && e.taskId === 'task-mr');
      expect(merged).toBeTruthy();
      expect(merged!.data).toMatchObject({ prNumber: 42 });
      expect(result.id).toBe('task-mr');
    });

    it.each([
      { name: 'non-max_rounds task', overrides: { status: 'review' as const } },
      { name: 'spec-phase task', overrides: { phase: 'spec' as const } },
    ])('rejects a $name with 409 (no merge)', async ({ overrides }) => {
      await taskStore.set(maxRoundsTask(overrides));
      const mergeSpy = vi.spyOn(manager, 'mergePr').mockResolvedValue();
      await expect(manager.markTaskComplete('task-mr')).rejects.toMatchObject({ status: 409 });
      expect(mergeSpy).not.toHaveBeenCalled();
    });

    it('rejects a task without a PR with 400', async () => {
      await taskStore.set(maxRoundsTask({ prNumber: undefined, prUrl: undefined }));
      await expect(manager.markTaskComplete('task-mr')).rejects.toMatchObject({ status: 400 });
    });

    it('rejects with 409 (no merge) when the dev is awaiting_human (held)', async () => {
      await taskStore.set(maxRoundsTask());
      await seedAgent({
        id: 'dev-1', status: 'awaiting_human',
        awaitingPhase: 'signal-arm-failed:pr-fixed', taskId: 'task-mr',
        workdir: '/tmp/repo/.baxian-worktrees/task-mr_abc', paneId: '%1',
      });
      const mergeSpy = vi.spyOn(manager, 'mergePr').mockResolvedValue();
      await expect(manager.markTaskComplete('task-mr')).rejects.toMatchObject({ status: 409 });
      expect(mergeSpy).not.toHaveBeenCalled();
      expect((await taskStore.get('task-mr'))?.status).toBe('max_rounds');
    });

    it('rejects with 409 (no merge) when the QA is awaiting_human and bound to the task', async () => {
      await taskStore.set(maxRoundsTask({ qaAgentId: 'qa-1' }));
      await seedAgent({
        id: 'dev-1', status: 'waiting',
        taskId: 'task-mr', workdir: '/tmp/repo/.baxian-worktrees/task-mr_abc', paneId: '%1',
      });
      await seedAgent({
        id: 'qa-1', status: 'awaiting_human',
        awaitingPhase: 'ack_unknown', taskId: 'task-mr', paneId: '%2',
      });
      const mergeSpy = vi.spyOn(manager, 'mergePr').mockResolvedValue();
      await expect(manager.markTaskComplete('task-mr')).rejects.toMatchObject({ status: 409 });
      expect(mergeSpy).not.toHaveBeenCalled();
      expect((await taskStore.get('task-mr'))?.status).toBe('max_rounds');
    });

    it('does not block completion when a held QA is bound to a DIFFERENT task (stale ref)', async () => {
      await taskStore.set(maxRoundsTask({ qaAgentId: 'qa-1' }));
      await seedAgent({
        id: 'qa-1', status: 'awaiting_human',
        taskId: 'some-other-task', paneId: '%2',
      });
      const mergeSpy = vi.spyOn(manager, 'mergePr').mockResolvedValue();
      await manager.markTaskComplete('task-mr');
      expect(mergeSpy).toHaveBeenCalledWith('task-mr', { humanOverride: true });
    });

    it('surfaces a merge failure as 409, rolls back to max_rounds, and does not emit pr.merged', async () => {
      await taskStore.set(maxRoundsTask());
      vi.spyOn(manager, 'mergePr').mockRejectedValue(new Error('gh pr merge failed: not approved'));
      await expect(manager.markTaskComplete('task-mr')).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('not approved'),
      });
      expect(events.some(e => e.type === 'pr.merged')).toBe(false);
      expect((await taskStore.get('task-mr'))?.status).toBe('max_rounds');
    });

    async function completeInFlight(): Promise<{ release: () => void; done: Promise<TaskState> }> {
      await taskStore.set(maxRoundsTask());
      await seedAgent({
        id: 'dev-1', status: 'waiting',
        taskId: 'task-mr', workdir: '/tmp/repo/.baxian-worktrees/task-mr_abc',
        paneId: '%1',
      });
      let release: () => void = () => {};
      vi.spyOn(manager, 'mergePr').mockImplementation(
        () => new Promise<void>(resolve => { release = resolve; }),
      );
      const done = manager.markTaskComplete('task-mr');
      await waitUntilAsync(async () => (await taskStore.get('task-mr'))?.status === 'merge-ready');
      return { release, done };
    }

    it('claims so a racing continueDevRound is rejected (no merge-while-fixing)', async () => {
      const { release, done } = await completeInFlight();
      await expect(manager.continueDevRound('task-mr')).rejects.toMatchObject({ status: 409 });
      release();
      await done;
    });

    it('claims so a racing cancelTask is rejected (no merge-then-skip-cleanup)', async () => {
      const { release, done } = await completeInFlight();
      await expect(manager.cancelTask('task-mr')).rejects.toMatchObject({ status: 409 });
      expect((await taskStore.get('task-mr'))?.status).toBe('merge-ready');
      release();
      await done;
    });

    it('claims so a racing dispatchReviewToQa (Call review) is rejected (no merge-while-reviewing)', async () => {
      const { release, done } = await completeInFlight();
      await expect(manager.dispatchReviewToQa('task-mr')).rejects.toMatchObject({ status: 409 });
      expect((await taskStore.get('task-mr'))?.status).toBe('merge-ready');
      release();
      await done;
    });
  });

  describe('continueDevRound', () => {
    async function bindReservedDev(): Promise<void> {
      await seedAgent({
        id: 'dev-1', status: 'waiting',
        taskId: 'task-mr', workdir: '/tmp/repo/.baxian-worktrees/task-mr_abc',
        paneId: '%1',
      });
    }

    async function setupContinueDev(armed: boolean): Promise<void> {
      await taskStore.set(maxRoundsTask());
      await bindReservedDev();
      vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(true);
      vi.spyOn(manager as unknown as {
        rotateAndSetupPhaseSignal: () => Promise<{ token: string; armed: boolean }>;
      },
        'rotateAndSetupPhaseSignal').mockResolvedValue({ token: 'fix-token', armed });
    }

    it('transitions max_rounds → fixing, bumps the round, and dispatches the fix', async () => {
      await setupContinueDev(true);
      const continueSpy = vi.spyOn(manager, 'continueSession').mockResolvedValue(true);

      const result = await manager.continueDevRound('task-mr');

      expect(result.status).toBe('fixing');
      expect(result.reviewRound).toBe(3);
      expect(continueSpy).toHaveBeenCalledWith(
        'task-mr',
        'dev-1',
        'fix',
        expect.objectContaining({ signalToken: 'fix-token' }),
      );
    });

    it.each([
      { name: 'non-max_rounds task', overrides: { status: 'fixing' as const } },
      { name: 'spec-phase task', overrides: { phase: 'spec' as const } },
    ])('rejects a $name with 409', async ({ overrides }) => {
      await taskStore.set(maxRoundsTask(overrides));
      await bindReservedDev();
      await expect(manager.continueDevRound('task-mr')).rejects.toMatchObject({ status: 409 });
    });

    it('rejects with 409 when the reserved worktree is gone, pointing at complete/cancel (not Retry)', async () => {
      await taskStore.set(maxRoundsTask());
      await seedAgent({ id: 'dev-1', taskId: 'task-mr', workdir: '' });
      await expect(manager.continueDevRound('task-mr')).rejects.toMatchObject({
        status: 409,
        message: expect.stringMatching(/mark-complete|cancel/),
      });
      expect((await taskStore.get('task-mr'))?.status).toBe('max_rounds');
    });

    it('rolls back to max_rounds and Holds the dev when the pr-fixed watcher fails to arm', async () => {
      await setupContinueDev(false);
      const holdSpy = vi.spyOn(manager, 'markAwaitingHuman').mockResolvedValue(true);
      const continueSpy = vi.spyOn(manager, 'continueSession').mockResolvedValue(true);

      await expect(manager.continueDevRound('task-mr')).rejects.toMatchObject({ status: 500 });
      expect(continueSpy).not.toHaveBeenCalled();
      expect(holdSpy).toHaveBeenCalled();
      const t = await taskStore.get('task-mr');
      expect(t?.status).toBe('max_rounds');
      expect(t?.reviewRound).toBe(2);
    });

    it('rolls back to max_rounds and re-parks the dev when continueSession returns false', async () => {
      await setupContinueDev(true);
      vi.spyOn(manager, 'continueSession').mockResolvedValue(false);
      const waitSpy = vi.spyOn(manager, 'markAgentWaiting').mockResolvedValue(true);

      await expect(manager.continueDevRound('task-mr')).rejects.toMatchObject({ status: 500 });
      const t = await taskStore.get('task-mr');
      expect(t?.status).toBe('max_rounds');
      expect(t?.reviewRound).toBe(2);
      expect(waitSpy).toHaveBeenCalledWith('dev-1', 'task-mr');
    });
  });

  it('markAgentWaiting succeeds for a dev bound to a max_rounds task (active set unification)', async () => {
    await taskStore.set(maxRoundsTask());
    await seedAgent({
      id: 'dev-1', status: 'running',
      taskId: 'task-mr', paneId: '%1',
    });
    await expect(manager.markAgentWaiting('dev-1', 'task-mr')).resolves.toBe(true);
  });

  it('failTasksForAgent fails a max_rounds task when its reserved dev dies', async () => {
    await taskStore.set(maxRoundsTask());
    await seedAgent({
      id: 'dev-1', status: 'waiting', taskId: 'task-mr',
    });
    const { failedTaskIds } = await manager.failTasksForAgent('dev-1', 'tmux-absent');
    expect(failedTaskIds).toContain('task-mr');
    expect((await taskStore.get('task-mr'))?.status).toBe('failed');
  });

  it('failTasksForAgent fails a spec-ready task when its dev dies (approve/reject both need the dev worktree)', async () => {
    await taskStore.set(task({
      id: 'task-sr', status: 'spec-ready', phase: 'spec', agentId: 'dev-1',
    }));
    await seedAgent({ id: 'dev-1', status: 'waiting', taskId: 'task-sr' });
    const { failedTaskIds } = await manager.failTasksForAgent('dev-1', 'tmux-absent');
    expect(failedTaskIds).toContain('task-sr');
    expect((await taskStore.get('task-sr'))?.status).toBe('failed');
  });

  describe('retryTask phase gate', () => {
    it('rejects code-phase max_rounds with 409 (use continue/complete instead)', async () => {
      await taskStore.set(maxRoundsTask());
      await expect(manager.retryTask('task-mr')).rejects.toMatchObject({ status: 409 });
    });

    it('allows spec-phase max_rounds to retry AND finalizes the old task (no lingering active duplicate)', async () => {
      await taskStore.set(maxRoundsTask({ phase: 'spec', prNumber: undefined, prUrl: undefined }));
      vi.spyOn(manager, 'validateTaskDispatch').mockResolvedValue();
      const createSpy = vi
        .spyOn(manager, 'createAndStartTask')
        .mockResolvedValue(task({ id: 'task-mr-retry', status: 'in_progress' }));

      const fresh = await manager.retryTask('task-mr');

      expect(createSpy).toHaveBeenCalled();
      expect(fresh.id).toBe('task-mr-retry');
      expect((await taskStore.get('task-mr'))?.status).toBe('cancelled');
    });

    it('resolves the current Dev through the surviving QA group when the historical Dev was replaced', async () => {
      await taskStore.set(task({ id: 'task-retry-replaced', status: 'failed' }));
      manager.replaceConfig({
        ...CONFIG,
        project: [{
          ...CONFIG.project[0]!,
          agent: [[
            { ...CONFIG.project[0]!.agent[0]![0]!, id: 'dev-next' },
            CONFIG.project[0]!.agent[0]![1]!,
          ]],
        }],
      });
      const validate = vi.spyOn(manager, 'validateTaskDispatch').mockResolvedValue();
      const create = vi.spyOn(manager, 'createAndStartTask')
        .mockResolvedValue(task({ id: 'task-retry-created', status: 'in_progress' }));

      await manager.retryTask('task-retry-replaced');

      expect(validate).toHaveBeenCalledWith('proj', expect.objectContaining({
        preferredAgentId: 'dev-next',
      }));
      expect(create).toHaveBeenCalledWith('proj', expect.objectContaining({
        preferredAgentId: 'dev-next',
      }));
    });
  });

  it('cancelTask cancels a max_rounds task (non-terminal) and releases the reserved dev', async () => {
    await taskStore.set(maxRoundsTask({ prNumber: undefined, prUrl: undefined }));
    await seedAgent({
      id: 'dev-1', status: 'waiting',
      taskId: 'task-mr', paneId: '%1',
    });
    mockInterruptPane(manager, true);
    const releaseSpy = vi.spyOn(manager, 'releaseAgentForTask').mockResolvedValue(true);

    const cancelled = await manager.cancelTask('task-mr');

    expect(cancelled.status).toBe('cancelled');
    expect(releaseSpy).toHaveBeenCalledWith('dev-1', 'task-mr', 'idle', { allowAwaitingHuman: true, fromCancelCleanup: true });
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 300): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('waitUntil: predicate never became true');
}

async function waitUntilAsync(predicate: () => Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('waitUntilAsync: predicate never became true');
}

describe('AgentManager.startSession pre/mid-dispatch gates', () => {
  it('aborts before ensureSession when the exact task lock is missing', async () => {
    const t = await seedTask();
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    const state = (await agentStore.get('dev-1'))!;
    await lockManager.releaseIfOwner('dev-1', t.id, state.lockToken!);
    const ensureSpy = vi.spyOn(manager, 'ensureSession');

    await expect(manager.startSession(t.id, 'dev-1', 'develop')).resolves.toBe(false);

    expect(ensureSpy).not.toHaveBeenCalled();
  });

  it('aborts before ensureSession when the task disappears at the pre-create gate', async () => {
    const t = await seedTask();
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    const realGet = taskStore.get.bind(taskStore);
    let calls = 0;
    vi.spyOn(taskStore, 'get').mockImplementation(async (id) => {
      calls += 1;
      return calls >= 2 ? null : realGet(id);
    });
    const ensureSpy = vi.spyOn(manager, 'ensureSession');

    await expect(manager.startSession(t.id, 'dev-1', 'develop')).resolves.toBe(false);
    expect(ensureSpy).not.toHaveBeenCalled();
  });

  it('aborts when the pre-create status is outside the phase expectation', async () => {
    const t = await seedTask({ status: 'review' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    const ensureSpy = vi.spyOn(manager, 'ensureSession');

    await expect(manager.startSession(t.id, 'dev-1', 'develop')).resolves.toBe(false);
    expect(ensureSpy).not.toHaveBeenCalled();
  });

  it('aborts a bound-phase dispatch when the agent is not bound to the task', async () => {
    const t = await seedTask();
    await seedAgent({ id: 'dev-1' });

    await expect(manager.startSession(t.id, 'dev-1', 'develop')).resolves.toBe(false);
  });

  it('aborts an unbound-phase dispatch when the agent is already bound elsewhere', async () => {
    const t = await seedTask({ status: 'review' });
    await seedAgent({ id: 'qa-1', taskId: 'some-other-task' });

    await expect(manager.startSession(t.id, 'qa-1', 'review')).resolves.toBe(false);
  });

  it('kills the orphan session when ensureSession fails after creating one', async () => {
    const t = await seedTask();
    await seedAgent({ id: 'dev-1', taskId: t.id });
    vi.spyOn(manager, 'ensureSession').mockRejectedValue(
      new EnsureSessionError({ createdSession: true, agentId: 'dev-1', sessionRef: { sessionId: '$7', serverPid: '4242', serverStart: '1700000000' }, genAtCreate: 0 }, 'session boot boom'),
    );
    const killSpy = vi.spyOn(TmuxManager.prototype, 'killSessionRef').mockResolvedValue('killed');

    await expect(manager.startSession(t.id, 'dev-1', 'develop')).rejects.toThrow('session boot boom');
    expect(killSpy).toHaveBeenCalledWith(
      { sessionId: '$7', serverPid: '4242', serverStart: '1700000000' },
      { kind: 'emptyOr', claim: 'dev-1' },
    );
  });

  it('still rethrows the ensureSession error when the rollback killSession also fails', async () => {
    const t = await seedTask();
    await seedAgent({ id: 'dev-1', taskId: t.id });
    vi.spyOn(manager, 'ensureSession').mockRejectedValue(
      new EnsureSessionError({ createdSession: true, agentId: 'dev-1', sessionRef: { sessionId: '$7', serverPid: '4242', serverStart: '1700000000' }, genAtCreate: 0 }, 'session boot boom'),
    );
    vi.spyOn(TmuxManager.prototype, 'killSessionRef').mockRejectedValue(new Error('kill failed'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(manager.startSession(t.id, 'dev-1', 'develop')).rejects.toThrow('session boot boom');
    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('created-session rollback') && String(c[0]).includes('failed'))).toBe(true);
    warnSpy.mockRestore();
  });

  it('rethrows without killSession when the dialog handler claims the ensureSession failure', async () => {
    const t = await seedTask();
    await seedAgent({ id: 'dev-1', taskId: t.id });
    vi.spyOn(manager, 'ensureSession').mockRejectedValue(
      new EnsureSessionError({ createdSession: true, agentId: 'dev-1', sessionRef: { sessionId: '$7', serverPid: '4242', serverStart: '1700000000' }, genAtCreate: 0 }, 'dialog blocked'),
    );
    vi.spyOn(manager, 'handleDialogPendingFromRuntime').mockResolvedValue(true);
    const killSpy = vi.spyOn(TmuxManager.prototype, 'killSessionRef').mockResolvedValue('killed');

    await expect(manager.startSession(t.id, 'dev-1', 'develop')).rejects.toThrow('dialog blocked');
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('maps PromptSizeError to DispatchTerminalError(prompt_too_large) and parks the fixed Workdir', async () => {
    const t = await seedTask();
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    stubEnsureSession(manager);
    const parkSpy = vi.spyOn(BranchManager.prototype, 'parkOnDefaultDetached').mockResolvedValue();
    stubImagePathsThrow(manager, new PromptSizeError(999_999));

    await expect(manager.startSession(t.id, 'dev-1', 'develop')).rejects.toMatchObject({
      name: 'DispatchTerminalError',
      reason: 'prompt_too_large',
    });
    expect(parkSpy).toHaveBeenCalledWith('/tmp/repo');
  });

  it('maps RequiredSkillsMissingError to DispatchTerminalError(required_skills_missing)', async () => {
    const t = await seedTask();
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    stubEnsureSession(manager);
    const parkSpy = vi.spyOn(BranchManager.prototype, 'parkOnDefaultDetached').mockResolvedValue();
    stubImagePathsThrow(manager, new RequiredSkillsMissingError(['baxian-task-check']));

    await expect(manager.startSession(t.id, 'dev-1', 'develop')).rejects.toMatchObject({
      reason: 'required_skills_missing',
    });
    expect(parkSpy).toHaveBeenCalledWith('/tmp/repo');
  });

  it.each([
    { name: 'task disappears mid-dispatch', fresh: null },
    { name: 'task turns terminal mid-dispatch', fresh: { status: 'cancelled' as const } },
    { name: 'task status leaves the phase expectation mid-dispatch', fresh: { status: 'review' as const } },
  ])('parks the fixed Workdir and aborts when the $name', async ({ fresh }) => {
    const t = await seedTask();
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    stubEnsureSession(manager);
    const parkSpy = vi.spyOn(BranchManager.prototype, 'parkOnDefaultDetached').mockResolvedValue();
    stubInject(manager, async () => ({ acked: true, composerDelivered: true }));
    const realGet = taskStore.get.bind(taskStore);
    let calls = 0;
    vi.spyOn(taskStore, 'get').mockImplementation(async (id) => {
      calls += 1;
      if (calls >= 3) return fresh === null ? null : { ...t, ...fresh };
      return realGet(id);
    });

    await expect(manager.startSession(t.id, 'dev-1', 'develop')).resolves.toBe(false);
    expect(parkSpy).toHaveBeenCalledWith('/tmp/repo');
  });

  it('aborts without cleanup when the bound agent loses ownership mid-dispatch', async () => {
    const t = await seedTask();
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    stubEnsureSession(manager);
    const parkSpy = vi.spyOn(BranchManager.prototype, 'parkOnDefaultDetached').mockResolvedValue();
    let checkoutFinished = false;
    vi.spyOn(
      manager as unknown as { imagePathsForDispatch: (...args: unknown[]) => Promise<string[]> },
      'imagePathsForDispatch',
    ).mockImplementation(async () => {
      checkoutFinished = true;
      return [];
    });
    const realGet = agentStore.get.bind(agentStore);
    vi.spyOn(agentStore, 'get').mockImplementation(async (id) => {
      if (checkoutFinished) return { id: 'dev-1', projectId: 'proj', updatedAt: NOW };
      return realGet(id);
    });

    await expect(manager.startSession(t.id, 'dev-1', 'develop')).resolves.toBe(false);
    expect(parkSpy).not.toHaveBeenCalled();
  });

  it('aborts without cleanup when an unbound-phase agent gets reassigned mid-dispatch', async () => {
    const t = await seedTask({
      status: 'review', signalToken: 'tok123456789', latestHeadSha: 'a'.repeat(40),
      passToken: 'aaaaaaaaaaaa', failToken: 'bbbbbbbbbbbb',
    });
    await seedAgent({ id: 'qa-1', taskId: t.id });
    stubEnsureSession(manager);
    const parkSpy = vi.spyOn(BranchManager.prototype, 'parkOnDefaultDetached').mockResolvedValue();
    let checkoutFinished = false;
    vi.spyOn(
      manager as unknown as { imagePathsForDispatch: (...args: unknown[]) => Promise<string[]> },
      'imagePathsForDispatch',
    ).mockImplementation(async () => {
      checkoutFinished = true;
      return [];
    });
    const realGet = agentStore.get.bind(agentStore);
    vi.spyOn(agentStore, 'get').mockImplementation(async (id) => {
      if (checkoutFinished) return { id: 'qa-1', projectId: 'proj', taskId: 'stolen-task', updatedAt: NOW };
      return realGet(id);
    });

    await expect(manager.startSession(t.id, 'qa-1', 'review')).resolves.toBe(false);
    expect(parkSpy).not.toHaveBeenCalled();
  });

  it('review phase checks out the exact verified remote head in the fixed Workdir', async () => {
    const latestHeadSha = 'a'.repeat(40);
    const t = await seedTask({
      status: 'review', qaAgentId: 'qa-1', signalToken: 'tok123456789', latestHeadSha,
      passToken: 'aaaaaaaaaaaa', failToken: 'bbbbbbbbbbbb',
    });
    await seedAgent({ id: 'qa-1', taskId: t.id });
    stubEnsureSession(manager);
    const detachedSpy = vi.spyOn(BranchManager.prototype, 'switchToRemoteBranchDetached')
      .mockResolvedValue(undefined);
    stubInject(manager, async () => ({ acked: true, composerDelivered: true }));

    await expect(manager.startSession(t.id, 'qa-1', 'review')).resolves.toBe(true);
    expect(detachedSpy).toHaveBeenCalledWith('/tmp/qa-repo', t.branch, latestHeadSha);
  });

  it('refreshes a moved PR head and retries the exact detached checkout once', async () => {
    const oldHeadSha = 'a'.repeat(40);
    const newHeadSha = 'b'.repeat(40);
    const t = await seedTask({
      status: 'review', qaAgentId: 'qa-1', prNumber: 17,
      platformBinding: GIT_BINDING, passToken: 'aaaaaaaaaaaa', failToken: 'bbbbbbbbbbbb',
      signalToken: 'tok123456789', latestHeadSha: oldHeadSha,
    });
    await seedAgent({ id: 'qa-1', taskId: t.id });
    stubEnsureSession(manager, { freshRuntime: true });
    const detachedSpy = vi.spyOn(BranchManager.prototype, 'switchToRemoteBranchDetached')
      .mockRejectedValueOnce(new ReviewHeadMismatchError(t.branch!, oldHeadSha, newHeadSha))
      .mockResolvedValue(undefined);
    vi.spyOn(manager, 'platformFetchPrView').mockResolvedValue({ headSha: newHeadSha } as never);
    stubInject(manager, async () => ({ acked: true, composerDelivered: true }));

    await expect(manager.startSession(t.id, 'qa-1', 'review')).resolves.toBe(true);

    expect(detachedSpy).toHaveBeenNthCalledWith(1, '/tmp/qa-repo', t.branch, oldHeadSha);
    expect(detachedSpy).toHaveBeenNthCalledWith(2, '/tmp/qa-repo', t.branch, newHeadSha);
    expect((await taskStore.get(t.id))?.latestHeadSha).toBe(newHeadSha);
  });

  it('fails closed when the runtime rejects task-boundary /clear', async () => {
    const tmux = new TmuxManager(readyRunner());
    vi.spyOn(
      manager as unknown as { waitForReplPromptReady: (...args: unknown[]) => Promise<void> },
      'waitForReplPromptReady',
    ).mockResolvedValue(undefined);
    vi.spyOn(tmux, 'clearComposerDraft').mockResolvedValue(undefined);
    vi.spyOn(tmux, 'captureSettledSnapshot').mockResolvedValue('before');
    vi.spyOn(tmux, 'readPaneTitle').mockResolvedValue('');
    vi.spyOn(tmux, 'sendKeysLiteral').mockResolvedValue(undefined);
    vi.spyOn(tmux, 'sendEnter').mockResolvedValue(undefined);
    vi.spyOn(tmux, 'waitSubmitAck').mockResolvedValue(undefined);
    vi.spyOn(
      manager as unknown as { hasRuntimeSlashCommandRejection: (...args: unknown[]) => Promise<boolean> },
      'hasRuntimeSlashCommandRejection',
    ).mockResolvedValue(true);
    const revalidate = vi.fn(async () => undefined);
    const clearBoundary = (
      manager as unknown as {
        clearRuntimeForDispatchBoundary: (
          tmuxManager: TmuxManager,
          paneId: string,
          agentId: string,
          runtime: AgentConfig['runtime'],
          revalidateOwner: () => Promise<void>,
        ) => Promise<void>;
      }
    ).clearRuntimeForDispatchBoundary.bind(manager);

    await expect(clearBoundary(tmux, '%0', 'dev-1', 'claude-code', revalidate))
      .rejects.toThrow('Runtime rejected /clear');

    expect(tmux.sendKeysLiteral).toHaveBeenCalledWith('%0', '/clear');
    expect(revalidate).toHaveBeenCalledTimes(1);
  });

  it('does not retag stale skills when task-boundary /clear fails', async () => {
    const t = await seedTask();
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true,
      createdSession: false,
      freshRuntime: false,
      skillsStale: true,
      paneId: '%0',
      workdir: '/tmp/repo',
    });
    vi.spyOn(
      manager as unknown as { waitForReplPromptReady: (...args: unknown[]) => Promise<void> },
      'waitForReplPromptReady',
    ).mockResolvedValue(undefined);
    vi.spyOn(
      manager as unknown as { clearRuntimeForDispatchBoundary: (...args: unknown[]) => Promise<void> },
      'clearRuntimeForDispatchBoundary',
    ).mockRejectedValue(new Error('Runtime rejected /clear'));
    const tagSpy = vi.spyOn(
      manager as unknown as { tagSessionSkillsVersion: (...args: unknown[]) => Promise<void> },
      'tagSessionSkillsVersion',
    ).mockResolvedValue(undefined);

    await expect(manager.startSession(t.id, 'dev-1', 'develop')).rejects.toMatchObject({
      name: 'EnsureSessionError',
      partial: expect.objectContaining({ handled: true }),
    });
    expect(tagSpy).not.toHaveBeenCalled();
  });

  it('warns but keeps the delivered dispatch when both marker-clear and the hold fail', async () => {
    const t = await seedTask({ id: 'task-deliver-hold-fails', branch: 'bx/task-deliver-hold-fails' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await acquireBoundLock('dev-1');
    stubEnsureSession(manager);

    let afterAck = false;
    let threwOnce = false;
    stubInject(manager, async () => { afterAck = true; return { acked: true, composerDelivered: true }; });
    const realUpdate = agentStore.update.bind(agentStore);
    vi.spyOn(agentStore, 'update').mockImplementation(async (id, updater) => {
      if (afterAck && !threwOnce) { threwOnce = true; throw new Error('marker-clear write blip'); }
      return realUpdate(id, updater);
    });
    vi.spyOn(manager, 'markAwaitingHuman').mockRejectedValue(new Error('hold write failed'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(manager.startSession(t.id, 'dev-1', 'develop')).resolves.toBe(true);
    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('hold after marker-clear failure'))).toBe(true);
    warnSpy.mockRestore();
  });

  it('releases the binding and lock after parking the Workdir when paste fails definitively', async () => {
    const t = await seedTask();
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await acquireBoundLock('dev-1');
    stubEnsureSession(manager);
    const parkSpy = vi.spyOn(BranchManager.prototype, 'parkOnDefaultDetached').mockResolvedValue();
    stubInject(manager, async () => { throw new Error('paste failed'); });

    await expect(manager.startSession(t.id, 'dev-1', 'develop')).rejects.toThrow('paste failed');
    expect(parkSpy).toHaveBeenCalledWith('/tmp/repo');
    const state = await agentStore.get('dev-1');
    expect(state?.taskId).toBeUndefined();
    expect(state?.paneId).toBe('%0');
    expect(await lockManager.isLocked('dev-1')).toBe(false);
  });

  it('holds the binding and lock when a failed dispatch checkout cannot be parked', async () => {
    const t = await seedTask();
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await acquireBoundLock('dev-1');
    stubEnsureSession(manager);
    vi.spyOn(BranchManager.prototype, 'parkOnDefaultDetached').mockRejectedValue(new Error('checkout park failed'));
    stubInject(manager, async () => { throw new Error('paste failed'); });

    await expect(manager.startSession(t.id, 'dev-1', 'develop')).rejects.toMatchObject({
      partial: expect.objectContaining({ handled: true }),
      message: expect.stringContaining('checkout park failed'),
    });
    expect(await agentStore.get('dev-1')).toMatchObject({
      taskId: t.id,
      status: 'awaiting_human',
      awaitingPhase: 'checkout-cleanup-failed',
    });
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  it('leaves the new owner untouched when the agent was reassigned while the paste was failing', async () => {
    const t = await seedTask();
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await acquireBoundLock('dev-1');
    stubEnsureSession(manager);
    stubInject(manager, async () => {
      await agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: 'new-owner-task', updatedAt: NOW });
      throw new Error('paste failed');
    });

    await expect(manager.startSession(t.id, 'dev-1', 'develop')).rejects.toThrow('paste failed');
    expect((await agentStore.get('dev-1'))?.taskId).toBe('new-owner-task');
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  it('rethrows the paste error even when the cleanup write itself fails', async () => {
    const t = await seedTask();
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await acquireBoundLock('dev-1');
    stubEnsureSession(manager);
    stubInject(manager, async () => { throw new Error('paste failed'); });
    const realUpdate = agentStore.update.bind(agentStore);
    let updates = 0;
    vi.spyOn(agentStore, 'update').mockImplementation(async (id, updater) => {
      updates += 1;
      if (updates >= 3) throw new Error('cleanup write blip');
      return realUpdate(id, updater);
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(manager.startSession(t.id, 'dev-1', 'develop')).rejects.toThrow('paste failed');
    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('cleanup agentStore failed'))).toBe(true);
    expect((await agentStore.get('dev-1'))?.taskId).toBe(t.id);
    expect(await lockManager.isLocked('dev-1')).toBe(true);
    warnSpy.mockRestore();
  });
});

describe('AgentManager.continueSession pre/mid-dispatch gates', () => {
  async function seedContinueFix(): Promise<TaskState> {
    const t = await seedTask({ status: 'fixing', signalToken: 'tok123456789' });
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      workdir: '/tmp/repo/.baxian-worktrees/wt',
    });
    return t;
  }

  it('post-approve without a completion token is skipped', async () => {
    const t = await seedTask({ status: 'approved' });
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      workdir: '/tmp/repo/.baxian-worktrees/wt',
    });
    stubEnsureSession(manager);
    const ensureSpy = vi.spyOn(manager, 'ensureSession');

    await expect(manager.continueSession(t.id, 'dev-1', 'post-approve', { signalToken: 'tok' }))
      .resolves.toBe(false);
    expect(ensureSpy).not.toHaveBeenCalled();
  });

  it('bound phase is skipped when the agent no longer holds the task', async () => {
    const t = await seedTask({ status: 'fixing' });
    await seedAgent({
      id: 'dev-1', taskId: 'other-task', paneId: '%0',
      workdir: '/tmp/repo/.baxian-worktrees/wt',
    });

    await expect(manager.continueSession(t.id, 'dev-1', 'fix')).resolves.toBe(false);
  });

  it('unbound phase is skipped when the agent is bound to a different task', async () => {
    const t = await seedTask({
      status: 'review', signalToken: 'tok123456789',
      passToken: 'aaaaaaaaaaaa', failToken: 'bbbbbbbbbbbb',
    });
    await seedAgent({
      id: 'qa-1', taskId: 'other-task', paneId: '%0',
      workdir: '/tmp/repo/.baxian-worktrees/wt',
    });

    await expect(manager.continueSession(t.id, 'qa-1', 'recheck')).resolves.toBe(false);
  });

  it('a dirty checkout blocks a dev continuation unless allowDirtyWorkdir marks it as in-flight resume', async () => {
    const t = await seedContinueFix();
    stubEnsureSession(manager);
    stubInject(manager, async () => ({ acked: true, composerDelivered: true }));
    vi.mocked(BranchManager.prototype.assertClean)
      .mockRejectedValue(new DirtyWorkdirError('/tmp/repo/.baxian-worktrees/wt'));

    await expect(manager.continueSession(t.id, 'dev-1', 'fix')).rejects.toBeInstanceOf(DirtyWorkdirError);
    await expect(manager.continueSession(t.id, 'dev-1', 'fix', { allowDirtyWorkdir: true }))
      .resolves.toBe(true);
  });

  it('clears and retags stale skill context before continuation injection', async () => {
    const t = await seedContinueFix();
    const order: string[] = [];
    stubEnsureSession(manager, {
      skillsStale: true,
      pane: paneRefOf('%0', 'dev-1'),
      sessionRef: SESSION_REF,
    });
    const clearSpy = vi.spyOn(
      manager as unknown as { clearRuntimeForDispatchBoundary: (...args: unknown[]) => Promise<void> },
      'clearRuntimeForDispatchBoundary',
    ).mockImplementation(async (...args) => {
      order.push('clear');
      await (args[4] as () => Promise<void>)();
    });
    const tagSpy = vi.spyOn(
      manager as unknown as { tagSessionSkillsVersion: (...args: unknown[]) => Promise<void> },
      'tagSessionSkillsVersion',
    ).mockImplementation(async () => {
      order.push('tag');
    });
    stubInject(manager, async () => {
      order.push('inject');
      return { acked: true, composerDelivered: true };
    });

    await expect(manager.continueSession(t.id, 'dev-1', 'fix')).resolves.toBe(true);
    expect(order).toEqual(['clear', 'tag', 'inject']);
    expect(clearSpy).toHaveBeenCalledOnce();
    expect(tagSpy).toHaveBeenCalledWith(expect.any(TmuxManager), 'dev-1', SESSION_REF);
  });

  it('does not retag or inject when stale continuation context cannot be cleared', async () => {
    const t = await seedContinueFix();
    stubEnsureSession(manager, {
      skillsStale: true,
      pane: paneRefOf('%0', 'dev-1'),
      sessionRef: SESSION_REF,
    });
    vi.spyOn(
      manager as unknown as { clearRuntimeForDispatchBoundary: (...args: unknown[]) => Promise<void> },
      'clearRuntimeForDispatchBoundary',
    ).mockRejectedValue(new Error('skill refresh clear failed'));
    const tagSpy = vi.spyOn(
      manager as unknown as { tagSessionSkillsVersion: (...args: unknown[]) => Promise<void> },
      'tagSessionSkillsVersion',
    ).mockResolvedValue(undefined);
    const injectSpy = vi.spyOn(
      manager as unknown as { injectAndAwaitAck: InjectAckFn },
      'injectAndAwaitAck',
    ).mockResolvedValue({ acked: true, composerDelivered: true });

    await expect(manager.continueSession(t.id, 'dev-1', 'fix'))
      .rejects.toThrow('skill refresh clear failed');
    expect(tagSpy).not.toHaveBeenCalled();
    expect(injectSpy).not.toHaveBeenCalled();
  });

  it('restores the task branch checkout when a dev continuation left it and the tree is clean', async () => {
    const t = await seedContinueFix();
    stubEnsureSession(manager);
    stubInject(manager, async () => ({ acked: true, composerDelivered: true }));
    vi.mocked(BranchManager.prototype.currentRef).mockResolvedValue(null);
    const switchSpy = vi.mocked(BranchManager.prototype.switchToTaskBranch);

    await expect(manager.continueSession(t.id, 'dev-1', 'fix')).resolves.toBe(true);
    expect(switchSpy).toHaveBeenCalledWith(
      '/tmp/repo/.baxian-worktrees/wt', t.id, t.branch, true, { requireExistingWork: true },
    );
  });

  it('restores the checkout on an allowDirtyWorkdir continuation too (switch enforces cleanliness itself)', async () => {
    const t = await seedContinueFix();
    stubEnsureSession(manager);
    stubInject(manager, async () => ({ acked: true, composerDelivered: true }));
    vi.mocked(BranchManager.prototype.currentRef).mockResolvedValue('refs/heads/other-branch');
    const switchSpy = vi.mocked(BranchManager.prototype.switchToTaskBranch);

    await expect(manager.continueSession(t.id, 'dev-1', 'fix', { allowDirtyWorkdir: true }))
      .resolves.toBe(true);
    expect(switchSpy).toHaveBeenCalledWith(
      '/tmp/repo/.baxian-worktrees/wt', t.id, t.branch, true, { requireExistingWork: true },
    );
  });

  it('hands the branchLocalCleaned credential to the checkout restore and clears it on success', async () => {
    const t = await seedTask({
      status: 'fixing',
      signalToken: 'tok123456789',
      branchLocalCleaned: { remoteTipSha: 'b'.repeat(40), updatedAt: NOW },
    });
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      workdir: '/tmp/repo/.baxian-worktrees/wt',
    });
    stubEnsureSession(manager);
    stubInject(manager, async () => ({ acked: true, composerDelivered: true }));
    vi.mocked(BranchManager.prototype.currentRef).mockResolvedValue(null);
    const switchSpy = vi.mocked(BranchManager.prototype.switchToTaskBranch);

    await expect(manager.continueSession(t.id, 'dev-1', 'fix')).resolves.toBe(true);
    expect(switchSpy).toHaveBeenCalledWith(
      '/tmp/repo/.baxian-worktrees/wt', t.id, t.branch, true,
      { requireExistingWork: true, restorableRemoteTip: 'b'.repeat(40) },
    );
    expect((await taskStore.get(t.id))?.branchLocalCleaned).toBeUndefined();
  });

  it('a checkout mismatch on a dirty tree stays fail-closed and never dispatches', async () => {
    const t = await seedContinueFix();
    stubEnsureSession(manager);
    const injectSpy = vi.spyOn(
      manager as unknown as { injectAndAwaitAck: InjectAckFn },
      'injectAndAwaitAck',
    ).mockResolvedValue({ acked: true, composerDelivered: true });
    vi.mocked(BranchManager.prototype.currentRef).mockResolvedValue('refs/heads/other-branch');
    vi.mocked(BranchManager.prototype.switchToTaskBranch)
      .mockRejectedValue(new DirtyWorkdirError('/tmp/repo/.baxian-worktrees/wt'));

    await expect(manager.continueSession(t.id, 'dev-1', 'fix', { allowDirtyWorkdir: true }))
      .rejects.toBeInstanceOf(DirtyWorkdirError);
    expect(injectSpy).not.toHaveBeenCalled();
  });

  async function pasteDevelopContinuation(overrides: Partial<TaskState>): Promise<string> {
    const t = await seedTask({ status: 'in_progress', signalToken: 'tok123456789', ...overrides });
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      workdir: '/tmp/repo/.baxian-worktrees/wt',
    });
    stubEnsureSession(manager);
    const prompts: string[] = [];
    stubInject(manager, async (_tmux, _paneId, prompt) => {
      prompts.push(prompt);
      return { acked: true, composerDelivered: true };
    });

    await expect(manager.continueSession(t.id, 'dev-1', 'develop', {
      signalToken: 'tok123456789',
      allowDirtyWorkdir: true,
    })).resolves.toBe(true);
    return prompts[0]!;
  }

  it('a develop continuation carries only the rotating token', async () => {
    const prompt = await pasteDevelopContinuation({});

    expect(prompt).toContain('token: tok123456789');
    expect(prompt).not.toMatch(/^(?:spec-)?signal:/m);
  });

  it('rethrows without killSession when the dialog handler claims the ensureSession failure', async () => {
    const t = await seedContinueFix();
    vi.spyOn(manager, 'ensureSession').mockRejectedValue(
      new EnsureSessionError({ createdSession: true, agentId: 'dev-1', sessionRef: { sessionId: '$7', serverPid: '4242', serverStart: '1700000000' }, genAtCreate: 0 }, 'dialog blocked'),
    );
    vi.spyOn(manager, 'handleDialogPendingFromRuntime').mockResolvedValue(true);
    const killSpy = vi.spyOn(TmuxManager.prototype, 'killSessionRef').mockResolvedValue('killed');

    await expect(manager.continueSession(t.id, 'dev-1', 'fix')).rejects.toThrow('dialog blocked');
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('kills the orphan session when ensureSession fails after creating one', async () => {
    const t = await seedContinueFix();
    vi.spyOn(manager, 'ensureSession').mockRejectedValue(
      new EnsureSessionError({ createdSession: true, agentId: 'dev-1', sessionRef: { sessionId: '$7', serverPid: '4242', serverStart: '1700000000' }, genAtCreate: 0 }, 'session boot boom'),
    );
    const killSpy = vi.spyOn(TmuxManager.prototype, 'killSessionRef').mockRejectedValue(new Error('kill failed'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(manager.continueSession(t.id, 'dev-1', 'fix')).rejects.toThrow('session boot boom');
    expect(killSpy).toHaveBeenCalledWith(
      { sessionId: '$7', serverPid: '4242', serverStart: '1700000000' },
      { kind: 'emptyOr', claim: 'dev-1' },
    );
    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('created-session rollback') && String(c[0]).includes('failed'))).toBe(true);
    warnSpy.mockRestore();
  });

  it.each([
    { name: 'PromptSizeError → prompt_too_large', err: new PromptSizeError(999_999), reason: 'prompt_too_large' },
    { name: 'RequiredSkillsMissingError → required_skills_missing', err: new RequiredSkillsMissingError(['x']), reason: 'required_skills_missing' },
  ])('maps $name', async ({ err, reason }) => {
    const t = await seedContinueFix();
    stubEnsureSession(manager);
    stubImagePathsThrow(manager, err);

    await expect(manager.continueSession(t.id, 'dev-1', 'fix')).rejects.toMatchObject({ reason });
  });

  it.each([
    { name: 'terminal', fresh: { status: 'cancelled' as const } },
    { name: 'missing', fresh: null },
    { name: 'status-drifted', fresh: { status: 'review' as const } },
  ])('skips the paste when the task is $name at the pre-paste gate', async ({ fresh }) => {
    const t = await seedContinueFix();
    stubEnsureSession(manager);
    stubInject(manager, async () => ({ acked: true, composerDelivered: true }));
    const realGet = taskStore.get.bind(taskStore);
    let calls = 0;
    vi.spyOn(taskStore, 'get').mockImplementation(async (id) => {
      calls += 1;
      if (calls >= 2) return fresh === null ? null : { ...t, ...fresh };
      return realGet(id);
    });

    await expect(manager.continueSession(t.id, 'dev-1', 'fix')).resolves.toBe(false);
  });

  it('skips the paste when the bound agent loses the binding pre-paste', async () => {
    const t = await seedContinueFix();
    stubEnsureSession(manager);
    stubInject(manager, async () => ({ acked: true, composerDelivered: true }));
    const realGet = agentStore.get.bind(agentStore);
    let calls = 0;
    vi.spyOn(agentStore, 'get').mockImplementation(async (id) => {
      calls += 1;
      if (calls >= 2) return { id: 'dev-1', projectId: 'proj', updatedAt: NOW };
      return realGet(id);
    });

    await expect(manager.continueSession(t.id, 'dev-1', 'fix')).resolves.toBe(false);
  });

  it('skips the paste when an unbound-phase agent gets reassigned pre-paste', async () => {
    const t = await seedTask({
      status: 'review', signalToken: 'tok123456789',
      passToken: 'aaaaaaaaaaaa', failToken: 'bbbbbbbbbbbb',
    });
    await seedAgent({
      id: 'qa-1', taskId: t.id, paneId: '%0',
      workdir: '/tmp/repo/.baxian-worktrees/wt',
    });
    stubEnsureSession(manager);
    stubInject(manager, async () => ({ acked: true, composerDelivered: true }));
    let promptBuilt = false;
    vi.spyOn(
      manager as unknown as { imagePathsForDispatch: (...args: unknown[]) => Promise<string[]> },
      'imagePathsForDispatch',
    ).mockImplementation(async () => {
      promptBuilt = true;
      return [];
    });
    const realGet = agentStore.get.bind(agentStore);
    vi.spyOn(agentStore, 'get').mockImplementation(async (id) => {
      if (promptBuilt) return { id: 'qa-1', projectId: 'proj', taskId: 'stolen-task', updatedAt: NOW };
      return realGet(id);
    });

    await expect(manager.continueSession(t.id, 'qa-1', 'recheck')).resolves.toBe(false);
  });

  it('post-approve skips the paste when the completion token rotates before injection', async () => {
    const t = await seedTask({ status: 'approved' });
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      workdir: '/tmp/repo/.baxian-worktrees/wt',
    });
    stubEnsureSession(manager);
    stubInject(manager, async () => ({ acked: true, composerDelivered: true }));
    let calls = 0;
    vi.spyOn(manager, 'getPostApproveCompletion').mockImplementation(async () => {
      calls += 1;
      return { token: calls === 1 ? 'tok' : 'rotated', approvedHeadSha: 'sha' };
    });

    await expect(manager.continueSession(t.id, 'dev-1', 'post-approve', { signalToken: 'tok' }))
      .resolves.toBe(false);
  });
});

describe('AgentManager need-input watermark persistence', () => {
  const commit = (over: Partial<{ agentId: string; taskId: string; epoch: number; askSeq: number; answeredSeq: number }> = {}) =>
    manager.commitNeedInputWatermark({
      agentId: 'dev-1', taskId: 't-wm', epoch: 1, askSeq: 1, answeredSeq: 0, ...over,
    });

  async function seedWatermarkAgent(needInput?: { epoch: number; askSeq?: number; answeredSeq?: number; at?: string }): Promise<void> {
    await seedAgent({ id: 'dev-1', taskId: 't-wm', ...(needInput ? { needInput } : {}) });
  }

  it('fences on taskId and on a stale epoch, in both directions', async () => {
    await seedWatermarkAgent({ epoch: 2 });
    expect(await commit({ taskId: 'other-task' })).toBe('fenced');
    expect(await commit({ epoch: 1, askSeq: 1, answeredSeq: 0 })).toBe('fenced');
    expect(await commit({ epoch: 1, askSeq: 1, answeredSeq: 1 })).toBe('fenced');
    expect((await agentStore.get('dev-1'))?.needInput).toEqual({ epoch: 2 });
  });

  it('merges monotonically within the epoch and derives the badge projection', async () => {
    await seedWatermarkAgent({ epoch: 1 });
    expect(await commit({ askSeq: 1, answeredSeq: 0 })).toBe('ok');
    const lit = (await agentStore.get('dev-1'))?.needInput;
    expect(lit).toMatchObject({ epoch: 1, askSeq: 1, answeredSeq: 0 });
    expect(lit?.at).toBeDefined();

    expect(await commit({ askSeq: 1, answeredSeq: 1 })).toBe('ok');
    const cleared = (await agentStore.get('dev-1'))?.needInput;
    expect(cleared).toEqual({ epoch: 1, askSeq: 1, answeredSeq: 1 });

    expect(await commit({ askSeq: 1, answeredSeq: 0 })).toBe('ok');
    expect((await agentStore.get('dev-1'))?.needInput).toEqual({ epoch: 1, askSeq: 1, answeredSeq: 1 });
  });

  it('writes a tombstone onto an empty same-epoch watermark (first-write-error recovery path)', async () => {
    await seedWatermarkAgent({ epoch: 3 });
    expect(await commit({ epoch: 3, askSeq: 1, answeredSeq: 1 })).toBe('ok');
    expect((await agentStore.get('dev-1'))?.needInput).toEqual({ epoch: 3, askSeq: 1, answeredSeq: 1 });
  });

  it('treats legacy flat needInputAt as an epoch-0 lit watermark via parse migration', async () => {
    await seedAgent({ id: 'dev-1', taskId: 't-wm' });
    const raw = { id: 'dev-1', projectId: 'proj', taskId: 't-wm', updatedAt: NOW, needInputAt: '2026-07-06T10:00:00.000Z' };
    await agentStore.update('dev-1', () => raw as never);
    const migrated = await agentStore.get('dev-1');
    expect(migrated?.needInput).toEqual({
      epoch: 0, askSeq: 1, answeredSeq: 0, at: '2026-07-06T10:00:00.000Z',
    });
    expect(await commit({ epoch: 0, askSeq: 1, answeredSeq: 1 })).toBe('ok');
    expect((await agentStore.get('dev-1'))?.needInput).toEqual({ epoch: 0, askSeq: 1, answeredSeq: 1 });
  });

  it('bump(fresh) strips seqs, bump(restore) carries them; both advance the epoch', async () => {
    await seedWatermarkAgent({ epoch: 4, askSeq: 2, answeredSeq: 1, at: NOW });
    const restored = await manager['bumpNeedInputEpochForArm']('dev-1', 't-wm', 'restore');
    expect(restored).toEqual({ wm: { epoch: 5, askSeq: 2, answeredSeq: 1 }, bumped: true });
    expect((await agentStore.get('dev-1'))?.needInput).toMatchObject({ epoch: 5, askSeq: 2, answeredSeq: 1 });
    expect((await agentStore.get('dev-1'))?.needInput?.at).toBeDefined();

    const fresh = await manager['bumpNeedInputEpochForArm']('dev-1', 't-wm', 'fresh');
    expect(fresh).toEqual({ wm: { epoch: 6, askSeq: 0, answeredSeq: 0 }, bumped: true });
    expect((await agentStore.get('dev-1'))?.needInput).toEqual({ epoch: 6, askSeq: 0, answeredSeq: 0 });
  });

  it('bump refuses to touch a foreign-task binding and reports no generation', async () => {
    await seedAgent({ id: 'dev-1', taskId: 'other-task', needInput: { epoch: 9 } });
    const wm = await manager['bumpNeedInputEpochForArm']('dev-1', 't-wm', 'fresh');
    expect(wm).toEqual({ wm: null, bumped: false });
    expect((await agentStore.get('dev-1'))?.needInput).toEqual({ epoch: 9 });
  });

  it('queues a failed commit and converges it on the retry pass', async () => {
    await seedWatermarkAgent({ epoch: 1 });
    const real = agentStore.update.bind(agentStore);
    const failing = vi.spyOn(agentStore, 'update').mockRejectedValueOnce(new Error('store down'));
    expect(await commit({ askSeq: 1, answeredSeq: 0 })).toBe('error');
    failing.mockImplementation(real as never);
    await manager['needInputRetryPass']();
    expect((await agentStore.get('dev-1'))?.needInput).toMatchObject({ epoch: 1, askSeq: 1, answeredSeq: 0 });
    expect(manager['needInputRetry'].size).toBe(0);
  });

  it('keeps a queued item that was raised mid-retry (snapshot-conditional dequeue)', async () => {
    await seedWatermarkAgent({ epoch: 1 });
    vi.spyOn(agentStore, 'update').mockRejectedValueOnce(new Error('down'));
    expect(await commit({ askSeq: 1, answeredSeq: 1 })).toBe('error');
    const key = manager['needInputRetryKey']('dev-1', 't-wm', 1);
    expect(manager['needInputRetry'].get(key)).toEqual({ askSeq: 1, answeredSeq: 1 });
    // A newer edge raises the queued intent after the write we are settling.
    manager['enqueueNeedInputRetry'](key, 2, 1);
    manager['settleNeedInputRetry'](key, 1, 1, 'ok');
    expect(manager['needInputRetry'].get(key)).toEqual({ askSeq: 2, answeredSeq: 1 });
    manager['settleNeedInputRetry'](key, 2, 1, 'ok');
    expect(manager['needInputRetry'].has(key)).toBe(false);
  });

  it('drops stale-generation queue items as fenced on retry', async () => {
    await seedWatermarkAgent({ epoch: 2 });
    manager['enqueueNeedInputRetry'](manager['needInputRetryKey']('dev-1', 't-wm', 1), 1, 0);
    await manager['needInputRetryPass']();
    expect(manager['needInputRetry'].size).toBe(0);
    expect((await agentStore.get('dev-1'))?.needInput).toEqual({ epoch: 2 });
  });

  it('confirmNeedInputAnswered settles the open question from the store', async () => {
    await seedWatermarkAgent({ epoch: 1, askSeq: 2, answeredSeq: 1, at: NOW });
    await manager.notifyHumanTerminalInput('dev-1');
    expect((await agentStore.get('dev-1'))?.needInput).toEqual({ epoch: 1, askSeq: 2, answeredSeq: 2 });
  });

  it('confirmNeedInputAnswered sees a queue-only pending ask and tombstones it (r7-f8 chain)', async () => {
    await seedWatermarkAgent({ epoch: 1 });
    vi.spyOn(agentStore, 'update').mockRejectedValueOnce(new Error('down'));
    expect(await commit({ askSeq: 1, answeredSeq: 0 })).toBe('error');
    await manager.notifyHumanTerminalInput('dev-1');
    expect((await agentStore.get('dev-1'))?.needInput).toEqual({ epoch: 1, askSeq: 1, answeredSeq: 1 });
    await manager['needInputRetryPass']();
    expect((await agentStore.get('dev-1'))?.needInput).toEqual({ epoch: 1, askSeq: 1, answeredSeq: 1 });
  });

  it('release(waiting) strips the watermark and bumps the epoch on both success branches', async () => {
    const t = await seedTask({ id: 't-wm', status: 'review', signalToken: 'tokRel1234567' });
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      needInput: { epoch: 3, askSeq: 1, answeredSeq: 0, at: NOW },
    });
    await acquireBoundLock('dev-1');
    await manager.releaseAgentForTask('dev-1', t.id, 'waiting');
    expect((await agentStore.get('dev-1'))?.needInput).toEqual({ epoch: 4 });
  });

  it('release(waiting, clearAwaitingHuman) whitelist branch also bumps (restart-repl path)', async () => {
    const t = await seedTask({ id: 't-wm', status: 'review', signalToken: 'tokRel1234567' });
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'agent_dialog_pending', awaitingSince: NOW, awaitingNonce: 'n1',
      needInput: { epoch: 7, askSeq: 2, answeredSeq: 1, at: NOW },
    });
    await acquireBoundLock('dev-1');
    await manager.releaseAgentForTask('dev-1', t.id, 'waiting', {
      allowAwaitingHuman: true,
      clearAwaitingHuman: true,
      expectedHold: { phase: 'agent_dialog_pending', since: NOW, nonce: 'n1' },
    });
    const binding = await agentStore.get('dev-1');
    expect(binding?.status).toBeUndefined();
    expect(binding?.needInput).toEqual({ epoch: 8 });
  });

  it('a stale-generation write after the release gate fences instead of relighting', async () => {
    const t = await seedTask({ id: 't-wm', status: 'review', signalToken: 'tokRel1234567' });
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      needInput: { epoch: 3, askSeq: 1, answeredSeq: 0, at: NOW },
    });
    await acquireBoundLock('dev-1');
    await manager.releaseAgentForTask('dev-1', t.id, 'waiting');
    expect(await commit({ epoch: 3, askSeq: 1, answeredSeq: 0 })).toBe('fenced');
    expect((await agentStore.get('dev-1'))?.needInput).toEqual({ epoch: 4 });
  });
});

describe('AgentManager need-input cross-layer (real watcher)', () => {
  interface CrossStreamer {
    subscribeAtomic: (cbs: { onVisible: (data: string) => void; onSessionGone: () => void }) => Promise<{
      snapshot: { data: string };
      unsubscribe: () => void;
    }>;
    triggerLive: (data: string) => void;
    triggerSessionGone: () => void;
    failNextSubscribe: () => void;
    holdNextSubscribe: () => { release: () => void };
    setSnapshotData: (data: string) => void;
  }

  function makeCrossLayer(): { m: AgentManager; streamer: CrossStreamer; captured: BaxianEvent[] } {
    const lives: Array<(data: string) => void> = [];
    const gones: Array<() => void> = [];
    // Mirrors PaneStreamer: one decoder bound to the whole stream, shared by every subscription.
    const decoder = new VisibleTextExtractor();
    let failNext = false;
    const holdQueue: Promise<void>[] = [];
    let snapshotData = '';
    const streamer: CrossStreamer = {
      subscribeAtomic: async (cbs) => {
        if (failNext) {
          failNext = false;
          throw new Error('subscribe transport down');
        }
        const gate = holdQueue.shift();
        if (gate) await gate;
        lives.push(cbs.onVisible);
        gones.push(cbs.onSessionGone);
        return { snapshot: { data: snapshotData }, unsubscribe: () => undefined };
      },
      triggerLive: (data) => {
        const visible = decoder.write(data);
        for (const fn of [...lives]) fn(visible);
      },
      triggerSessionGone: () => { for (const fn of [...gones]) fn(); },
      failNextSubscribe: () => { failNext = true; },
      holdNextSubscribe: () => {
        let release!: () => void;
        holdQueue.push(new Promise<void>(resolve => { release = resolve; }));
        return { release };
      },
      setSnapshotData: (data) => { snapshotData = data; },
    };
    const captured: BaxianEvent[] = [];
    const m = makeManager({
      paneStreamerManager: { ensure: () => streamer } as never,
      eventBus: {
        emit: async (event: BaxianEvent) => { captured.push(event); },
        subscribe: () => () => undefined,
      } as never,
    });
    return { m, streamer, captured };
  }

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 4; i++) {
      await new Promise<void>(resolve => setImmediate(resolve));
      await new Promise<void>(resolve => setTimeout(resolve, 10));
    }
  };

  const armVia = (
    m: AgentManager,
    token: string,
    opts: Record<string, unknown> = {},
  ): Promise<boolean> =>
    (m as never as {
      setupPhaseSignalWatcher: (
        taskId: string, agentId: string, kinds: readonly string[], token: string, opts: Record<string, unknown>,
      ) => Promise<boolean>;
    }).setupPhaseSignalWatcher('t-xl', 'dev-1', ['pr-created'], token, opts);

  async function seedCross(needInput?: AgentBindingFacts['needInput']): Promise<void> {
    await seedTask({ id: 't-xl', status: 'in_progress', signalToken: 'tokXL12345678' });
    await seedAgent({ id: 'dev-1', taskId: 't-xl', paneId: '%0', ...(needInput ? { needInput } : {}) });
  }

  it.each(['return', 'throw'] as const)(
    'releases a replay hand-off claim when continueSession exits before arm (%s)',
    async (outcome) => {
      const { m } = makeCrossLayer();
      const oldToken = 'tokXL12345678';
      await seedCross();
      expect(await armVia(m, oldToken, { needInputMode: 'fresh' })).toBe(true);
      const continueSpy = vi.spyOn(m, 'continueSession');
      if (outcome === 'return') continueSpy.mockResolvedValue(false);
      else continueSpy.mockRejectedValue(new Error('ensure failed before arm'));

      expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 't-xl')).toBe(true);

      const newToken = (await taskStore.get('t-xl'))!.signalToken!;
      expect(newToken).not.toBe(oldToken);
      expect(m['phaseSignalWatcher']!.has('t-xl', 'dev-1')).toBe(false);
      expect((await agentStore.get('dev-1'))?.awaitingPhase).toBe('restart-redispatch-failed');
      const successorClaim = m['phaseSignalWatcher']!.claimArm({
        taskId: 't-xl', agentId: 'dev-1', token: 'successor12345', replaceFromToken: newToken,
        onlyReplaceOwnToken: true, replaceScope: 'agent',
      });
      expect(successorClaim).not.toBeNull();
      m['phaseSignalWatcher']!.releaseArm(successorClaim);
    },
  );

  it('rejects a conflicting pending hand-off before rotating persistent task state', async () => {
    const { m } = makeCrossLayer();
    const oldToken = 'tokXL12345678';
    await seedCross();
    expect(await armVia(m, oldToken, { needInputMode: 'fresh' })).toBe(true);
    const blocker = m['phaseSignalWatcher']!.claimArm({
      taskId: 't-xl', agentId: 'dev-1', token: 'blocker123456', replaceFromToken: oldToken,
      onlyReplaceOwnToken: true, replaceScope: 'agent',
    });
    expect(blocker).not.toBeNull();
    const setSpy = vi.spyOn(taskStore, 'set');
    const continueSpy = vi.spyOn(m, 'continueSession');

    expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 't-xl')).toBe(false);

    expect((await taskStore.get('t-xl'))?.signalToken).toBe(oldToken);
    expect(setSpy).not.toHaveBeenCalled();
    expect(continueSpy).not.toHaveBeenCalled();
    expect(m['phaseSignalWatcher']!.has('t-xl', 'dev-1')).toBe(true);
    m['phaseSignalWatcher']!.releaseArm(blocker);
  });

  it.each(['installed', 'subscribe-failed'] as const)(
    'releases the replay claim after watcher start settles (%s)',
    async (outcome) => {
      const { m, streamer } = makeCrossLayer();
      const oldToken = 'tokXL12345678';
      await seedCross();
      expect(await armVia(m, oldToken, { needInputMode: 'fresh' })).toBe(true);
      if (outcome === 'subscribe-failed') streamer.failNextSubscribe();
      vi.spyOn(m, 'continueSession').mockImplementation(async (...args) => {
        const arm = (args[3] as ContinueSessionOpts).armBeforeInject;
        return arm ? arm({}) : true;
      });

      expect(await m.redispatchTaskPromptAfterReplRestart('dev-1', 't-xl')).toBe(true);

      const newToken = (await taskStore.get('t-xl'))!.signalToken!;
      expect(m['phaseSignalWatcher']!.has('t-xl', 'dev-1')).toBe(outcome === 'installed');
      const successorClaim = m['phaseSignalWatcher']!.claimArm({
        taskId: 't-xl', agentId: 'dev-1', token: 'successor67890', replaceFromToken: newToken,
        onlyReplaceOwnToken: true, replaceScope: 'agent',
      });
      expect(successorClaim).not.toBeNull();
      m['phaseSignalWatcher']!.releaseArm(successorClaim);
    },
  );

  it('restore re-arm persists the merged watermark so an error-queued answer cannot re-stick the badge', async () => {
    const { m, streamer } = makeCrossLayer();
    await seedCross();
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'fresh' })).toBe(true);

    streamer.triggerLive('[bx:need-input:tokXL12345678:1]\n');
    await flush();
    expect((await agentStore.get('dev-1'))?.needInput).toMatchObject({ epoch: 1, askSeq: 1, answeredSeq: 0 });

    const real = agentStore.update.bind(agentStore);
    const spy = vi.spyOn(agentStore, 'update').mockRejectedValueOnce(new Error('store down'));
    streamer.triggerLive('[bx:input-received:tokXL12345678:1]\n');
    await flush();
    spy.mockImplementation(real as never);
    expect((await agentStore.get('dev-1'))?.needInput?.at).toBeDefined();

    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'restore', onlyReplaceOwnToken: true })).toBe(true);
    await flush();
    const wm = (await agentStore.get('dev-1'))?.needInput;
    expect(wm).toMatchObject({ epoch: 2, askSeq: 1, answeredSeq: 1 });
    expect(wm?.at).toBeUndefined();
  });

  it('a fresh same-token replay does not inherit old ordinals, so the new prompt lights from 1', async () => {
    const { m, streamer } = makeCrossLayer();
    await seedCross();
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'fresh' })).toBe(true);
    streamer.triggerLive('[bx:need-input:tokXL12345678:3]\n');
    await flush();
    expect((await agentStore.get('dev-1'))?.needInput).toMatchObject({ epoch: 1, askSeq: 3 });

    expect(await armVia(m, 'tokXL12345678', {
      needInputMode: 'fresh', skipSnapshot: true, onlyReplaceOwnToken: true,
    })).toBe(true);
    streamer.triggerLive('[bx:need-input:tokXL12345678:1]\n');
    await flush();
    const wm = (await agentStore.get('dev-1'))?.needInput;
    expect(wm).toMatchObject({ epoch: 2, askSeq: 1, answeredSeq: 0 });
    expect(wm?.at).toBeDefined();
  });

  it('an own-token-fenced arm neither bumps the epoch nor fences the surviving watcher', async () => {
    const { m, streamer } = makeCrossLayer();
    await seedCross();
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'fresh' })).toBe(true);
    const epochBefore = (await agentStore.get('dev-1'))?.needInput?.epoch;

    expect(await armVia(m, 'tokOTHER123456', {
      needInputMode: 'fresh', onlyReplaceOwnToken: true,
    })).toBe(false);
    expect((await agentStore.get('dev-1'))?.needInput?.epoch).toBe(epochBefore);

    streamer.triggerLive('[bx:need-input:tokXL12345678:1]\n');
    await flush();
    expect((await agentStore.get('dev-1'))?.needInput).toMatchObject({ epoch: 1, askSeq: 1, answeredSeq: 0 });
  });

  it('a failed re-subscribe migrates the surviving entry onto the bumped generation', async () => {
    const { m, streamer } = makeCrossLayer();
    await seedCross();
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'fresh' })).toBe(true);

    streamer.failNextSubscribe();
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'restore', onlyReplaceOwnToken: true })).toBe(false);
    expect((await agentStore.get('dev-1'))?.needInput?.epoch).toBe(2);

    streamer.triggerLive('[bx:need-input:tokXL12345678:1]\n');
    await flush();
    expect((await agentStore.get('dev-1'))?.needInput).toMatchObject({ epoch: 2, askSeq: 1, answeredSeq: 0 });
  });

  it('a failed epoch bump arms with the badge disabled instead of ghost-fencing (watch survives)', async () => {
    const { m, streamer } = makeCrossLayer();
    await seedCross({ epoch: 5 });
    const real = agentStore.update.bind(agentStore);
    const spy = vi.spyOn(agentStore, 'update').mockRejectedValueOnce(new Error('store down'));
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'fresh' })).toBe(true);
    spy.mockImplementation(real as never);

    // Signal watching works; badge commits are disabled for this degraded generation.
    streamer.triggerLive('[bx:need-input:tokXL12345678:1]\n');
    await flush();
    expect((await agentStore.get('dev-1'))?.needInput).toEqual({ epoch: 5 });

    // The next successful arm re-establishes the generation and the badge lights again.
    expect(await armVia(m, 'tokXL12345678', {
      needInputMode: 'fresh', skipSnapshot: true, onlyReplaceOwnToken: true,
    })).toBe(true);
    streamer.triggerLive('[bx:need-input:tokXL12345678:1]\n');
    await flush();
    expect((await agentStore.get('dev-1'))?.needInput).toMatchObject({ epoch: 6, askSeq: 1, answeredSeq: 0 });
  });

  it('restore migrates an answer whose write is still in flight when the entry already exited', async () => {
    const { m, streamer } = makeCrossLayer();
    await seedCross();
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'fresh' })).toBe(true);
    streamer.triggerLive('[bx:need-input:tokXL12345678:1]\n');
    await flush();
    expect((await agentStore.get('dev-1'))?.needInput).toMatchObject({ epoch: 1, askSeq: 1, answeredSeq: 0 });

    // The answer's store write hangs in the chain; the session dies while it is in flight.
    const real = agentStore.update.bind(agentStore);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const spy = vi.spyOn(agentStore, 'update').mockImplementationOnce(
      (async (_id: string, _updater: never) => {
        await gate;
        throw new Error('store down');
      }) as never,
    );
    streamer.triggerLive('[bx:input-received:tokXL12345678:1]\n');
    streamer.triggerSessionGone();
    spy.mockImplementation(real as never);

    // Restore re-arm starts while the answer write is still unsettled: the in-flight
    // ledger must carry {1,1} into the bump snapshot.
    const armP = armVia(m, 'tokXL12345678', { needInputMode: 'restore', skipSnapshot: true });
    release();
    expect(await armP).toBe(true);
    await flush();
    const wm = (await agentStore.get('dev-1'))?.needInput;
    expect(wm).toMatchObject({ epoch: 2, askSeq: 1, answeredSeq: 1 });
    expect(wm?.at).toBeUndefined();
    await m['needInputRetryPass']();
    expect(m['needInputRetry'].size).toBe(0);
  });

  it('an answer arriving after the bump updater ran but before its write settled is lifted to the new epoch', async () => {
    const { m, streamer } = makeCrossLayer();
    await seedCross();
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'fresh' })).toBe(true);
    streamer.triggerLive('[bx:need-input:tokXL12345678:1]\n');
    await flush();

    // Bump write fully lands but its promise is held back from the caller; the old
    // watcher (still on the old generation, migration pending) consumes the answer,
    // whose own write fails into the retry queue; the session then dies.
    const real = agentStore.update.bind(agentStore);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const spy = vi.spyOn(agentStore, 'update')
      .mockImplementationOnce((async (id: string, updater: never) => {
        const result = await real(id, updater as never);
        await gate;
        return result;
      }) as never)
      .mockImplementationOnce((async () => {
        throw new Error('store down');
      }) as never);
    const armP = armVia(m, 'tokXL12345678', { needInputMode: 'restore', skipSnapshot: true });
    await new Promise<void>(resolve => setImmediate(resolve));
    streamer.triggerLive('[bx:input-received:tokXL12345678:1]\n');
    await new Promise<void>(resolve => setImmediate(resolve));
    streamer.triggerSessionGone();
    release();
    expect(await armP).toBe(true);
    spy.mockRestore();
    await flush();
    await m['needInputRetryPass']();

    const wm = (await agentStore.get('dev-1'))?.needInput;
    expect(wm).toMatchObject({ epoch: 2, askSeq: 1, answeredSeq: 1 });
    expect(wm?.at).toBeUndefined();
    expect(m['needInputRetry'].size).toBe(0);
  });

  it('an answer consumed between the restore bump and the replacement subscribe still clears the badge', async () => {
    const { m, streamer } = makeCrossLayer();
    await seedCross();
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'fresh' })).toBe(true);
    streamer.triggerLive('[bx:need-input:tokXL12345678:1]\n');
    await flush();
    expect((await agentStore.get('dev-1'))?.needInput).toMatchObject({ epoch: 1, askSeq: 1, answeredSeq: 0 });

    // The replacement's subscribe hangs; the bump has already advanced the store. The
    // old entry (migrated onto the new generation) consumes the answer, then dies.
    const gate = streamer.holdNextSubscribe();
    const armP = armVia(m, 'tokXL12345678', { needInputMode: 'restore', skipSnapshot: true });
    await vi.waitFor(async () => {
      expect((await agentStore.get('dev-1'))?.needInput?.epoch).toBe(2);
    });
    streamer.triggerLive('[bx:input-received:tokXL12345678:1]\n');
    await flush();
    streamer.triggerSessionGone();
    gate.release();
    expect(await armP).toBe(true);
    await flush();

    const wm = (await agentStore.get('dev-1'))?.needInput;
    expect(wm).toMatchObject({ epoch: 2, askSeq: 1, answeredSeq: 1 });
    expect(wm?.at).toBeUndefined();
  });

  it('restore migrates an answer that starts while the bump is queued in the store chain', async () => {
    const { m, streamer } = makeCrossLayer();
    await seedCross();
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'fresh' })).toBe(true);
    streamer.triggerLive('[bx:need-input:tokXL12345678:1]\n');
    await flush();
    expect((await agentStore.get('dev-1'))?.needInput).toMatchObject({ epoch: 1, askSeq: 1, answeredSeq: 0 });

    // Every store write waits on one gate: the restore bump is issued FIRST, then the
    // answer commit starts (ledger-registered) while the bump is still queued, then the
    // session dies. On release the bump updater must still see the in-flight answer.
    const real = agentStore.update.bind(agentStore);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const spy = vi.spyOn(agentStore, 'update').mockImplementation(
      (async (id: string, updater: never) => {
        await gate;
        return real(id, updater as never);
      }) as never,
    );
    const armP = armVia(m, 'tokXL12345678', { needInputMode: 'restore', skipSnapshot: true });
    await new Promise<void>(resolve => setImmediate(resolve));
    streamer.triggerLive('[bx:input-received:tokXL12345678:1]\n');
    streamer.triggerSessionGone();
    release();
    expect(await armP).toBe(true);
    spy.mockRestore();
    await flush();

    const wm = (await agentStore.get('dev-1'))?.needInput;
    expect(wm).toMatchObject({ epoch: 2, askSeq: 1, answeredSeq: 1 });
    expect(wm?.at).toBeUndefined();
  });

  it('the ledger holds the intent until an error is queued, so a racing restore never misses it', async () => {
    const { m, streamer } = makeCrossLayer();
    await seedCross();
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'fresh' })).toBe(true);
    streamer.triggerLive('[bx:need-input:tokXL12345678:1]\n');
    await flush();

    // The answer write settles as an error; a restore snapshot taken in ANY later
    // promise job must see the intent in the ledger or in the retry queue.
    const real = agentStore.update.bind(agentStore);
    const failing = Promise.reject(new Error('store down'));
    failing.catch(() => undefined);
    const spy = vi.spyOn(agentStore, 'update').mockImplementationOnce((() => failing) as never);
    streamer.triggerLive('[bx:input-received:tokXL12345678:1]\n');
    streamer.triggerSessionGone();
    spy.mockImplementation(real as never);
    // Schedule the restore reaction directly behind the write settle, racing the
    // commit continuation that moves the intent from the ledger to the queue.
    const armP = failing.catch(() => undefined).then(() =>
      armVia(m, 'tokXL12345678', { needInputMode: 'restore', skipSnapshot: true }));
    expect(await armP).toBe(true);
    await flush();
    const wm = (await agentStore.get('dev-1'))?.needInput;
    expect(wm).toMatchObject({ epoch: 2, askSeq: 1, answeredSeq: 1 });
    expect(wm?.at).toBeUndefined();
  });

  it('web input does not confirm an ask that lands while the clear write is still in flight', async () => {
    const { m, streamer } = makeCrossLayer();
    await seedCross();
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'fresh' })).toBe(true);
    streamer.triggerLive('[bx:need-input:tokXL12345678:1]\n');
    await flush();
    expect((await agentStore.get('dev-1'))?.needInput).toMatchObject({ epoch: 1, askSeq: 1, answeredSeq: 0 });

    // Hold the rearm's clear write in the store chain; question 2 arrives meanwhile.
    const real = agentStore.update.bind(agentStore);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const spy = vi.spyOn(agentStore, 'update').mockImplementationOnce(
      (async (id: string, updater: never) => {
        await gate;
        return real(id, updater);
      }) as never,
    );
    const notifyP = m.notifyHumanTerminalInput('dev-1');
    streamer.triggerLive('[bx:need-input:tokXL12345678:2]\n');
    release();
    await notifyP;
    spy.mockRestore();
    await flush();

    const wmAfter = (await agentStore.get('dev-1'))?.needInput;
    expect(wmAfter).toMatchObject({ epoch: 1, askSeq: 2, answeredSeq: 1 });
    expect(wmAfter?.at).toBeDefined();
  });

  it('recovers an offline current-token answer while ignoring old-token replay history', async () => {
    const { m, streamer } = makeCrossLayer();
    await seedCross();
    const oldToken = 'tokOLD1234567';
    const newToken = 'tokNEW1234567';
    expect(await armVia(m, oldToken, { needInputMode: 'fresh' })).toBe(true);
    streamer.triggerLive(`[bx:need-input:${oldToken}:1]\n`);
    await flush();

    expect(await armVia(m, newToken, {
      needInputMode: 'fresh', skipSnapshot: true, onlyReplaceOwnToken: true,
      replaceFromToken: oldToken, replaceScope: 'agent',
    })).toBe(true);
    streamer.triggerLive(`[bx:need-input:${newToken}:1]\n`);
    await flush();
    expect((await agentStore.get('dev-1'))?.needInput).toMatchObject({ askSeq: 1, answeredSeq: 0 });

    m['phaseSignalWatcher']!.stopAgent('t-xl', 'dev-1');
    streamer.setSnapshotData(
      `old [bx:need-input:${oldToken}:1] old [bx:input-received:${oldToken}:1] `
      + `current [bx:need-input:${newToken}:1] offline [bx:input-received:${newToken}:1]`,
    );
    expect(await armVia(m, newToken, { needInputMode: 'restore' })).toBe(true);
    await flush();
    const wm = (await agentStore.get('dev-1'))?.needInput;
    expect(wm).toMatchObject({ askSeq: 1, answeredSeq: 1 });
    expect(wm?.at).toBeUndefined();
  });

  it('a rotated token is unaffected by an earlier token\'s replay history', async () => {
    const { m, streamer } = makeCrossLayer();
    await seedCross();
    expect(await armVia(m, 'tokOLD1234567', { needInputMode: 'fresh' })).toBe(true);
    streamer.triggerLive('[bx:need-input:tokOLD1234567:1]\n');
    await flush();
    expect(await armVia(m, 'tokOLD1234567', {
      needInputMode: 'fresh', skipSnapshot: true, onlyReplaceOwnToken: true,
    })).toBe(true);

    // New pass, new token: its own question and its offline answer recover normally.
    expect(await armVia(m, 'tokNEW1234567', { needInputMode: 'fresh', skipSnapshot: true })).toBe(true);
    streamer.triggerLive('[bx:need-input:tokNEW1234567:1]\n');
    await flush();
    expect((await agentStore.get('dev-1'))?.needInput?.at).toBeDefined();

    // The new token never had a replay, and the redraw put its answer above its ask.
    streamer.setSnapshotData(
      'answered [bx:input-received:tokNEW1234567:1] old token noise '
      + '[bx:need-input:tokOLD1234567:1] current [bx:need-input:tokNEW1234567:1]',
    );
    expect(await armVia(m, 'tokNEW1234567', { needInputMode: 'restore' })).toBe(true);
    await flush();
    const wm = (await agentStore.get('dev-1'))?.needInput;
    expect(wm).toMatchObject({ askSeq: 1, answeredSeq: 1 });
    expect(wm?.at).toBeUndefined();
  });

  it('a rotated fresh replay is not relit by the predecessor token left in a later snapshot', async () => {
    const { m, streamer } = makeCrossLayer();
    await seedCross();
    const oldToken = 'tokOLD1234567';
    const newToken = 'tokNEW1234567';
    expect(await armVia(m, oldToken, { needInputMode: 'fresh' })).toBe(true);
    streamer.triggerLive(`[bx:need-input:${oldToken}:1]\n`);
    await flush();
    expect((await agentStore.get('dev-1'))?.needInput?.at).toBeDefined();

    expect(await armVia(m, newToken, {
      needInputMode: 'fresh', skipSnapshot: true, onlyReplaceOwnToken: true,
      replaceFromToken: oldToken, replaceScope: 'agent',
    })).toBe(true);
    expect((await agentStore.get('dev-1'))?.needInput).toMatchObject({ askSeq: 0, answeredSeq: 0 });

    m['phaseSignalWatcher']!.stopAgent('t-xl', 'dev-1');
    streamer.setSnapshotData(`stale scrollback [bx:need-input:${oldToken}:1]`);
    expect(await armVia(m, newToken, { needInputMode: 'restore' })).toBe(true);
    await flush();
    const wm = (await agentStore.get('dev-1'))?.needInput;
    expect(wm).toMatchObject({ askSeq: 0, answeredSeq: 0 });
    expect(wm?.at).toBeUndefined();
  });

  it('web input falls back to the store when only another task has a live watcher', async () => {
    const { m, streamer } = makeCrossLayer();
    await seedCross({ epoch: 1, askSeq: 1, answeredSeq: 0, at: NOW });
    // A leftover watcher of a previous task on the same agent.
    await m['phaseSignalWatcher']!.start({
      taskId: 'old-task', projectId: 'proj', agentId: 'dev-1',
      expectedKinds: 'pr-created', token: 'tokOLD1234567',
      needInput: { epoch: 1, askSeq: 0, answeredSeq: 0 },
    });
    streamer.triggerLive('');

    await m.notifyHumanTerminalInput('dev-1');
    const wm = (await agentStore.get('dev-1'))?.needInput;
    expect(wm).toMatchObject({ epoch: 1, askSeq: 1, answeredSeq: 1 });
    expect(wm?.at).toBeUndefined();
  });

  it('recovers an offline reply AND the follow-up question the agent asked next', async () => {
    const { m, streamer } = makeCrossLayer();
    await seedCross({ epoch: 1, askSeq: 1, answeredSeq: 0, at: NOW });
    streamer.setSnapshotData(
      'replied during downtime [bx:input-received:tokXL12345678:1] '
      + 'then asked again [bx:need-input:tokXL12345678:2]',
    );
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'restore' })).toBe(true);
    await flush();
    const wm = (await agentStore.get('dev-1'))?.needInput;
    expect(wm).toMatchObject({ epoch: 2, askSeq: 2, answeredSeq: 1 });
    expect(wm?.at).toBeDefined();
  });

  it('read-back after a failed bump also picks up questions owed by the retry queue', async () => {
    const { m, streamer } = makeCrossLayer();
    await seedCross({ epoch: 1, askSeq: 1, answeredSeq: 1 });
    // A later question whose write failed lives only in the queue.
    m['enqueueNeedInputRetry'](m['needInputRetryKey']('dev-1', 't-xl', 1), 2, 1);
    const real = agentStore.update.bind(agentStore);
    const spy = vi.spyOn(agentStore, 'update').mockRejectedValueOnce(new Error('store down'));
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'restore', skipSnapshot: true })).toBe(true);
    spy.mockImplementation(real as never);

    // The entry knows question 2 is open, so its answer is not swallowed.
    streamer.triggerLive('[bx:input-received:tokXL12345678:2]\n');
    await flush();
    const wm = (await agentStore.get('dev-1'))?.needInput;
    expect(wm).toMatchObject({ epoch: 1, askSeq: 2, answeredSeq: 2 });
    expect(wm?.at).toBeUndefined();
  });

  it('recovers an offline reply: restore arm consumes the seq-matched answer from the snapshot', async () => {
    const { m, streamer } = makeCrossLayer();
    await seedCross({ epoch: 1, askSeq: 1, answeredSeq: 0, at: NOW });
    streamer.setSnapshotData(`replied during downtime [bx:input-received:tokXL12345678:1]`);
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'restore' })).toBe(true);
    await flush();
    const wm = (await agentStore.get('dev-1'))?.needInput;
    expect(wm).toMatchObject({ epoch: 2, askSeq: 1, answeredSeq: 1 });
    expect(wm?.at).toBeUndefined();
  });

  it('restore re-arm after session-gone merges the queued answer watermark before clearing the queue', async () => {
    const { m, streamer } = makeCrossLayer();
    await seedCross();
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'fresh' })).toBe(true);

    streamer.triggerLive('[bx:need-input:tokXL12345678:1]\n');
    await flush();
    expect((await agentStore.get('dev-1'))?.needInput).toMatchObject({ epoch: 1, askSeq: 1, answeredSeq: 0 });

    // The answer's persistence fails and lands in the retry queue; the session then dies,
    // deleting the entry — the queue holds the only proof the user answered.
    const real = agentStore.update.bind(agentStore);
    const spy = vi.spyOn(agentStore, 'update').mockRejectedValueOnce(new Error('store down'));
    streamer.triggerLive('[bx:input-received:tokXL12345678:1]\n');
    await flush();
    spy.mockImplementation(real as never);
    streamer.triggerSessionGone();
    await flush();
    expect((await agentStore.get('dev-1'))?.needInput?.at).toBeDefined();

    expect(await armVia(m, 'tokXL12345678', {
      needInputMode: 'restore', skipSnapshot: true,
    })).toBe(true);
    const wm = (await agentStore.get('dev-1'))?.needInput;
    expect(wm).toMatchObject({ epoch: 2, askSeq: 1, answeredSeq: 1 });
    expect(wm?.at).toBeUndefined();
  });

  it('a superseded older-generation intent is not transplanted onto the restore watermark', async () => {
    const { m } = makeCrossLayer();
    // Store already moved past the old question (a fresh redispatch stripped it).
    await seedCross({ epoch: 5, askSeq: 0, answeredSeq: 0 });
    // A leftover intent from a generation the fresh prompt superseded.
    m['enqueueNeedInputRetry'](m['needInputRetryKey']('dev-1', 't-xl', 3), 2, 0);

    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'restore', skipSnapshot: true })).toBe(true);
    await flush();
    const wm = (await agentStore.get('dev-1'))?.needInput;
    expect(wm).toMatchObject({ epoch: 6, askSeq: 0, answeredSeq: 0 });
    expect(wm?.at).toBeUndefined();
  });

  it('a fully degraded restore keeps the pending question in memory until a later arm persists it', async () => {
    const { m, streamer } = makeCrossLayer();
    await seedCross();
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'fresh' })).toBe(true);
    streamer.triggerLive('[bx:need-input:tokXL12345678:1]\n');
    await flush();
    expect((await agentStore.get('dev-1'))?.needInput?.at).toBeDefined();

    // Both the bump write and the watermark read-back fail: the arm degrades entirely.
    const realUpdate = agentStore.update.bind(agentStore);
    const realGet = agentStore.get.bind(agentStore);
    const updateSpy = vi.spyOn(agentStore, 'update').mockRejectedValueOnce(new Error('store down'));
    const getSpy = vi.spyOn(agentStore, 'get').mockRejectedValueOnce(new Error('store down'));
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'restore', skipSnapshot: true })).toBe(true);
    updateSpy.mockImplementation(realUpdate as never);
    getSpy.mockImplementation(realGet as never);

    // The answer lands while commits are disabled — memory must still record it.
    streamer.triggerLive('[bx:input-received:tokXL12345678:1]\n');
    await flush();
    // The next healthy restore inherits that memory and persists the clear.
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'restore', skipSnapshot: true })).toBe(true);
    await flush();
    const wm = (await agentStore.get('dev-1'))?.needInput;
    expect(wm).toMatchObject({ askSeq: 1, answeredSeq: 1 });
    expect(wm?.at).toBeUndefined();
  });

  it('an external terminal reply still clears the badge when the restore bump failed', async () => {
    const { m, streamer } = makeCrossLayer();
    await seedCross({ epoch: 1, askSeq: 1, answeredSeq: 0, at: NOW });
    const real = agentStore.update.bind(agentStore);
    const spy = vi.spyOn(agentStore, 'update').mockRejectedValueOnce(new Error('store down'));
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'restore', skipSnapshot: true })).toBe(true);
    spy.mockImplementation(real as never);

    // No web fallback here: the answer arrives purely as a pane signal.
    streamer.triggerLive('[bx:input-received:tokXL12345678:1]\n');
    await flush();
    const wm = (await agentStore.get('dev-1'))?.needInput;
    expect(wm).toMatchObject({ epoch: 1, askSeq: 1, answeredSeq: 1 });
    expect(wm?.at).toBeUndefined();
  });

  it('a failed restore bump keeps owed retry intents instead of dropping them', async () => {
    const { m, streamer } = makeCrossLayer();
    await seedCross({ epoch: 1, askSeq: 1, answeredSeq: 0, at: NOW });
    m['enqueueNeedInputRetry'](m['needInputRetryKey']('dev-1', 't-xl', 1), 1, 1);
    const real = agentStore.update.bind(agentStore);
    const spy = vi.spyOn(agentStore, 'update').mockRejectedValueOnce(new Error('store down'));
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'restore', skipSnapshot: true })).toBe(true);
    spy.mockImplementation(real as never);
    expect(m['needInputRetry'].size).toBe(1);

    await m['needInputRetryPass']();
    const wm = (await agentStore.get('dev-1'))?.needInput;
    expect(wm).toMatchObject({ epoch: 1, askSeq: 1, answeredSeq: 1 });
    expect(wm?.at).toBeUndefined();
    expect(m['needInputRetry'].size).toBe(0);
    streamer.triggerLive('[bx:need-input:tokXL12345678:2]\n');
    await flush();
    expect((await agentStore.get('dev-1'))?.needInput).toMatchObject({ epoch: 1, askSeq: 2, answeredSeq: 1 });
  });

  it('web input clears a lit store even when the arm degraded on a bump error', async () => {
    const { m } = makeCrossLayer();
    await seedCross({ epoch: 1, askSeq: 1, answeredSeq: 0, at: NOW });
    const real = agentStore.update.bind(agentStore);
    const spy = vi.spyOn(agentStore, 'update').mockRejectedValueOnce(new Error('store down'));
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'restore' })).toBe(true);
    spy.mockImplementation(real as never);

    await m.notifyHumanTerminalInput('dev-1');
    const wm = (await agentStore.get('dev-1'))?.needInput;
    expect(wm).toMatchObject({ epoch: 1, askSeq: 1, answeredSeq: 1 });
    expect(wm?.at).toBeUndefined();
  });

  it('a late-settling foreign-token arm cannot demote the successor generation', async () => {
    const { m, streamer } = makeCrossLayer();
    await seedCross();
    expect(await armVia(m, 'tokOLD1234567', { needInputMode: 'fresh' })).toBe(true);

    const gate = streamer.holdNextSubscribe();
    const lateP = armVia(m, 'tokOLD1234567', {
      needInputMode: 'fresh', skipSnapshot: true, onlyReplaceOwnToken: true,
    });
    await vi.waitFor(async () => {
      expect((await agentStore.get('dev-1'))?.needInput?.epoch).toBe(2);
    });
    expect(await armVia(m, 'tokNEW1234567', { needInputMode: 'fresh', skipSnapshot: true })).toBe(true);
    expect((await agentStore.get('dev-1'))?.needInput?.epoch).toBe(3);

    gate.release();
    expect(await lateP).toBe(false);

    streamer.triggerLive('[bx:need-input:tokNEW1234567:1]\n');
    await flush();
    expect((await agentStore.get('dev-1'))?.needInput).toMatchObject({ epoch: 3, askSeq: 1, answeredSeq: 0 });
  });

  it('a stale replay cannot evict a current-token pass whose subscribe is still pending', async () => {
    const { m, streamer, captured } = makeCrossLayer();
    await seedCross();
    expect(await armVia(m, 'tokOLD1234567', { needInputMode: 'fresh' })).toBe(true);

    // Reverse arrival order: the current pass claims and bumps, then hangs on subscribe;
    // the stale replay (past its upper guard) arrives while nothing new is installed yet.
    const successorGate = streamer.holdNextSubscribe();
    const successorP = armVia(m, 'tokNEW1234567', { needInputMode: 'fresh', skipSnapshot: true });
    await vi.waitFor(async () => {
      expect((await agentStore.get('dev-1'))?.needInput?.epoch).toBe(2);
    });
    const staleP = armVia(m, 'tokOLD1234567', {
      needInputMode: 'fresh', skipSnapshot: true, onlyReplaceOwnToken: true,
    });
    expect(await staleP).toBe(false);
    // The rejected replay must not have bumped either.
    expect((await agentStore.get('dev-1'))?.needInput?.epoch).toBe(2);
    successorGate.release();
    expect(await successorP).toBe(true);
    await flush();

    // The current token owns the watch: its question lights the badge and its phase
    // signal is consumed.
    streamer.triggerLive('[bx:need-input:tokNEW1234567:1]\n');
    await flush();
    const wm = (await agentStore.get('dev-1'))?.needInput;
    expect(wm).toMatchObject({ epoch: 2, askSeq: 1, answeredSeq: 0 });
    expect(wm?.at).toBeDefined();
    streamer.triggerLive('[bx:pr-created:7:Nzc:tokNEW1234567]\n');
    await flush();
    expect(captured.some(e => e.type === 'pr.created')).toBe(true);
  });

  it('a late restore does not re-enable a degraded fresh successor onto its stale watermark', async () => {
    const { m, streamer } = makeCrossLayer();
    await seedCross();
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'fresh' })).toBe(true);
    streamer.triggerLive('[bx:need-input:tokXL12345678:1]\n');
    streamer.triggerLive('[bx:need-input:tokXL12345678:2]\n');
    await flush();
    expect((await agentStore.get('dev-1'))?.needInput).toMatchObject({ epoch: 1, askSeq: 2, answeredSeq: 0 });

    // Restore arm bumps (carrying the lit watermark) but hangs on subscribe; a same-token
    // fresh replay whose bump fails then installs a degraded successor.
    const gate = streamer.holdNextSubscribe();
    const restoreP = armVia(m, 'tokXL12345678', {
      needInputMode: 'restore', skipSnapshot: true, onlyReplaceOwnToken: true,
    });
    await vi.waitFor(async () => {
      expect((await agentStore.get('dev-1'))?.needInput?.epoch).toBe(2);
    });
    const real = agentStore.update.bind(agentStore);
    const spy = vi.spyOn(agentStore, 'update').mockRejectedValueOnce(new Error('store down'));
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'fresh', skipSnapshot: true })).toBe(true);
    spy.mockImplementation(real as never);
    gate.release();
    expect(await restoreP).toBe(false);
    await flush();

    // The degraded successor must NOT be re-enabled onto the restore's stale watermark:
    // its fresh ask:1 would be swallowed by the max merge and keep the badge lit.
    const before = (await agentStore.get('dev-1'))?.needInput;
    streamer.triggerLive('[bx:need-input:tokXL12345678:1]\n');
    await flush();
    expect((await agentStore.get('dev-1'))?.needInput).toEqual(before);
  });

  it('a stale replay whose bump lags a new-token arm cannot ghost-fence the successor', async () => {
    const { m, streamer } = makeCrossLayer();
    await seedCross();
    expect(await armVia(m, 'tokOLD1234567', { needInputMode: 'fresh' })).toBe(true);

    // The stale replay passes its probe, then its bump write hangs in the store; a
    // new-token pass arms concurrently. The arm lock must serialize them so the store
    // and the surviving watcher land on the SAME generation.
    const real = agentStore.update.bind(agentStore);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const spy = vi.spyOn(agentStore, 'update').mockImplementationOnce(
      (async (id: string, updater: never) => {
        await gate;
        return real(id, updater as never);
      }) as never,
    );
    const staleP = armVia(m, 'tokOLD1234567', {
      needInputMode: 'fresh', skipSnapshot: true, onlyReplaceOwnToken: true,
    });
    const successorP = armVia(m, 'tokNEW1234567', { needInputMode: 'fresh', skipSnapshot: true });
    release();
    // The stale arm may briefly install before the successor replaces it — a legal
    // handover. The invariant is that store and surviving watcher land on ONE
    // generation and the new prompt's ask reaches the badge.
    await staleP;
    expect(await successorP).toBe(true);
    spy.mockRestore();
    await flush();

    streamer.triggerLive('[bx:need-input:tokNEW1234567:1]\n');
    await flush();
    const wm = (await agentStore.get('dev-1'))?.needInput;
    expect(wm).toMatchObject({ askSeq: 1, answeredSeq: 0 });
    expect(wm?.at).toBeDefined();
  });

  it('a late arm cannot resurrect on a dead generation after the successor fired and exited', async () => {
    const { m, streamer } = makeCrossLayer();
    await seedCross();

    const gate = streamer.holdNextSubscribe();
    const lateP = armVia(m, 'tokOLD1234567', { needInputMode: 'fresh', skipSnapshot: true });
    await vi.waitFor(async () => {
      expect((await agentStore.get('dev-1'))?.needInput?.epoch).toBe(1);
    });

    expect(await armVia(m, 'tokNEW1234567', { needInputMode: 'fresh', skipSnapshot: true })).toBe(true);
    expect((await agentStore.get('dev-1'))?.needInput?.epoch).toBe(2);
    // The successor consumes its phase signal and exits the watcher map entirely.
    streamer.triggerLive('[bx:pr-created:7:Nzc:tokNEW1234567]\n');
    await flush();
    expect(m['phaseSignalWatcher']!.has('t-xl', 'dev-1')).toBe(false);

    gate.release();
    expect(await lateP).toBe(false);
    expect(m['phaseSignalWatcher']!.has('t-xl', 'dev-1')).toBe(false);

    streamer.triggerLive('[bx:need-input:tokOLD1234567:1]\n');
    await flush();
    expect((await agentStore.get('dev-1'))?.needInput).toEqual({ epoch: 2, askSeq: 0, answeredSeq: 0 });
  });

  it('a late-settling same-token arm cannot replace the successor entry', async () => {
    const { m, streamer } = makeCrossLayer();
    await seedCross();
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'fresh' })).toBe(true);

    const gate = streamer.holdNextSubscribe();
    const lateP = armVia(m, 'tokXL12345678', {
      needInputMode: 'restore', skipSnapshot: true, onlyReplaceOwnToken: true,
    });
    await vi.waitFor(async () => {
      expect((await agentStore.get('dev-1'))?.needInput?.epoch).toBe(2);
    });
    expect(await armVia(m, 'tokXL12345678', { needInputMode: 'fresh', skipSnapshot: true })).toBe(true);
    expect((await agentStore.get('dev-1'))?.needInput?.epoch).toBe(3);

    gate.release();
    expect(await lateP).toBe(false);

    streamer.triggerLive('[bx:need-input:tokXL12345678:1]\n');
    await flush();
    expect((await agentStore.get('dev-1'))?.needInput).toMatchObject({ epoch: 3, askSeq: 1, answeredSeq: 0 });
  });

  it('armPostDispatchSignalOrHold strips a superseded watermark for a continuation', async () => {
    const { m } = makeCrossLayer();
    await seedCross({ epoch: 2, askSeq: 1, answeredSeq: 0, at: NOW });
    await (m as never as {
      armPostDispatchSignalOrHold: (
        taskId: string, agentId: string, kinds: readonly string[], token: string,
      ) => Promise<void>;
    }).armPostDispatchSignalOrHold('t-xl', 'dev-1', ['pr-fixed'], 'tokXL12345678');
    expect((await agentStore.get('dev-1'))?.needInput).toEqual({ epoch: 3, askSeq: 0, answeredSeq: 0 });
  });
});

describe('AgentManager.resumeAgent binding cleanup & code redispatch failures', () => {
  async function seedFailedCodeRedispatch(): Promise<TaskState> {
    const t = await seedTask({
      status: 'in_progress',
      phase: 'code',
      specReviewRound: 1,
      signalToken: 'code-redispatch-token',
    });
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'code-dispatch-failed',
    });
    await acquireBoundLock('dev-1');
    return t;
  }

  it('cleans the exact baxian task branch when the release path runs', async () => {
    const t = await seedTask({ status: 'cancelled' });
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed',
      workdir: '/tmp/repo',
    });
    await acquireBoundLock('dev-1');
    const cleanupSpy = vi.spyOn(BranchManager.prototype, 'cleanupTaskBranch')
      .mockResolvedValue({ status: 'deleted' });

    const result = await manager.resumeAgent('dev-1');

    expect(result).toEqual({ resumed: true, releasedBinding: true });
    expect(cleanupSpy).toHaveBeenCalledWith('/tmp/repo', expect.objectContaining({
      taskId: t.id,
      taskBranch: t.branch,
    }), expect.any(Function));
    expect(await lockManager.isLocked('dev-1')).toBe(false);
  });

  it('records the branchLocalCleaned credential when release deletes a pushed local branch', async () => {
    const t = await seedTask({ status: 'cancelled' });
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed',
      workdir: '/tmp/repo',
    });
    await acquireBoundLock('dev-1');
    vi.spyOn(BranchManager.prototype, 'cleanupTaskBranch')
      .mockResolvedValue({ status: 'deleted', remoteTipSha: 'a'.repeat(40) });

    const result = await manager.resumeAgent('dev-1');

    expect(result).toEqual({ resumed: true, releasedBinding: true });
    expect((await taskStore.get(t.id))?.branchLocalCleaned).toMatchObject({
      remoteTipSha: 'a'.repeat(40),
    });
  });

  it('keeps the binding and lock when fixed-Workdir branch cleanup fails', async () => {
    const t = await seedTask({ status: 'cancelled' });
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed',
      workdir: '/tmp/repo',
    });
    await acquireBoundLock('dev-1');
    vi.spyOn(BranchManager.prototype, 'cleanupTaskBranch').mockRejectedValue(new Error('cleanup blip'));

    const result = await manager.resumeAgent('dev-1');

    expect(result).toMatchObject({
      resumed: false,
      releasedBinding: false,
      reason: expect.stringContaining('cleanup blip'),
    });
    expect(await agentStore.get('dev-1')).toMatchObject({
      taskId: t.id,
      status: 'awaiting_human',
      awaitingPhase: 'branch-cleanup-pending',
      awaitingReason: expect.stringContaining('cleanup blip'),
    });
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  it.each(['checkout-preparation-failed', 'dirty-workdir'])(
    'resumes a QA held on %s + active review task by redispatching the review with pass fences',
    async (phase) => {
      const t = await seedTask({ status: 'review', qaAgentId: 'qa-1', prNumber: 12, signalToken: 'pass-t1' });
      await seedAgent({
        id: 'qa-1', taskId: t.id, paneId: '%1',
        status: 'awaiting_human', awaitingPhase: phase,
        awaitingReason: 'repl not ready', awaitingSince: NOW,
      });
      await acquireBoundLock('qa-1', t.id);
      const dispatchSpy = vi.spyOn(manager, 'dispatchReviewToQa').mockResolvedValue({} as never);

      const result = await manager.resumeAgent('qa-1');

      expect(result).toEqual({ resumed: true, releasedBinding: false });
      expect(dispatchSpy).toHaveBeenCalledWith(t.id, {
        bumpRound: false,
        fromStatus: ['review'],
        expectPhase: undefined,
        expectSignalToken: 'pass-t1',
        expectedTask: {
          status: t.status,
          phase: t.phase,
          signalToken: t.signalToken,
          agentId: t.agentId,
          reviewRound: t.reviewRound,
          specReviewRound: t.specReviewRound,
        },
        qaPhase: 'review',
        onQaAcquired: expect.any(Function),
      });
      const qa = await agentStore.get('qa-1');
      expect(qa?.taskId).toBe(t.id);
      expect(qa?.status).toBeUndefined();
      expect(qa?.awaitingPhase).toBeUndefined();
    },
  );

  it('Resume treats a later spec review round as recheck even when code reviewRound is zero', async () => {
    const t = await seedTask({
      status: 'review',
      phase: 'spec',
      specReviewRound: 2,
      reviewRound: 0,
      qaAgentId: 'qa-1',
      prNumber: 12,
      signalToken: 'spec-pass-r2',
    });
    await seedAgent({
      id: 'qa-1',
      taskId: t.id,
      paneId: '%1',
      status: 'awaiting_human',
      awaitingPhase: 'checkout-preparation-failed',
      awaitingReason: 'repl not ready',
      awaitingSince: NOW,
    });
    await acquireBoundLock('qa-1', t.id);
    const dispatchSpy = vi.spyOn(manager, 'dispatchReviewToQa').mockResolvedValue({} as never);

    await manager.resumeAgent('qa-1');

    const options = dispatchSpy.mock.calls[0]?.[1];
    expect(options).not.toHaveProperty('qaPhase');
  });

  it('Resume 首评 hold 携带持久化未计轮 intent：bumpRound=true + qaPhase=review（#563 R23）', async () => {
    const t = await seedTask({
      status: 'review', qaAgentId: 'qa-1', prNumber: 12,
      signalToken: 'pass-t2', reviewRound: 0, reviewRoundPending: true,
    });
    await seedAgent({
      id: 'qa-1', taskId: t.id, paneId: '%1',
      status: 'awaiting_human', awaitingPhase: 'checkout-preparation-failed',
      awaitingReason: 'repl not ready', awaitingSince: NOW,
    });
    await acquireBoundLock('qa-1', t.id);
    const dispatchSpy = vi.spyOn(manager, 'dispatchReviewToQa').mockResolvedValue({} as never);

    await manager.resumeAgent('qa-1');

    expect(dispatchSpy).toHaveBeenCalledWith(t.id, expect.objectContaining({
      bumpRound: true,
      qaPhase: 'review',
      expectSignalToken: 'pass-t2',
    }));
  });

  it('releases the held QA binding instead of redispatching when the task has left review', async () => {
    const t = await seedTask({ status: 'fixing', qaAgentId: 'qa-1', prNumber: 12, signalToken: 'pass-t1' });
    await seedAgent({
      id: 'qa-1', taskId: t.id,
      status: 'awaiting_human', awaitingPhase: 'checkout-preparation-failed',
      awaitingReason: 'repl not ready', awaitingSince: NOW,
    });
    await acquireBoundLock('qa-1', t.id);
    const dispatchSpy = vi.spyOn(manager, 'dispatchReviewToQa').mockResolvedValue({} as never);

    const result = await manager.resumeAgent('qa-1');

    expect(result).toEqual({ resumed: true, releasedBinding: true });
    expect(dispatchSpy).not.toHaveBeenCalled();
    const qa = await agentStore.get('qa-1');
    expect(qa?.taskId).toBeUndefined();
    expect(qa?.status).toBeUndefined();
    expect(await lockManager.isLocked('qa-1')).toBe(false);
  });

  it('aborts the QA resume when the hold generation changed after the pre-read', async () => {
    const t = await seedTask({ status: 'review', qaAgentId: 'qa-1', prNumber: 12, signalToken: 'pass-t1' });
    await seedAgent({
      id: 'qa-1', taskId: t.id,
      status: 'awaiting_human', awaitingPhase: 'dispatch-failed:ack_unknown',
      awaitingReason: 'prompt may be running', awaitingSince: NOW, awaitingNonce: 'gen-b',
    });
    await acquireBoundLock('qa-1', t.id);
    const real = await agentStore.get('qa-1');
    vi.spyOn(agentStore, 'get').mockResolvedValueOnce({
      ...real!,
      awaitingPhase: 'checkout-preparation-failed',
      awaitingReason: 'repl not ready',
      awaitingNonce: 'gen-a',
    });
    const dispatchSpy = vi.spyOn(manager, 'dispatchReviewToQa').mockResolvedValue({} as never);

    const result = await manager.resumeAgent('qa-1');

    expect(result).toMatchObject({ resumed: false, releasedBinding: false });
    expect(result.reason).toBeTruthy();
    expect(dispatchSpy).not.toHaveBeenCalled();
    const qa = await agentStore.get('qa-1');
    expect(qa?.status).toBe('awaiting_human');
    expect(qa?.awaitingPhase).toBe('dispatch-failed:ack_unknown');
    expect(qa?.awaitingNonce).toBe('gen-b');
  });

  it('does not re-hold the QA when the review round advanced during a failed redispatch', async () => {
    const t = await seedTask({ status: 'review', qaAgentId: 'qa-1', prNumber: 12, signalToken: 'pass-t1' });
    await seedAgent({
      id: 'qa-1', taskId: t.id,
      status: 'awaiting_human', awaitingPhase: 'checkout-preparation-failed',
      awaitingReason: 'repl not ready', awaitingSince: NOW,
    });
    await acquireBoundLock('qa-1', t.id);
    vi.spyOn(manager, 'dispatchReviewToQa').mockImplementation(async () => {
      const fresh = await taskStore.get(t.id);
      await taskStore.set({
        ...fresh!,
        reviewRound: fresh!.reviewRound + 1,
        updatedAt: new Date().toISOString(),
      });
      throw new Error('pass superseded during dispatch');
    });

    const result = await manager.resumeAgent('qa-1');

    expect(result).toMatchObject({ resumed: false, reason: expect.stringContaining('pass superseded') });
    const qa = await agentStore.get('qa-1');
    expect(qa?.taskId).toBe(t.id);
    expect(qa?.status).toBeUndefined();
  });

  it('Resume 把缺失 phase/token 作为完整入口 pass，successor 换代后不补挂旧 hold', async () => {
    const t = await seedTask({
      status: 'review', phase: undefined, qaAgentId: 'qa-1', prNumber: 12, signalToken: undefined,
    });
    await seedAgent({
      id: 'qa-1', taskId: t.id,
      status: 'awaiting_human', awaitingPhase: 'checkout-preparation-failed',
      awaitingReason: 'repl not ready', awaitingSince: NOW,
    });
    await acquireBoundLock('qa-1', t.id);
    const dispatchSpy = vi.spyOn(manager, 'dispatchReviewToQa').mockImplementation(async (_taskId, opts) => {
      expect(Object.hasOwn(opts, 'expectPhase')).toBe(true);
      expect(Object.hasOwn(opts, 'expectSignalToken')).toBe(true);
      expect(opts.expectPhase).toBeUndefined();
      expect(opts.expectSignalToken).toBeUndefined();
      const fresh = await taskStore.get(t.id);
      await taskStore.set({
        ...fresh!, phase: 'code', signalToken: 'successor-pass', updatedAt: new Date().toISOString(),
      });
      throw new Error('missing-value pass superseded');
    });

    const result = await manager.resumeAgent('qa-1');

    expect(result).toMatchObject({ resumed: false, reason: expect.stringContaining('superseded') });
    expect(dispatchSpy).toHaveBeenCalledOnce();
    const qa = await agentStore.get('qa-1');
    expect(qa?.status).toBeUndefined();
    expect(qa?.awaitingPhase).toBeUndefined();
  });

  it('does not re-hold the QA when the task left review with an unchanged token during a failed redispatch', async () => {
    const t = await seedTask({ status: 'review', qaAgentId: 'qa-1', prNumber: 12, signalToken: 'pass-t1' });
    await seedAgent({
      id: 'qa-1', taskId: t.id,
      status: 'awaiting_human', awaitingPhase: 'checkout-preparation-failed',
      awaitingReason: 'repl not ready', awaitingSince: NOW,
    });
    await acquireBoundLock('qa-1', t.id);
    vi.spyOn(manager, 'dispatchReviewToQa').mockImplementation(async () => {
      const fresh = await taskStore.get(t.id);
      await taskStore.set({ ...fresh!, status: 'approved', updatedAt: new Date().toISOString() });
      throw new Error('Task task-1 left review during dispatch');
    });

    const result = await manager.resumeAgent('qa-1');

    expect(result).toMatchObject({ resumed: false });
    const qa = await agentStore.get('qa-1');
    expect(qa?.status).toBeUndefined();
    expect(qa?.awaitingPhase).toBeUndefined();
  });

  it('keeps a newer hold and the lock when the non-review release races a hold rewrite', async () => {
    const t = await seedTask({ status: 'fixing', qaAgentId: 'qa-1', prNumber: 12, signalToken: 'pass-t1' });
    await seedAgent({
      id: 'qa-1', taskId: t.id,
      status: 'awaiting_human', awaitingPhase: 'dispatch-failed:ack_unknown',
      awaitingReason: 'prompt may be running', awaitingSince: NOW, awaitingNonce: 'gen-b',
    });
    await acquireBoundLock('qa-1', t.id);
    const real = await agentStore.get('qa-1');
    vi.spyOn(agentStore, 'get').mockResolvedValueOnce({
      ...real!,
      awaitingPhase: 'checkout-preparation-failed',
      awaitingReason: 'repl not ready',
      awaitingNonce: 'gen-a',
    });
    const dispatchSpy = vi.spyOn(manager, 'dispatchReviewToQa').mockResolvedValue({} as never);

    const result = await manager.resumeAgent('qa-1');

    expect(result).toMatchObject({ resumed: false, releasedBinding: false });
    expect(dispatchSpy).not.toHaveBeenCalled();
    const qa = await agentStore.get('qa-1');
    expect(qa?.taskId).toBe(t.id);
    expect(qa?.awaitingPhase).toBe('dispatch-failed:ack_unknown');
    expect(qa?.awaitingNonce).toBe('gen-b');
    expect(await lockManager.isLocked('qa-1')).toBe(true);
  });

  it('restores the dispatch-failed:ack_unknown hold when the redispatch dies with an unknown ack', async () => {
    const t = await seedTask({ status: 'review', qaAgentId: 'qa-1', prNumber: 12, signalToken: 'pass-t1' });
    await seedAgent({
      id: 'qa-1', taskId: t.id,
      status: 'awaiting_human', awaitingPhase: 'checkout-preparation-failed',
      awaitingReason: 'repl not ready', awaitingSince: NOW,
    });
    await acquireBoundLock('qa-1', t.id);
    vi.spyOn(manager, 'dispatchReviewToQa').mockImplementation(async () => {
      const fresh = await taskStore.get(t.id);
      await taskStore.set({ ...fresh!, signalToken: 'armed-token', updatedAt: new Date().toISOString() });
      throw new DispatchTerminalError('ack_unknown', 'runtime ack timeout (paneId=%1)');
    });

    const result = await manager.resumeAgent('qa-1');

    expect(result).toMatchObject({ resumed: false });
    const qa = await agentStore.get('qa-1');
    expect(qa?.taskId).toBe(t.id);
    expect(qa?.status).toBe('awaiting_human');
    expect(qa?.awaitingPhase).toBe('dispatch-failed:ack_unknown');
  });

  it('returns resumed:false and restores visibility when the recovery task read also fails', async () => {
    const t = await seedTask({ status: 'review', qaAgentId: 'qa-1', prNumber: 12, signalToken: 'pass-t1' });
    await seedAgent({
      id: 'qa-1', taskId: t.id,
      status: 'awaiting_human', awaitingPhase: 'checkout-preparation-failed',
      awaitingReason: 'repl not ready', awaitingSince: NOW,
    });
    await acquireBoundLock('qa-1', t.id);
    vi.spyOn(manager, 'dispatchReviewToQa').mockImplementation(async () => {
      vi.spyOn(taskStore, 'get').mockRejectedValueOnce(new Error('task store read failed'));
      throw new Error('dispatch blew up');
    });

    const result = await manager.resumeAgent('qa-1');

    expect(result).toMatchObject({
      resumed: false,
      reason: expect.stringContaining('dispatch blew up'),
    });
    const qa = await agentStore.get('qa-1');
    expect(qa?.status).toBe('awaiting_human');
    expect(qa?.awaitingReason).toContain('dispatch blew up');
  });

  it('does not re-hold a QA that was rebound by a concurrent redispatch', async () => {
    const t = await seedTask({ status: 'review', qaAgentId: 'qa-1', prNumber: 12, signalToken: 'pass-t1' });
    await seedAgent({
      id: 'qa-1', taskId: t.id,
      status: 'awaiting_human', awaitingPhase: 'checkout-preparation-failed',
      awaitingReason: 'repl not ready', awaitingSince: NOW,
    });
    await acquireBoundLock('qa-1', t.id);
    vi.spyOn(manager, 'dispatchReviewToQa').mockImplementation(async () => {
      const cur = await agentStore.get('qa-1');
      await lockManager.releaseIfOwner('qa-1', t.id, cur!.lockToken!);
      const successor = await lockManager.acquire('qa-1', t.id);
      await agentStore.set({ ...cur!, lockToken: successor!, updatedAt: new Date().toISOString() });
      throw new ApiError(409, `Manual review already in progress for task ${t.id}`);
    });

    const result = await manager.resumeAgent('qa-1');

    expect(result).toMatchObject({ resumed: false });
    const qa = await agentStore.get('qa-1');
    expect(qa?.status).toBeUndefined();
    expect(qa?.awaitingPhase).toBeUndefined();
    expect(qa?.taskId).toBe(t.id);
  });

  it('restores the hold when a handled dispatch failure did not persist it', async () => {
    const t = await seedTask({ status: 'review', qaAgentId: 'qa-1', prNumber: 12, signalToken: 'pass-t1' });
    await seedAgent({
      id: 'qa-1', taskId: t.id,
      status: 'awaiting_human', awaitingPhase: 'checkout-preparation-failed',
      awaitingReason: 'repl not ready', awaitingSince: NOW,
    });
    await acquireBoundLock('qa-1', t.id);
    vi.spyOn(manager, 'dispatchReviewToQa').mockRejectedValue(new EnsureSessionError(
      { createdSession: false, agentId: 'qa-1', handled: true },
      'checkout preparation failed for task task-1: repl not ready',
    ));

    const result = await manager.resumeAgent('qa-1');

    expect(result).toMatchObject({ resumed: false });
    const qa = await agentStore.get('qa-1');
    expect(qa?.status).toBe('awaiting_human');
    expect(qa?.awaitingPhase).toBe('checkout-preparation-failed');
    expect(qa?.awaitingReason).toContain('repl not ready');
  });

  it('Resume git 路由把 onQaAcquired 转发到 lease 派发，并用 L2 恢复 handled hold', async () => {
    const headSha = 'a'.repeat(40);
    const t = await seedTask({
      status: 'review', phase: 'code', qaAgentId: 'qa-1', prNumber: 12,
      deliveryConfirmation: { phase: 'code', source: 'signal', at: NOW },
      replyActorId: '77', replyActorStatus: 'verified',
      reviewRound: 1, signalToken: '111111111111', reviewHeadAnchorSha: headSha,
      passToken: '222222222222', failToken: '333333333333',
      reviewDispatch: {
        generation: '444444444444', phase: 'pending', qaPhase: 'recheck', signalToken: '111111111111',
        headSha, passToken: '222222222222', failToken: '333333333333',
        effectiveRound: 1, updatedAt: NOW,
      },
    });
    await seedAgent({
      id: 'qa-1', taskId: t.id,
      status: 'awaiting_human', awaitingPhase: 'checkout-preparation-failed',
      awaitingReason: 'repl not ready', awaitingSince: NOW,
    });
    const l1 = await acquireBoundLock('qa-1', t.id);
    await agentStore.update('qa-1', existing => ({ ...existing!, lockToken: l1!, updatedAt: NOW }));
    vi.spyOn(manager, 'startSession').mockRejectedValue(new EnsureSessionError(
      { createdSession: false, agentId: 'qa-1', handled: true },
      'git checkout preparation failed after reacquire',
    ));

    const result = await manager.resumeAgent('qa-1');

    expect(result).toMatchObject({ resumed: false });
    const qa = await agentStore.get('qa-1');
    expect(qa?.lockToken).toBeTruthy();
    expect(qa?.lockToken).not.toBe(l1);
    expect(qa?.status).toBe('awaiting_human');
    expect(qa?.awaitingPhase).toBe('checkout-preparation-failed');
  });

  it('surfaces the re-hold failure in the reason when restoring the hold also fails', async () => {
    const t = await seedTask({ status: 'review', qaAgentId: 'qa-1', prNumber: 12, signalToken: 'pass-t1' });
    await seedAgent({
      id: 'qa-1', taskId: t.id,
      status: 'awaiting_human', awaitingPhase: 'checkout-preparation-failed',
      awaitingReason: 'repl not ready', awaitingSince: NOW,
    });
    await acquireBoundLock('qa-1', t.id);
    vi.spyOn(manager, 'dispatchReviewToQa').mockRejectedValue(new Error('dispatch blew up'));
    vi.spyOn(manager, 'markAwaitingHuman').mockRejectedValue(new Error('store down'));

    const result = await manager.resumeAgent('qa-1');

    expect(result).toMatchObject({
      resumed: false,
      reason: expect.stringContaining('dispatch blew up'),
    });
    expect(result.reason).toContain('store down');
  });

  it('re-holds the QA with the dispatch failure when the Resume review redispatch throws before releasing', async () => {
    const t = await seedTask({ status: 'review', qaAgentId: 'qa-1', prNumber: 12 });
    await seedAgent({
      id: 'qa-1', taskId: t.id, paneId: '%1',
      status: 'awaiting_human', awaitingPhase: 'checkout-preparation-failed',
      awaitingReason: 'repl not ready', awaitingSince: NOW,
    });
    await acquireBoundLock('qa-1', t.id);
    vi.spyOn(manager, 'dispatchReviewToQa').mockRejectedValue(new Error('QA agent qa-1 is busy or unavailable'));

    const result = await manager.resumeAgent('qa-1');

    expect(result).toMatchObject({
      resumed: false,
      releasedBinding: false,
      reason: expect.stringContaining('busy or unavailable'),
    });
    const qa = await agentStore.get('qa-1');
    expect(qa?.taskId).toBe(t.id);
    expect(qa?.status).toBe('awaiting_human');
    expect(qa?.awaitingReason).toContain('busy or unavailable');
  });

  it('still refuses to resume a dev held on checkout-preparation-failed with an active task', async () => {
    const t = await seedTask({ status: 'in_progress', qaAgentId: 'qa-1' });
    await seedAgent({
      id: 'dev-1', taskId: t.id, paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'checkout-preparation-failed',
      awaitingReason: 'workdir broken', awaitingSince: NOW,
    });
    await acquireBoundLock('dev-1', t.id);
    const dispatchSpy = vi.spyOn(manager, 'dispatchReviewToQa').mockResolvedValue({} as never);

    const result = await manager.resumeAgent('dev-1');

    expect(result).toMatchObject({ resumed: false, releasedBinding: false });
    expect(result.reason).toContain('cancel');
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect((await agentStore.get('dev-1'))?.status).toBe('awaiting_human');
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  it('resumes a code redispatch without a server Spec handoff', async () => {
    const m = makeManager();
    const t = await seedTask({
      status: 'in_progress',
      phase: 'code',
      specReviewRound: 2,
      signalToken: 'git-code-resume-token',
    });
    await seedAgent({
      id: 'dev-1',
      taskId: t.id,
      paneId: '%0',
      status: 'awaiting_human',
      awaitingPhase: 'code-dispatch-failed',
    });
    await acquireBoundLock('dev-1');
    const continueSpy = vi.spyOn(m, 'continueSession').mockResolvedValue(true);

    const result = await m.resumeAgent('dev-1');

    expect(result).toMatchObject({ resumed: true, releasedBinding: false });
    expect(continueSpy).toHaveBeenCalledWith(
      t.id,
      'dev-1',
      'code',
      expect.objectContaining({ signalToken: 'git-code-resume-token' }),
    );
    expect(continueSpy.mock.calls[0]?.[3]).not.toHaveProperty('specDocuments');
  });

  it('re-holds the agent when the code redispatch is not delivered', async () => {
    const m = makeManager();
    const t = await seedFailedCodeRedispatch();
    vi.spyOn(m, 'continueSession').mockResolvedValue(false);
    const holdSpy = vi.spyOn(m, 'markAwaitingHuman').mockResolvedValue(true);

    const result = await m.resumeAgent('dev-1');

    expect(result).toMatchObject({
      resumed: false,
      releasedBinding: false,
      reason: expect.stringContaining('not delivered'),
    });
    expect(holdSpy).toHaveBeenCalledWith(
      'dev-1', 'code-dispatch-failed', expect.stringContaining('not delivered'), { expectedTaskId: t.id },
    );
  });

  it('re-holds the agent when the code redispatch throws', async () => {
    const m = makeManager();
    const t = await seedFailedCodeRedispatch();
    vi.spyOn(m, 'continueSession').mockRejectedValue(new Error('redispatch boom'));
    const holdSpy = vi.spyOn(m, 'markAwaitingHuman').mockResolvedValue(true);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await m.resumeAgent('dev-1');

    expect(result).toMatchObject({
      resumed: false,
      releasedBinding: false,
      reason: expect.stringContaining('redispatch boom'),
    });
    expect(holdSpy).toHaveBeenCalledWith(
      'dev-1', 'code-dispatch-failed', expect.stringContaining('failed'), { expectedTaskId: t.id },
    );
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe('AgentManager.createTask queue reasons', () => {
  it('queues an unassigned task without an agent id in the creation event', async () => {
    const created = await manager.createTask('proj', {
      title: 'pick later',
      description: 'details',
      preferredAgentId: '',
    });

    expect(created).toMatchObject({ status: 'pending', agentId: '', devAgentId: '' });
    const queuedEvent = events.find(e => e.type === 'task.created' && e.taskId === created.id);
    expect(queuedEvent?.data).toEqual({ queued: true, queueReason: 'unassigned' });
  });

  it('queues with agent_locked when the dev binding is free but its lock is already held', async () => {
    await seedAgent({ id: 'dev-1' });
    await acquireBoundLock('dev-1', 'foreign-holder');

    const created = await manager.createTask('proj', {
      title: 'locked out',
      description: 'details',
      preferredAgentId: 'dev-1',
    });

    expect(created.status).toBe('pending');
    expect(created.agentId).toBe('');
    expect(created.qaAgentId).toBe('qa-1');
    const queuedEvent = events.find(e => e.type === 'task.created' && e.taskId === created.id);
    expect(queuedEvent?.data).toMatchObject({ queued: true, queueReason: 'agent_locked', agentId: 'dev-1' });
  });
});

describe('AgentManager.editTask', () => {
  it('404s for an unknown task', async () => {
    await expect(manager.editTask('nope', { title: 'x' })).rejects.toMatchObject({ status: 404 });
  });

  it('409s for a non-pending task', async () => {
    await seedTask({ status: 'in_progress' });
    await expect(manager.editTask('task-1', { title: 'x' })).rejects.toMatchObject({ status: 409 });
  });

  it('edits title and description on a pending task', async () => {
    await seedTask({ status: 'pending' });
    const updated = await manager.editTask('task-1', { title: 'new title', description: 'new desc' });
    expect(updated).toMatchObject({ title: 'new title', description: 'new desc' });
    expect((await taskStore.get('task-1'))?.title).toBe('new title');
  });

  it('clearing preferredAgentId also drops the snapshotted participants and initial phase', async () => {
    await seedTask({
      status: 'pending',
      preferredAgentId: 'dev-1',
      agentId: '',
      devAgentId: 'dev-1',
      qaAgentId: 'qa-1',
    });
    const updated = await manager.editTask('task-1', { preferredAgentId: '' });
    expect(updated.preferredAgentId).toBe('');
    expect(updated).toMatchObject({ agentId: '', devAgentId: '' });
    expect(updated.phase).toBeUndefined();
    expect(updated.qaAgentId).toBeUndefined();
  });

  it('rejects an unknown preferred agent with 400', async () => {
    await seedTask({ status: 'pending' });
    await expect(manager.editTask('task-1', { preferredAgentId: 'ghost' }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('rejects a non-dev preferred agent with 400', async () => {
    await seedTask({ status: 'pending' });
    await expect(manager.editTask('task-1', { preferredAgentId: 'qa-1' }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('switching the preferred owner to Dev re-derives QA and leaves the initial phase undecided', async () => {
    await seedTask({
      status: 'pending',
      preferredAgentId: '',
      agentId: '',
      devAgentId: '',
      qaAgentId: undefined,
    });
    const updated = await manager.editTask('task-1', { preferredAgentId: 'dev-1' });
    expect(updated.preferredAgentId).toBe('dev-1');
    expect(updated.devAgentId).toBe('dev-1');
    expect(updated.qaAgentId).toBe('qa-1');
    expect(updated.phase).toBeUndefined();
  });
});

describe('AgentManager.verifyPaneSignalPrNumber', () => {
  const SHA = 'a'.repeat(40);

  type Verification = Awaited<ReturnType<AgentManager['platformVerifyPrBinding']>>;

  function driverManager(result: Verification | Error) {
    const manager = makeManager();
    const verify = vi.spyOn(manager, 'platformVerifyPrBinding');
    if (result instanceof Error) verify.mockRejectedValue(result);
    else verify.mockResolvedValue(result);
    return { manager, verify };
  }

  it('returns undefined for an unknown task', async () => {
    const { manager, verify } = driverManager({
      ok: true, headSha: SHA, branch: 'bx/task-1', targetBranch: 'main',
    });
    await expect(manager.verifyPaneSignalPrNumber('nope', 12)).resolves.toBeUndefined();
    expect(verify).not.toHaveBeenCalled();
  });

  it('returns undefined for a task without branch', async () => {
    const { manager, verify } = driverManager({
      ok: true, headSha: SHA, branch: 'bx/task-1', targetBranch: 'main',
    });
    await seedTask({ branch: undefined });
    await expect(manager.verifyPaneSignalPrNumber('task-1', 12)).resolves.toBeUndefined();
    expect(verify).not.toHaveBeenCalled();
  });

  it('surfaces a driver probe failure instead of collapsing it into a negative verification', async () => {
    const { manager, verify } = driverManager(new Error('driver failed'));
    await seedTask();
    await expect(manager.verifyPaneSignalPrNumber('task-1', 12)).rejects.toThrow('driver failed');
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('does not retry a platform rate-limit response on the short network backoff', async () => {
    const { manager, verify } = driverManager(new DriverOpError('secondary rate limit', {
      opName: 'prView', errorClass: 'RATE_LIMIT', exitCode: 1,
    }));
    await seedTask();

    await expect(manager.verifyPaneSignalPrNumber('task-1', 12)).rejects.toThrow('secondary rate limit');

    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('returns undefined when the driver cannot verify the PR', async () => {
    const { manager } = driverManager({ ok: false, reason: 'unverifiable' });
    await seedTask();
    await expect(manager.verifyPaneSignalPrNumber('task-1', 12)).resolves.toBeUndefined();
  });

  it('returns undefined when the PR head branch does not match the task branch', async () => {
    const { manager } = driverManager({ ok: false, reason: 'branch', prBranch: 'bx/other-task' });
    await seedTask();
    await expect(manager.verifyPaneSignalPrNumber('task-1', 12)).resolves.toBeUndefined();
  });

  it('returns the driver-verified head ref, sha, and target branch', async () => {
    const { manager, verify } = driverManager({
      ok: true, headSha: SHA, branch: 'bx/task-1', targetBranch: 'main',
    });
    await seedTask();
    await expect(manager.verifyPaneSignalPrNumber('task-1', 12)).resolves.toEqual({
      headRefName: 'bx/task-1',
      headSha: SHA,
      targetBranch: 'main',
    });
    expect(verify).toHaveBeenCalledWith('task-1', 12);
  });
});

describe('AgentManager.failTaskForDispatchError edge paths', () => {
  it('warns (does not transition) when the task is outside the expected fromStatus and still emits the intervention', async () => {
    await seedTask({ status: 'done' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await manager.failTaskForDispatchError(
      'task-1', 'develop', 'dev-1', new DispatchTerminalError('gate_failed', 'gate exploded'),
    );

    expect((await taskStore.get('task-1'))?.status).toBe('done');
    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('skipping task transition'))).toBe(true);
    expect(events.some(e => e.type === 'human.intervention'
      && (e.data as { phase?: string }).phase === 'dispatch-failed:gate_failed')).toBe(true);
    warnSpy.mockRestore();
  });

  it('warns when the post-failure release itself throws', async () => {
    await seedTask({ status: 'in_progress' });
    await seedAgent({ id: 'dev-1', taskId: 'task-1' });
    vi.spyOn(manager, 'releaseAgentForTask').mockRejectedValue(new Error('release blip'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await manager.failTaskForDispatchError(
      'task-1', 'develop', 'dev-1', new DispatchTerminalError('prompt_too_large', 'too big'),
    );

    expect((await taskStore.get('task-1'))?.status).toBe('failed');
    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('releaseAgentForTask'))).toBe(true);
    warnSpy.mockRestore();
  });
});

describe('AgentManager.cancelTask release failure tolerance', () => {
  it('logs but completes the cancel when releaseAgentForTask throws', async () => {
    const t = await seedTask();
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    mockInterruptPane(manager, true);
    vi.spyOn(manager, 'releaseAgentForTask').mockRejectedValue(new Error('release exploded'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const cancelled = await manager.cancelTask(t.id);

    expect(cancelled.status).toBe('cancelled');
    expect(errSpy.mock.calls.some(c => String(c[0]).includes('releaseAgentForTask'))).toBe(true);
    errSpy.mockRestore();
  });
});

describe('AgentManager.transitionToCodePhase failure paths', () => {
  async function seedSpecApproved(overrides: Partial<TaskState> = {}): Promise<void> {
    await seedTask({
      id: 'task-code-1',
      branch: 'bx/task-code-1',
      status: 'review',
      phase: 'spec',
      specReviewRound: 1,
      signalToken: 'old-token',
      qaAgentId: 'qa-1',
      ...overrides,
    });
    await seedAgent({ id: 'dev-1', taskId: 'task-code-1', paneId: '%0' });
  }

  it('holds the dev when the pr-created watcher prevents code-phase delivery', async () => {
    const watcher = { start: vi.fn(async () => false), stop: vi.fn(), has: vi.fn(() => false) };
    const m2 = makeManager({
      skillRegistry: freshRegistry(), phaseSignalWatcher: watcher as never,
    });
    await seedSpecApproved();
    vi.spyOn(m2, 'releaseAgentForTask').mockResolvedValue(true);
    vi.spyOn(m2, 'acquireAgentForTask').mockResolvedValue(true);
    vi.spyOn(m2, 'continueSession').mockImplementation(async (_taskId, _agentId, _phase, opts) => {
      await opts.armBeforeInject?.({});
      return false;
    });
    const holdSpy = vi.spyOn(m2, 'markAwaitingHuman').mockResolvedValue(true);

    const result = await m2.transitionToCodePhase('task-code-1');

    expect(result).toBeNull();
    expect(watcher.start).toHaveBeenCalledWith(expect.objectContaining({ expectedKinds: 'pr-created' }));
    expect(holdSpy).toHaveBeenCalledWith(
      'dev-1', 'code-dispatch-failed', expect.any(String), { expectedTaskId: 'task-code-1' },
    );
  });

  it('stays at the spec gate and emits code-dev-acquire-failed when the dev is unavailable', async () => {
    const m = makeManager();
    await seedSpecApproved();
    vi.spyOn(m, 'releaseAgentForTask').mockResolvedValue(true);
    vi.spyOn(m, 'acquireAgentForTask').mockResolvedValue(false);
    const holdSpy = vi.spyOn(m, 'markAwaitingHuman').mockResolvedValue(true);

    const result = await m.transitionToCodePhase('task-code-1');

    expect(result).toBeNull();
    expect(holdSpy).not.toHaveBeenCalled();
    expect((await taskStore.get('task-code-1'))?.status).toBe('review');
    expect(events.some(e => e.type === 'human.intervention'
      && (e.data as { phase?: string }).phase === 'code-dev-acquire-failed')).toBe(true);
  });

  it('fails the task on a DispatchTerminalError from the code dispatch', async () => {
    const m = makeManager();
    await seedSpecApproved();
    vi.spyOn(m, 'releaseAgentForTask').mockResolvedValue(true);
    vi.spyOn(m, 'acquireAgentForTask').mockResolvedValue(true);
    vi.spyOn(m, 'continueSession').mockRejectedValue(new DispatchTerminalError('prompt_too_large', 'too big'));
    const failSpy = vi.spyOn(m, 'failTaskForDispatchError').mockResolvedValue();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(m.transitionToCodePhase('task-code-1')).rejects.toMatchObject({ reason: 'prompt_too_large' });
    expect(failSpy).toHaveBeenCalledWith('task-code-1', 'code', 'dev-1', expect.anything());
    errSpy.mockRestore();
  });

  it('holds the dev on a generic code dispatch error', async () => {
    const m = makeManager();
    await seedSpecApproved();
    vi.spyOn(m, 'releaseAgentForTask').mockResolvedValue(true);
    vi.spyOn(m, 'acquireAgentForTask').mockResolvedValue(true);
    vi.spyOn(m, 'continueSession').mockRejectedValue(new Error('pane vanished'));
    const holdSpy = vi.spyOn(m, 'markAwaitingHuman').mockResolvedValue(true);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(m.transitionToCodePhase('task-code-1')).rejects.toThrow('pane vanished');
    expect(holdSpy).toHaveBeenCalledWith('dev-1', 'code-dispatch-failed', expect.any(String), { expectedTaskId: 'task-code-1' });
    errSpy.mockRestore();
  });

  it('holds the dev and emits code-resume-failed when the code prompt is not delivered', async () => {
    const m = makeManager();
    await seedSpecApproved();
    vi.spyOn(m, 'releaseAgentForTask').mockResolvedValue(true);
    vi.spyOn(m, 'acquireAgentForTask').mockResolvedValue(true);
    vi.spyOn(m, 'continueSession').mockResolvedValue(false);
    const holdSpy = vi.spyOn(m, 'markAwaitingHuman').mockResolvedValue(true);

    const result = await m.transitionToCodePhase('task-code-1');

    expect(result).toBeNull();
    expect(holdSpy).toHaveBeenCalled();
    expect(events.some(e => e.type === 'human.intervention'
      && (e.data as { phase?: string }).phase === 'code-resume-failed')).toBe(true);
  });
});

describe('AgentManager.releaseAgentForTask waiting-mode gate', () => {
  it('refuses the waiting transition when the bound task is no longer active', async () => {
    const t = await seedTask({ status: 'cancelled' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(manager.releaseAgentForTask('dev-1', t.id, 'waiting')).resolves.toBe(false);

    expect((await agentStore.get('dev-1'))?.taskId).toBe(t.id);
    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('not active'))).toBe(true);
    warnSpy.mockRestore();
  });
});

describe('AgentManager.releaseAgentForTask idle-mode expectedHold gate', () => {
  async function seedHeldQa(): Promise<TaskState> {
    const t = await seedTask({ status: 'review', qaAgentId: 'qa-1' });
    await seedAgent({
      id: 'qa-1', taskId: t.id,
      status: 'awaiting_human', awaitingPhase: 'checkout-preparation-failed',
      awaitingReason: 'repl not ready', awaitingSince: NOW, awaitingNonce: 'gen-a',
    });
    await acquireBoundLock('qa-1', t.id);
    return t;
  }

  it('releases and clears the hold when the expected generation matches', async () => {
    const t = await seedHeldQa();

    const released = await manager.releaseAgentForTask('qa-1', t.id, 'idle', {
      allowAwaitingHuman: true,
      expectedHold: { phase: 'checkout-preparation-failed', since: NOW, nonce: 'gen-a' },
    });

    expect(released).toBe(true);
    const qa = await agentStore.get('qa-1');
    expect(qa?.taskId).toBeUndefined();
    expect(qa?.status).toBeUndefined();
    expect(await lockManager.isLocked('qa-1')).toBe(false);
  });

  it('keeps the hold and the binding when the hold generation does not match', async () => {
    const t = await seedHeldQa();

    const released = await manager.releaseAgentForTask('qa-1', t.id, 'idle', {
      allowAwaitingHuman: true,
      expectedHold: { phase: 'checkout-preparation-failed', since: NOW, nonce: 'gen-z' },
    });

    expect(released).toBe(false);
    const qa = await agentStore.get('qa-1');
    expect(qa?.taskId).toBe(t.id);
    expect(qa?.status).toBe('awaiting_human');
    expect(qa?.awaitingNonce).toBe('gen-a');
    expect(await lockManager.isLocked('qa-1')).toBe(true);
  });

  it('refuses a mismatched hold generation before any workdir side effect', async () => {
    const t = await seedTask({ status: 'review', qaAgentId: 'qa-1' });
    await seedAgent({
      id: 'qa-1', taskId: t.id, paneId: '%1', workdir: '/tmp/qa-repo',
      status: 'awaiting_human', awaitingPhase: 'dispatch-failed:ack_unknown',
      awaitingReason: 'prompt may be running', awaitingSince: NOW, awaitingNonce: 'gen-b',
    });
    await acquireBoundLock('qa-1', t.id);
    const parkSpy = vi.spyOn(BranchManager.prototype, 'parkOnDefaultDetached').mockResolvedValue(undefined);

    const released = await manager.releaseAgentForTask('qa-1', t.id, 'idle', {
      allowAwaitingHuman: true,
      expectedHold: { phase: 'checkout-preparation-failed', since: NOW, nonce: 'gen-a' },
    });

    expect(released).toBe(false);
    expect(parkSpy).not.toHaveBeenCalled();
    const qa = await agentStore.get('qa-1');
    expect(qa?.awaitingPhase).toBe('dispatch-failed:ack_unknown');
    expect(await lockManager.isLocked('qa-1')).toBe(true);
  });

  it('QA REPL 仍忙 → 拒绝释放但不落 hold（忙碌不是清理失败，可再排队）（#563 R38）', async () => {
    const t = await seedTask({ status: 'review', qaAgentId: 'qa-1' });
    await seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1', workdir: '/tmp/qa-repo' });
    await acquireBoundLock('qa-1', t.id);
    vi.spyOn(
      manager as unknown as { inspectReleaseRuntime: (...args: unknown[]) => Promise<unknown> },
      'inspectReleaseRuntime',
    ).mockResolvedValue({ kind: 'pane', pane: { session: 'bx', paneId: '%1', claim: undefined } });
    vi.spyOn(
      manager as unknown as { waitForReplPromptReady: (...args: unknown[]) => Promise<unknown> },
      'waitForReplPromptReady',
    ).mockRejectedValue(new ReplNotReadyError('%1', 'codex', ''));
    const parkSpy = vi.spyOn(BranchManager.prototype, 'parkOnDefaultDetached').mockResolvedValue(undefined);

    const released = await manager.releaseAgentForTask('qa-1', t.id, 'idle', { deferWhenBusy: true });

    expect(released).toBe(false);
    expect(parkSpy).not.toHaveBeenCalled();
    const qa = await agentStore.get('qa-1');
    expect(qa?.taskId).toBe(t.id);
    expect(qa?.status).toBeUndefined();
    expect(qa?.awaitingPhase).toBeUndefined();
  });

  it('release 的忙碌等待走真实实现：持续忙碌时 deferWhenBusy 生效、不落 hold（#563 R45）', async () => {
    const t = await seedTask({ status: 'review', qaAgentId: 'qa-1' });
    await seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1', workdir: '/tmp/qa-repo' });
    await acquireBoundLock('qa-1', t.id);
    Object.assign(manager, { compactIdlePollMs: 1, cleanComposerWaitMs: 5 });
    vi.spyOn(
      manager as unknown as { inspectReleaseRuntime: (...args: unknown[]) => Promise<unknown> },
      'inspectReleaseRuntime',
    ).mockResolvedValue({ kind: 'pane', pane: { session: 'bx', paneId: '%1', claim: undefined } });
    // 真实 waitForReplPromptReady：waitReplReady 通过后仍持续忙碌 → 走「stayed busy past」超时分支
    vi.spyOn(TmuxManager.prototype, 'waitReplReady').mockResolvedValue(undefined as never);
    vi.spyOn(TmuxManager.prototype, 'displayMessage').mockResolvedValue('node');
    vi.spyOn(TmuxManager.prototype, 'readPaneTitle').mockResolvedValue('');
    vi.spyOn(TmuxManager.prototype, 'capturePaneById').mockResolvedValue(
      '• Working (12s)\n  esc to interrupt\n  gpt-5.5 xhigh · ~/repo\n',
    );
    const parkSpy = vi.spyOn(BranchManager.prototype, 'parkOnDefaultDetached').mockResolvedValue(undefined);

    const released = await manager.releaseAgentForTask('qa-1', t.id, 'idle', { deferWhenBusy: true });

    expect(released).toBe(false);
    expect(parkSpy).not.toHaveBeenCalled();
    const qa = await agentStore.get('qa-1');
    expect(qa?.taskId).toBe(t.id);
    expect(qa?.status).toBeUndefined();
  });

  it('未声明 deferWhenBusy 的普通释放（终态/清理路径）遇忙仍落 hold 并告警（#563 R39）', async () => {
    const t = await seedTask({ status: 'merged', qaAgentId: 'qa-1' });
    await seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1', workdir: '/tmp/qa-repo' });
    await acquireBoundLock('qa-1', t.id);
    vi.spyOn(
      manager as unknown as { inspectReleaseRuntime: (...args: unknown[]) => Promise<unknown> },
      'inspectReleaseRuntime',
    ).mockResolvedValue({ kind: 'pane', pane: { session: 'bx', paneId: '%1', claim: undefined } });
    vi.spyOn(
      manager as unknown as { waitForReplPromptReady: (...args: unknown[]) => Promise<unknown> },
      'waitForReplPromptReady',
    ).mockRejectedValue(new ReplNotReadyError('%1', 'codex', ''));

    const released = await manager.releaseAgentForTask('qa-1', t.id, 'idle');

    expect(released).toBe(false);
    const qa = await agentStore.get('qa-1');
    expect(qa?.status).toBe('awaiting_human');
    expect(qa?.awaitingPhase).toBe('branch-cleanup-pending');
  });

  it('dev REPL 忙仍按 branch-cleanup-pending 落 hold（分支清理凭据不可丢）（#563 R38 边界）', async () => {
    const t = await seedTask({ status: 'review', agentId: 'dev-1', branch: 'bx/task-review' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0', workdir: '/tmp/dev-repo' });
    await acquireBoundLock('dev-1', t.id);
    vi.spyOn(
      manager as unknown as { inspectReleaseRuntime: (...args: unknown[]) => Promise<unknown> },
      'inspectReleaseRuntime',
    ).mockResolvedValue({ kind: 'pane', pane: { session: 'bx', paneId: '%0', claim: undefined } });
    vi.spyOn(
      manager as unknown as { waitForReplPromptReady: (...args: unknown[]) => Promise<unknown> },
      'waitForReplPromptReady',
    ).mockRejectedValue(new ReplNotReadyError('%0', 'claude-code', ''));

    const released = await manager.releaseAgentForTask('dev-1', t.id, 'idle');

    expect(released).toBe(false);
    const dev = await agentStore.get('dev-1');
    expect(dev?.status).toBe('awaiting_human');
    expect(dev?.awaitingPhase).toBe('branch-cleanup-pending');
  });

  it('refuses an expectedHold release when the hold was already cleared', async () => {
    const t = await seedTask({ status: 'review', qaAgentId: 'qa-1' });
    await seedAgent({ id: 'qa-1', taskId: t.id });
    await acquireBoundLock('qa-1', t.id);

    const released = await manager.releaseAgentForTask('qa-1', t.id, 'idle', {
      allowAwaitingHuman: true,
      expectedHold: { phase: 'checkout-preparation-failed', since: NOW, nonce: 'gen-a' },
    });

    expect(released).toBe(false);
    const qa = await agentStore.get('qa-1');
    expect(qa?.taskId).toBe(t.id);
    expect(await lockManager.isLocked('qa-1')).toBe(true);
  });

  it('aborts before checkout cleanup when the hold is rewritten during runtime inspection', async () => {
    const t = await seedTask({ status: 'review', qaAgentId: 'qa-1' });
    await seedAgent({
      id: 'qa-1', taskId: t.id, paneId: '%1', workdir: '/tmp/qa-repo',
      status: 'awaiting_human', awaitingPhase: 'checkout-preparation-failed',
      awaitingReason: 'repl not ready', awaitingSince: NOW, awaitingNonce: 'gen-a',
    });
    await acquireBoundLock('qa-1', t.id);
    vi.spyOn(TmuxManager.prototype, 'hasSession').mockImplementation(async () => {
      const held = await agentStore.get('qa-1');
      await agentStore.set({
        ...held!,
        awaitingPhase: 'dispatch-failed:ack_unknown',
        awaitingReason: 'prompt may be running',
        awaitingNonce: 'gen-b',
        updatedAt: new Date().toISOString(),
      });
      return false;
    });
    const parkSpy = vi.spyOn(BranchManager.prototype, 'parkOnDefaultDetached').mockResolvedValue(undefined);

    const released = await manager.releaseAgentForTask('qa-1', t.id, 'idle', {
      allowAwaitingHuman: true,
      expectedHold: { phase: 'checkout-preparation-failed', since: NOW, nonce: 'gen-a' },
    });

    expect(released).toBe(false);
    expect(parkSpy).not.toHaveBeenCalled();
    expect((await agentStore.get('qa-1'))?.awaitingPhase).toBe('dispatch-failed:ack_unknown');
  });

  it('does not let a cleanup failure overwrite a hold rewritten mid-release', async () => {
    const t = await seedTask({ status: 'review', qaAgentId: 'qa-1' });
    await seedAgent({
      id: 'qa-1', taskId: t.id, paneId: '%1', workdir: '/tmp/qa-repo',
      status: 'awaiting_human', awaitingPhase: 'checkout-preparation-failed',
      awaitingReason: 'repl not ready', awaitingSince: NOW, awaitingNonce: 'gen-a',
    });
    await acquireBoundLock('qa-1', t.id);
    vi.spyOn(BranchManager.prototype, 'parkOnDefaultDetached').mockImplementation(async () => {
      const held = await agentStore.get('qa-1');
      await agentStore.set({
        ...held!,
        awaitingPhase: 'dispatch-failed:ack_unknown',
        awaitingReason: 'prompt may be running',
        awaitingNonce: 'gen-b',
        updatedAt: new Date().toISOString(),
      });
      throw new Error('park failed');
    });

    const released = await manager.releaseAgentForTask('qa-1', t.id, 'idle', {
      allowAwaitingHuman: true,
      expectedHold: { phase: 'checkout-preparation-failed', since: NOW, nonce: 'gen-a' },
    });

    expect(released).toBe(false);
    const qa = await agentStore.get('qa-1');
    expect(qa?.awaitingPhase).toBe('dispatch-failed:ack_unknown');
    expect(qa?.awaitingNonce).toBe('gen-b');
    expect(await lockManager.isLocked('qa-1')).toBe(true);
  });

  it('hold 先取得 agent lease 时，release 等待并在任何 checkout 副作用前拒绝', async () => {
    const t = await seedTask({ status: 'review', qaAgentId: 'qa-1' });
    await seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1', workdir: '/tmp/qa-repo' });
    await acquireBoundLock('qa-1', t.id);
    const parkSpy = vi.spyOn(BranchManager.prototype, 'parkOnDefaultDetached').mockResolvedValue(undefined);
    const realUpdate = agentStore.update.bind(agentStore);
    let entered!: () => void;
    let unblock!: () => void;
    const updateEntered = new Promise<void>(resolve => { entered = resolve; });
    const updateUnblocked = new Promise<void>(resolve => { unblock = resolve; });
    vi.spyOn(agentStore, 'update').mockImplementationOnce(async (...args) => {
      entered();
      await updateUnblocked;
      return realUpdate(...args);
    });

    const hold = manager.markAwaitingHuman('qa-1', 'dispatch-failed:ack_unknown', 'prompt unknown', {
      expectedTaskId: t.id,
    });
    await updateEntered;
    const release = manager.releaseAgentForTask('qa-1', t.id, 'idle');
    await Promise.resolve();
    expect(parkSpy).not.toHaveBeenCalled();

    unblock();
    await expect(hold).resolves.toBe(true);
    await expect(release).resolves.toBe(false);
    expect(parkSpy).not.toHaveBeenCalled();
    expect(await agentStore.get('qa-1')).toMatchObject({
      taskId: t.id,
      status: 'awaiting_human',
      awaitingPhase: 'dispatch-failed:ack_unknown',
    });
  });

  it('release 先取得 agent lease 时，hold 不会在 park 期间落库并在解绑后被 CAS 拒绝', async () => {
    const t = await seedTask({ status: 'review', qaAgentId: 'qa-1' });
    await seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1', workdir: '/tmp/qa-repo' });
    await acquireBoundLock('qa-1', t.id);
    vi.spyOn(
      manager as unknown as { inspectReleaseRuntime: (...args: unknown[]) => Promise<unknown> },
      'inspectReleaseRuntime',
    ).mockResolvedValue({ kind: 'absent' });
    let parkEntered!: () => void;
    let unblockPark!: () => void;
    const parked = new Promise<void>(resolve => { parkEntered = resolve; });
    const parkUnblocked = new Promise<void>(resolve => { unblockPark = resolve; });
    vi.spyOn(BranchManager.prototype, 'parkOnDefaultDetached').mockImplementation(async () => {
      parkEntered();
      await parkUnblocked;
    });

    const release = manager.releaseAgentForTask('qa-1', t.id, 'idle');
    await parked;
    const hold = manager.markAwaitingHuman('qa-1', 'dispatch-failed:ack_unknown', 'prompt unknown', {
      expectedTaskId: t.id,
    });
    await Promise.resolve();
    expect((await agentStore.get('qa-1'))?.status).not.toBe('awaiting_human');

    unblockPark();
    await expect(release).resolves.toBe(true);
    await expect(hold).resolves.toBe(false);
    const qa = await agentStore.get('qa-1');
    expect(qa?.taskId).toBeUndefined();
    expect(qa?.status).toBeUndefined();
    expect(await lockManager.isLocked('qa-1')).toBe(false);
  });

  it('agent operation lease advances after a failed predecessor', async () => {
    const t = await seedTask({ status: 'review', qaAgentId: 'qa-1' });
    await seedAgent({ id: 'qa-1', taskId: t.id });
    vi.spyOn(agentStore, 'update').mockRejectedValueOnce(new Error('store down'));

    await expect(manager.markAwaitingHuman(
      'qa-1', 'checkout-preparation-failed', 'first hold', { expectedTaskId: t.id },
    )).rejects.toThrow('store down');
    await expect(manager.markAwaitingHuman(
      'qa-1', 'dispatch-failed:ack_unknown', 'second hold', { expectedTaskId: t.id },
    )).resolves.toBe(true);

    expect(await agentStore.get('qa-1')).toMatchObject({
      status: 'awaiting_human', awaitingPhase: 'dispatch-failed:ack_unknown',
    });
  });
});
