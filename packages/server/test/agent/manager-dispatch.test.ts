import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import type { AgentConfig, BaxianConfig } from '../../src/shared/index.js';
import { DEFAULT_SERVER_CONFIG } from '../../src/shared/index.js';
import { AgentManager } from '../../src/agent/manager.js';
import type { CommandRunner, ExecResult } from '../../src/agent/runner.js';
import { TmuxManager, ReplNotReadyError } from '../../src/agent/tmux.js';
import { BranchManager, DirtyWorkdirError, ReviewHeadMismatchError } from '../../src/agent/branch.js';
import { SkillRegistry } from '../../src/skill/registry.js';
import { useManagerSuiteHarness } from '../helpers/manager-harness.js';

const GIT_BINDING = { mode: 'git', repoKey: 'github.com/user/repo', tool: 'gh' };
const harness = useManagerSuiteHarness();

describe('AgentManager.startSession status gate', () => {
  it('rejects terminal task even when bypassTaskStatusGate=true', async () => {
    await harness.seedTask({ status: 'cancelled' });
    await harness.seedAgent({ id: 'qa-1' });

    const result = await harness.manager.startSession('task-1', 'qa-1', 'review', {
      bypassTaskStatusGate: true,
    });
    expect(result).toBe(false);
    expect((await harness.taskStore.get('task-1'))?.status).toBe('cancelled');
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
    vi.spyOn(harness.manager, 'ensureSession').mockImplementation(async (agentId) => ({
      ok: true,
      createdSession: false,
      freshRuntime: false,
      paneId: '%0',
      workdir: (await harness.agentStore.get(agentId))?.workdir ?? '/tmp/repo',
      ...over,
    }));
    vi.spyOn(
      harness.manager as unknown as { waitForReplPromptReady: (...args: unknown[]) => Promise<void> },
      'waitForReplPromptReady',
    ).mockResolvedValue(undefined);
    vi.spyOn(
      harness.manager as unknown as { clearRuntimeForDispatchBoundary: (...args: unknown[]) => Promise<void> },
      'clearRuntimeForDispatchBoundary',
    ).mockResolvedValue(undefined);
  }

  function useWorkdirRunner(): void {
    (harness.manager as unknown as { runnerFactory: () => CommandRunner }).runnerFactory = () => workdirRunner();
  }

  type ProvisionFn = (runner: CommandRunner, agent: AgentConfig, workdir: string) => Promise<void>;
  const provision = (mgr: AgentManager): ProvisionFn =>
    (mgr as unknown as { provisionRepoSkills: ProvisionFn }).provisionRepoSkills.bind(mgr);

  function agentConfig(over: Partial<AgentConfig> & { id: string }): AgentConfig {
    return { projectId: 'proj', runtime: 'claude-code', role: 'dev', mode: 'local', workdir: '/tmp/repo', ...over } as unknown as AgentConfig;
  }

  it('startSession develop prompt delegates completion kinds to skills', async () => {
    const t = await harness.seedTask({ id: 'task-spec-route-1', branch: 'bx/task-spec-route-1', signalToken: 'devtok1234ab' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.acquireAgentLock('dev-1');

    mockEnsureSession({ freshRuntime: true });
    const prompts = capturePrompts(harness.manager);
    useWorkdirRunner();

    const ok = await harness.manager.startSession(t.id, 'dev-1', 'develop');
    expect(ok).toBe(true);
    expect(prompts[0]).toContain('token: devtok1234ab');
    expect(prompts[0]).not.toMatch(/^(?:spec-)?signal:/m);
  });

  it('startSession assertOwner gates on generation: a DELETE→recreate during ensureSession aborts before checkout', async () => {
    const t = await harness.seedTask({ id: 'task-ss-aba', branch: 'bx/task-ss-aba', signalToken: 'ssaba1234ab' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.acquireAgentLock('dev-1');
    vi.spyOn(harness.manager, 'ensureSession').mockImplementation(async (agentId) => {
      harness.manager.bumpDeletionGeneration(agentId);
      return { ok: true, createdSession: false, freshRuntime: false, paneId: '%0', workdir: '/tmp/repo' };
    });
    const switchSpy = vi.spyOn(BranchManager.prototype, 'switchToTaskBranch');
    useWorkdirRunner();

    await expect(harness.manager.startSession(t.id, 'dev-1', 'develop')).rejects.toThrow(/being deleted or was recreated/);
    expect(switchSpy).not.toHaveBeenCalled();
  });

  it('startSession develop prompt stays kind-free when the task snapshot has QA', async () => {
    const t = await harness.seedTask({
      id: 'task-hasqa-1',
      branch: 'bx/task-hasqa-1',
      qaAgentId: 'qa-1',
      signalToken: 'devtok5678cd',
    });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.acquireAgentLock('dev-1');

    mockEnsureSession({ freshRuntime: true });
    const prompts = capturePrompts(harness.manager);
    useWorkdirRunner();

    const ok = await harness.manager.startSession(t.id, 'dev-1', 'develop');
    expect(ok).toBe(true);
    expect(prompts[0]).toContain('token: devtok5678cd');
    expect(prompts[0]).not.toMatch(/^(?:spec-)?signal:/m);
  });

  it('startSession marks bootstrappingTaskId during dispatch and clears it once the prompt is ack\'d', async () => {
    const t = await harness.seedTask({ id: 'task-deliver-1', branch: 'bx/task-deliver-1' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.acquireAgentLock('dev-1');
    expect((await harness.agentStore.get('dev-1'))?.bootstrappingTaskId).toBeUndefined();

    mockEnsureSession({ freshRuntime: true });
    let markerDuringInject: string | undefined;
    spyInject(harness.manager, async () => {
      markerDuringInject = (await harness.agentStore.get('dev-1'))?.bootstrappingTaskId;
      return { acked: true, composerDelivered: true };
    });
    let markerAtSessionStarted: string | undefined = 'unset';
    const realEmit = harness.eventBus.emit.bind(harness.eventBus);
    vi.spyOn(harness.eventBus, 'emit').mockImplementation(async (ev) => {
      if (ev.type === 'session.started') markerAtSessionStarted = (await harness.agentStore.get('dev-1'))?.bootstrappingTaskId;
      return realEmit(ev);
    });
    useWorkdirRunner();

    const ok = await harness.manager.startSession(t.id, 'dev-1', 'develop');
    expect(ok).toBe(true);
    expect(markerDuringInject).toBe(t.id);
    expect(markerAtSessionStarted).toBeUndefined();
    expect((await harness.agentStore.get('dev-1'))?.bootstrappingTaskId).toBeUndefined();
  });

  it('startSession holds (not destructively cleans up) when clearing the bootstrap marker fails after delivery', async () => {
    const t = await harness.seedTask({ id: 'task-deliver-2', branch: 'bx/task-deliver-2' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.acquireAgentLock('dev-1');

    mockEnsureSession({ freshRuntime: true });
    useWorkdirRunner();

    let afterAck = false;
    let threwOnce = false;
    spyInject(harness.manager, async () => { afterAck = true; return { acked: true, composerDelivered: true }; });
    const realUpdate = harness.agentStore.update.bind(harness.agentStore);
    vi.spyOn(harness.agentStore, 'update').mockImplementation(async (id, updater) => {
      if (afterAck && !threwOnce) { threwOnce = true; throw new Error('marker-clear write blip'); }
      return realUpdate(id, updater);
    });
    const holdSpy = vi.spyOn(harness.manager, 'markAwaitingHuman').mockResolvedValue(true);
    const parkSpy = vi.spyOn(BranchManager.prototype, 'parkOnDefaultDetached').mockResolvedValue(undefined);

    const ok = await harness.manager.startSession(t.id, 'dev-1', 'develop');

    expect(ok).toBe(true);
    expect(parkSpy).not.toHaveBeenCalled();
    expect(holdSpy).toHaveBeenCalledWith(
      'dev-1', 'bootstrap-marker-clear-failed', expect.any(String), { expectedTaskId: t.id },
    );
  });

  it('startSession runs armBeforeInject before pasting the prompt', async () => {
    const t = await harness.seedTask({ id: 'task-arm-before', branch: 'bx/task-arm-before' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.acquireAgentLock('dev-1');

    mockEnsureSession({ freshRuntime: true });
    const prompts = capturePrompts(harness.manager);
    useWorkdirRunner();

    let promptsAtArm = -1;
    const ok = await harness.manager.startSession(t.id, 'dev-1', 'develop', {
      armBeforeInject: async () => { promptsAtArm = prompts.length; return true; },
    });

    expect(ok).toBe(true);
    expect(promptsAtArm).toBe(0);
    expect(prompts.length).toBe(1);
  });

  it('startSession aborts without pasting when armBeforeInject returns false', async () => {
    const t = await harness.seedTask({ id: 'task-arm-abort', branch: 'bx/task-arm-abort' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.acquireAgentLock('dev-1');

    mockEnsureSession({ freshRuntime: true });
    const prompts = capturePrompts(harness.manager);
    useWorkdirRunner();

    const ok = await harness.manager.startSession(t.id, 'dev-1', 'develop', {
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
    await provision(harness.manager)(devRunner as unknown as CommandRunner, devAgent, '/tmp/repo');
    const devStaged = stagedPaths(devRunner);
    expect(devStaged.some(p => /^\/tmp\/repo\/\.claude\/skills\/baxian-greeting\/SKILL\.md\.baxian-tmp-[0-9a-f]{12}$/.test(p))).toBe(true);
    expect(devStaged.some(p => /^\/tmp\/repo\/\.claude\/skills\/baxian-task-check\/SKILL\.md\.baxian-tmp-[0-9a-f]{12}$/.test(p))).toBe(true);
    expect(devStaged.some(p => /\/baxian-(?:rules|server-feedback)\//.test(p))).toBe(false);
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
    await provision(harness.manager)(qaRunner as unknown as CommandRunner, qaAgent, '/tmp/repo');
    const qaStaged = stagedPaths(qaRunner);
    expect(qaStaged.some(p => p.startsWith('/tmp/repo/.agents/skills/baxian-greeting/SKILL.md.baxian-tmp-'))).toBe(true);
    expect(qaStaged.some(p => p.startsWith('/tmp/repo/.agents/skills/baxian-pr-review/SKILL.md.baxian-tmp-'))).toBe(true);
    expect(qaStaged.some(p => /\/baxian-(?:rules|server-feedback)\//.test(p))).toBe(false);
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
    await expect(provision(harness.manager)(runner as unknown as CommandRunner, agent, '/tmp/repo'))
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
    await provision(harness.manager)(runner as unknown as CommandRunner, agent, '/repo-a');
    expect(runner.execWithStdin.mock.calls.length).toBeGreaterThan(0);
    runner.execWithStdin.mockClear();
    await provision(harness.manager)(runner as unknown as CommandRunner, agent, '/repo-b');
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
      provision(harness.manager)(runner as unknown as CommandRunner, agent, '/repo'),
      provision(harness.manager)(runner as unknown as CommandRunner, agent, '/repo'),
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
    await expect(provision(harness.manager)(runner as unknown as CommandRunner, agent, '/tmp/repo')).rejects.toThrow(/symlink-safe/);
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

      await expect(provision(harness.manager)(local, agentConfig({ id: 'dev-rootlink' }), workLink))
        .rejects.toThrow(/skill exclusion probe failed|cannot make injected skills invisible|symlink-safe/);

      expect(await readF(join(outside, '.claude/skills/baxian-old/SKILL.md'), 'utf-8')).toBe('victim');
    } finally {
      await rmTemp(base, { recursive: true, force: true });
    }
  });

  it('skillDirLockKey canonicalizes host + workdir so equivalent agents serialize', async () => {
    const skillRegistry = new SkillRegistry(join(harness.tempDir, 'skills'));
    await skillRegistry.scan();
    const cfg: BaxianConfig = { ...harness.config, host: [{ id: 'box', hostname: 'h', user: 'u', port: 22 }] };
    const m = harness.createManager({ config: cfg, skillRegistry });
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
    const skillRegistry = new SkillRegistry(join(harness.tempDir, 'skills'));
    await skillRegistry.scan();
    return harness.createManager({ config: managedCloneConfig(), skillRegistry });
  }

  it('startSession develop surfaces an unresolvable origin/HEAD from fixed-Workdir branch switching', async () => {
    harness.manager = await makeManagedCloneManager();
    const t = await harness.seedTask({ id: 'task-nohead', branch: 'bx/task-nohead' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0', workdir: '/tmp/repo' });
    await harness.acquireAgentLock('dev-1');

    mockEnsureSession({ freshRuntime: true });
    const switchSpy = vi.spyOn(BranchManager.prototype, 'switchToTaskBranch')
      .mockRejectedValue(new Error('Cannot resolve commit origin/HEAD'));

    await expect(harness.manager.startSession(t.id, 'dev-1', 'develop')).rejects.toThrow(/origin\/HEAD/);
    expect(switchSpy).toHaveBeenCalledWith('/tmp/repo', t.id, t.branch, true, {});
    expect(await harness.agentStore.get('dev-1')).toMatchObject({
      taskId: t.id,
      status: 'awaiting_human',
      awaitingPhase: 'checkout-preparation-failed',
    });
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);
  });

  it('startSession holds the task and lock when the fixed Workdir is dirty', async () => {
    harness.manager = await makeManagedCloneManager();
    const t = await harness.seedTask({ id: 'task-dirty', branch: 'bx/task-dirty' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0', workdir: '/tmp/repo' });
    await harness.acquireAgentLock('dev-1');

    mockEnsureSession({ freshRuntime: true });
    vi.spyOn(BranchManager.prototype, 'switchToTaskBranch')
      .mockRejectedValue(new DirtyWorkdirError('/tmp/repo'));

    await expect(harness.manager.startSession(t.id, 'dev-1', 'develop')).rejects.toMatchObject({
      partial: expect.objectContaining({ handled: true }),
    });
    expect(await harness.agentStore.get('dev-1')).toMatchObject({
      taskId: t.id,
      status: 'awaiting_human',
      awaitingPhase: 'dirty-workdir',
    });
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);
  });

  it('startSession recheck 遇忙不落 hold：登记 qa-recheck pending 并抛 busyPending', async () => {
    harness.manager = await makeManagedCloneManager();
    const t = await harness.seedTask({
      id: 'task-busyq', branch: 'bx/task-busyq', status: 'review',
      platformBinding: GIT_BINDING, passToken: 'aaaaaaaaaaaa', failToken: 'bbbbbbbbbbbb', prNumber: 7, qaAgentId: 'qa-1', signalToken: 'tokA12345678',
    });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%0', workdir: '/tmp/repo-qa' });
    await harness.acquireAgentLock('qa-1', t.id);

    mockEnsureSession();
    vi.spyOn(
      harness.manager as unknown as { waitForReplPromptReady: (...args: unknown[]) => Promise<void> },
      'waitForReplPromptReady',
    ).mockRejectedValue(new ReplNotReadyError('%0', 'codex', '', 'stable idle not confirmed within 5000ms'));

    await expect(harness.manager.startSession(t.id, 'qa-1', 'recheck', {
      dispatchPassToken: 'tokA12345678',
    })).rejects.toMatchObject({
      partial: expect.objectContaining({ handled: true, busyPending: true }),
    });
    const qa = await harness.agentStore.get('qa-1');
    expect(qa?.status).toBeUndefined();
    expect(qa?.awaitingPhase).toBeUndefined();
    expect(qa?.taskId).toBe(t.id);
    expect(await harness.lockManager.isLocked('qa-1')).toBe(true);
    expect(harness.manager.getPendingDispatchRetry(t.id)).toMatchObject({
      kind: 'qa-recheck', agentId: 'qa-1', signalToken: 'tokA12345678',
      qaPhase: 'recheck',
    });
  });

  it('startSession 遇忙但 pass 已被接管（fence 令牌漂移）→ 不登记 pending，走原始失败路径', async () => {
    harness.manager = await makeManagedCloneManager();
    const t = await harness.seedTask({
      id: 'task-busysup', branch: 'bx/task-busysup', status: 'review',
      platformBinding: GIT_BINDING, passToken: 'aaaaaaaaaaaa', failToken: 'bbbbbbbbbbbb', prNumber: 9, qaAgentId: 'qa-1', signalToken: 'successor-tk',
    });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%0', workdir: '/tmp/repo-qa' });
    await harness.acquireAgentLock('qa-1', t.id);

    mockEnsureSession();
    vi.spyOn(
      harness.manager as unknown as { waitForReplPromptReady: (...args: unknown[]) => Promise<void> },
      'waitForReplPromptReady',
    ).mockRejectedValue(new ReplNotReadyError('%0', 'codex', '', 'stable idle not confirmed within 5000ms'));

    await expect(harness.manager.startSession(t.id, 'qa-1', 'recheck', {
      dispatchPassToken: 'old-pass-tok1',
    })).rejects.toBeInstanceOf(ReplNotReadyError);
    expect(harness.manager.getPendingDispatchRetry(t.id)).toBeUndefined();
  });

  it('startSession 遇忙且无 fence 令牌（或令牌核验读失败）→ fail closed 不登记', async () => {
    harness.manager = await makeManagedCloneManager();
    const t = await harness.seedTask({
      id: 'task-busynof', branch: 'bx/task-busynof', status: 'review',
      platformBinding: GIT_BINDING, passToken: 'aaaaaaaaaaaa', failToken: 'bbbbbbbbbbbb', prNumber: 10, qaAgentId: 'qa-1', signalToken: 'tokNF1234567',
    });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%0', workdir: '/tmp/repo-qa' });
    await harness.acquireAgentLock('qa-1', t.id);

    mockEnsureSession();
    vi.spyOn(
      harness.manager as unknown as { waitForReplPromptReady: (...args: unknown[]) => Promise<void> },
      'waitForReplPromptReady',
    ).mockRejectedValue(new ReplNotReadyError('%0', 'codex', '', 'stable idle not confirmed within 5000ms'));

    await expect(harness.manager.startSession(t.id, 'qa-1', 'recheck')).rejects.toBeInstanceOf(ReplNotReadyError);
    expect(harness.manager.getPendingDispatchRetry(t.id)).toBeUndefined();

    const queue = (harness.manager as unknown as {
      queueQaBusyPendingRetry(
        taskId: string, agentId: string, phase: string, createdSession: boolean,
        err: unknown, dispatch: { passToken?: string; roundCounted?: boolean },
      ): Promise<unknown>;
    }).queueQaBusyPendingRetry.bind(harness.manager);
    vi.spyOn(harness.taskStore, 'get').mockRejectedValueOnce(new Error('store read failed'));
    await expect(queue(
      t.id, 'qa-1', 'recheck', false,
      new ReplNotReadyError('%0', 'codex', '', 'busy'),
      { passToken: 'tokNF1234567' },
    )).resolves.toBeNull();
    expect(harness.manager.getPendingDispatchRetry(t.id)).toBeUndefined();
  });

  it('startSession recheck 边界段遇忙同样登记 pending 而非 hold', async () => {
    harness.manager = await makeManagedCloneManager();
    const t = await harness.seedTask({
      id: 'task-busyb', branch: 'bx/task-busyb', status: 'review',
      platformBinding: GIT_BINDING, passToken: 'aaaaaaaaaaaa', failToken: 'bbbbbbbbbbbb', prNumber: 8, qaAgentId: 'qa-1', signalToken: 'tokB12345678',
    });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%0', workdir: '/tmp/repo-qa' });
    await harness.acquireAgentLock('qa-1', t.id);

    mockEnsureSession();
    vi.spyOn(
      harness.manager as unknown as { switchToVerifiedReviewHead: (...args: unknown[]) => Promise<void> },
      'switchToVerifiedReviewHead',
    ).mockResolvedValue(undefined);
    vi.spyOn(
      harness.manager as unknown as { clearRuntimeForDispatchBoundary: (...args: unknown[]) => Promise<void> },
      'clearRuntimeForDispatchBoundary',
    ).mockRejectedValue(new ReplNotReadyError('%0', 'codex', '', 'stable idle not confirmed within 5000ms'));

    await expect(harness.manager.startSession(t.id, 'qa-1', 'recheck', {
      dispatchPassToken: 'tokB12345678',
    })).rejects.toMatchObject({
      partial: expect.objectContaining({ handled: true, busyPending: true }),
    });
    expect((await harness.agentStore.get('qa-1'))?.status).toBeUndefined();
    expect(harness.manager.getPendingDispatchRetry(t.id)).toMatchObject({ kind: 'qa-recheck', agentId: 'qa-1' });
  });

  it('startSession develop 边界段遇忙保持既有 hold 语义（非 QA 相位不登记 pending）', async () => {
    harness.manager = await makeManagedCloneManager();
    const t = await harness.seedTask({ id: 'task-busyd', branch: 'bx/task-busyd' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0', workdir: '/tmp/repo' });
    await harness.acquireAgentLock('dev-1', t.id);

    mockEnsureSession();
    vi.spyOn(BranchManager.prototype, 'switchToTaskBranch').mockResolvedValue();
    vi.spyOn(
      harness.manager as unknown as { clearRuntimeForDispatchBoundary: (...args: unknown[]) => Promise<void> },
      'clearRuntimeForDispatchBoundary',
    ).mockRejectedValue(new ReplNotReadyError('%0', 'claude-code', '', 'stable idle not confirmed within 5000ms'));

    await expect(harness.manager.startSession(t.id, 'dev-1', 'develop')).rejects.toMatchObject({
      partial: expect.objectContaining({ handled: true }),
    });
    expect(await harness.agentStore.get('dev-1')).toMatchObject({
      status: 'awaiting_human',
      awaitingPhase: 'checkout-preparation-failed',
    });
    expect(harness.manager.getPendingDispatchRetry(t.id)).toBeUndefined();
  });

  it('注入阶段预注入忙碌检查命中：同样登记 pending 而非 cleanup/release', async () => {
    harness.manager = await makeManagedCloneManager();
    const t = await harness.seedTask({
      id: 'task-busyinj', branch: 'bx/task-busyinj', status: 'review',
      platformBinding: GIT_BINDING, passToken: 'aaaaaaaaaaaa', failToken: 'bbbbbbbbbbbb', prNumber: 12, qaAgentId: 'qa-1', signalToken: 'tokINJ123456',
    });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%0', workdir: '/tmp/repo-qa' });
    await harness.acquireAgentLock('qa-1', t.id);

    mockEnsureSession();
    vi.spyOn(
      harness.manager as unknown as { switchToVerifiedReviewHead: (...args: unknown[]) => Promise<void> },
      'switchToVerifiedReviewHead',
    ).mockResolvedValue(undefined);
    spyInject(harness.manager, async () => {
      throw new ReplNotReadyError('%0', 'codex', '', 'pre-inject busy check: pane %0 is still running a turn; dispatch aborted');
    });
    const parkSpy = vi.spyOn(BranchManager.prototype, 'parkOnDefaultDetached').mockResolvedValue();

    await expect(harness.manager.startSession(t.id, 'qa-1', 'recheck', {
      dispatchPassToken: 'tokINJ123456',
    })).rejects.toMatchObject({
      partial: expect.objectContaining({ handled: true, busyPending: true }),
    });
    expect(parkSpy).not.toHaveBeenCalled();
    const qa = await harness.agentStore.get('qa-1');
    expect(qa?.taskId).toBe(t.id);
    expect(qa?.status).toBeUndefined();
    expect(harness.manager.getPendingDispatchRetry(t.id)).toMatchObject({
      kind: 'qa-recheck', signalToken: 'tokINJ123456',
    });
  });

  it('pending 登记按代保留预算：同代刷新沿用 since/alerted，pass 换代即重置', async () => {
    harness.manager = await makeManagedCloneManager();
    harness.manager.registerPendingDispatchRetry('task-gen', { kind: 'qa-recheck', agentId: 'qa-1', signalToken: 'gen-a' });
    const first = harness.manager.getPendingDispatchRetry('task-gen')!;
    harness.manager.markPendingDispatchRetryBudgetAlerted('task-gen', { agentId: 'qa-1', signalToken: 'gen-a' });
    harness.manager.markPendingDispatchRetryBudgetAlerted('task-gen', { agentId: 'qa-1', signalToken: 'gen-stale' });

    harness.manager.registerPendingDispatchRetry('task-gen', { kind: 'qa-recheck', agentId: 'qa-1', signalToken: 'gen-a' });
    const sameGen = harness.manager.getPendingDispatchRetry('task-gen')!;
    expect(sameGen.since).toBe(first.since);
    expect(sameGen.budgetAlerted).toBe(true);

    await new Promise(r => setTimeout(r, 2));
    harness.manager.registerPendingDispatchRetry('task-gen', { kind: 'qa-recheck', agentId: 'qa-1', signalToken: 'gen-b' });
    const nextGen = harness.manager.getPendingDispatchRetry('task-gen')!;
    expect(nextGen.since).toBeGreaterThan(first.since);
    expect(nextGen.budgetAlerted).toBeUndefined();
  });

  it('startSession 携带 pass guard 到 injectAndAwaitAck 的 paste fence', async () => {
    harness.manager = await makeManagedCloneManager();
    const t = await harness.seedTask({
      id: 'task-fence2', branch: 'bx/task-fence2', status: 'review',
      platformBinding: GIT_BINDING, passToken: 'aaaaaaaaaaaa', failToken: 'bbbbbbbbbbbb', prNumber: 14, qaAgentId: 'qa-1', signalToken: 'tokF212345678'.slice(0, 12),
    });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%0', workdir: '/tmp/repo-qa' });
    await harness.acquireAgentLock('qa-1', t.id);

    mockEnsureSession();
    vi.spyOn(
      harness.manager as unknown as { switchToVerifiedReviewHead: (...args: unknown[]) => Promise<void> },
      'switchToVerifiedReviewHead',
    ).mockResolvedValue(undefined);
    let guardArg: unknown;
    vi.spyOn(
      harness.manager as unknown as { injectAndAwaitAck: (...args: unknown[]) => Promise<unknown> },
      'injectAndAwaitAck',
    ).mockImplementation(async (...args: unknown[]) => {
      guardArg = args[5];
      return { acked: true, composerDelivered: true };
    });

    const started = await harness.manager.startSession(t.id, 'qa-1', 'recheck', {
      dispatchPassToken: (await harness.taskStore.get(t.id))!.signalToken,
    });

    expect(started).toBe(true);
    expect(typeof guardArg).toBe('function');
    await expect((guardArg as () => Promise<boolean>)()).resolves.toBe(true);
    const fresh = (await harness.taskStore.get(t.id))!;
    await harness.taskStore.set({ ...fresh, signalToken: 'rotated-mid99', updatedAt: new Date().toISOString() });
    await expect((guardArg as () => Promise<boolean>)()).resolves.toBe(false);
  });

  it('paste fence 的 guard 同时复核任务状态：cancelled（token 未变）判 false', async () => {
    harness.manager = await makeManagedCloneManager();
    const t = await harness.seedTask({
      id: 'task-fence4', branch: 'bx/task-fence4', status: 'review',
      platformBinding: GIT_BINDING, passToken: 'aaaaaaaaaaaa', failToken: 'bbbbbbbbbbbb', prNumber: 16, qaAgentId: 'qa-1', signalToken: 'cancel-tok88',
    });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%0', workdir: '/tmp/repo-qa' });
    await harness.acquireAgentLock('qa-1', t.id);

    mockEnsureSession();
    vi.spyOn(
      harness.manager as unknown as { switchToVerifiedReviewHead: (...args: unknown[]) => Promise<void> },
      'switchToVerifiedReviewHead',
    ).mockResolvedValue(undefined);
    let guardArg: unknown;
    vi.spyOn(
      harness.manager as unknown as { injectAndAwaitAck: (...args: unknown[]) => Promise<unknown> },
      'injectAndAwaitAck',
    ).mockImplementation(async (...args: unknown[]) => {
      guardArg = args[5];
      return { acked: true, composerDelivered: true };
    });

    const started = await harness.manager.startSession(t.id, 'qa-1', 'recheck', {
      dispatchPassToken: 'cancel-tok88',
    });

    expect(started).toBe(true);
    await expect((guardArg as () => Promise<boolean>)()).resolves.toBe(true);
    const fresh = (await harness.taskStore.get(t.id))!;
    await harness.taskStore.set({ ...fresh, status: 'cancelled', updatedAt: new Date().toISOString() });
    await expect((guardArg as () => Promise<boolean>)()).resolves.toBe(false);
  });

  it('startSession 成功只按代清除本次派发的 pending：successor 登记不受影响', async () => {
    harness.manager = await makeManagedCloneManager();
    const t = await harness.seedTask({
      id: 'task-clearp', branch: 'bx/task-clearp', status: 'review',
      platformBinding: GIT_BINDING, passToken: 'aaaaaaaaaaaa', failToken: 'bbbbbbbbbbbb', prNumber: 11, qaAgentId: 'qa-1', signalToken: 'tokCL1234567',
    });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%0', workdir: '/tmp/repo-qa' });
    await harness.acquireAgentLock('qa-1', t.id);
    harness.manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: 'tokCL1234567' });

    mockEnsureSession();
    capturePrompts(harness.manager);
    vi.spyOn(
      harness.manager as unknown as { switchToVerifiedReviewHead: (...args: unknown[]) => Promise<void> },
      'switchToVerifiedReviewHead',
    ).mockResolvedValue(undefined);

    expect(await harness.manager.startSession(t.id, 'qa-1', 'recheck', {
      dispatchPassToken: 'tokCL1234567',
    })).toBe(true);
    expect(harness.manager.getPendingDispatchRetry(t.id)).toBeUndefined();

    harness.manager.registerPendingDispatchRetry(t.id, { kind: 'qa-recheck', agentId: 'qa-1', signalToken: 'succ-tok1234' });
    expect(await harness.manager.startSession(t.id, 'qa-1', 'recheck', {
      dispatchPassToken: 'tokCL1234567',
    })).toBe(true);
    expect(harness.manager.getPendingDispatchRetry(t.id)).toMatchObject({ signalToken: 'succ-tok1234' });
  });

  it('startSession develop switches the fixed Workdir to the exact baxian task branch', async () => {
    harness.manager = await makeManagedCloneManager();
    const t = await harness.seedTask({ id: 'task-headok', branch: 'bx/task-headok' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0', workdir: '/tmp/repo' });
    await harness.acquireAgentLock('dev-1');

    mockEnsureSession({ freshRuntime: true });
    capturePrompts(harness.manager);
    const switchSpy = vi.spyOn(BranchManager.prototype, 'switchToTaskBranch').mockResolvedValue();

    const ok = await harness.manager.startSession(t.id, 'dev-1', 'develop');
    expect(ok).toBe(true);
    expect(switchSpy).toHaveBeenCalledWith('/tmp/repo', t.id, t.branch, true, {});
  });

  it('startSession review checks out the remote PR branch detached in the QA Workdir', async () => {
    harness.manager = await makeManagedCloneManager();
    const t = await harness.seedTask({
      id: 'task-ghrev', branch: 'bx/task-ghrev', status: 'review',
      platformBinding: GIT_BINDING, passToken: 'aaaaaaaaaaaa', failToken: 'bbbbbbbbbbbb', prNumber: 7, signalToken: 'revtok1234ab',
      latestHeadSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%0', workdir: '/tmp/repo' });
    await harness.acquireAgentLock('qa-1');

    mockEnsureSession({ freshRuntime: true });
    capturePrompts(harness.manager);
    const switchSpy = vi.spyOn(BranchManager.prototype, 'switchToRemoteBranchDetached').mockResolvedValue();

    const ok = await harness.manager.startSession(t.id, 'qa-1', 'review');
    expect(ok).toBe(true);
    expect(switchSpy).toHaveBeenCalledWith('/tmp/repo', t.branch, t.latestHeadSha);
  });

  it('resolves a moved review head through the driver, never the hardcoded gh path', async () => {
    harness.manager = await makeManagedCloneManager();
    const OLD = 'a'.repeat(40);
    const NEW = 'c'.repeat(40);
    const t = await harness.seedTask({
      id: 'task-moved', branch: 'bx/task-moved', status: 'review',
      platformBinding: GIT_BINDING, passToken: 'aaaaaaaaaaaa', failToken: 'bbbbbbbbbbbb',
      prNumber: 7, signalToken: 'movtok123456', latestHeadSha: OLD,
    });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%0', workdir: '/tmp/repo' });
    await harness.acquireAgentLock('qa-1');
    mockEnsureSession({ freshRuntime: true });
    capturePrompts(harness.manager);

    const driverSpy = vi.spyOn(harness.manager, 'platformFetchPrView').mockResolvedValue({ headSha: NEW } as never);
    let call = 0;
    const switchSpy = vi.spyOn(BranchManager.prototype, 'switchToRemoteBranchDetached')
      .mockImplementation(async () => {
        if (call++ === 0) throw new ReviewHeadMismatchError('bx/task-moved', OLD, NEW);
      });

    const ok = await harness.manager.startSession(t.id, 'qa-1', 'review');

    expect(ok).toBe(true);
    expect(driverSpy).toHaveBeenCalledWith('task-moved');
    expect(switchSpy).toHaveBeenLastCalledWith('/tmp/repo', 'bx/task-moved', NEW);
  });
});
