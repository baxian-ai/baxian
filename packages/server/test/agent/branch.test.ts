import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BranchManager,
  DirtyWorkdirError,
  isAutoDeletableTaskBranch,
} from '../../src/agent/branch.js';
import { LocalRunner, shellQuote, type CommandRunner } from '../../src/agent/runner.js';
import { ReplNotReadyError } from '../../src/agent/tmux.js';
import { createManagerHarness } from '../helpers/manager-harness.js';
import { fakeRunner } from '../helpers/fake-runner.js';
import { makeAgent, makeConfig, makeTask } from '../helpers/fixtures.js';

const local = new LocalRunner();
let tempDir: string;
let origin: string;
let seed: string;
let workdir: string;

async function run(command: string): Promise<string> {
  const result = await local.exec(command);
  if (result.exitCode !== 0) throw new Error(`${command}: ${result.stderr}`);
  return result.stdout.trim();
}

beforeEach(async () => {
  tempDir = await realpath(await mkdtemp(join(tmpdir(), 'baxian-branch-')));
  origin = join(tempDir, 'origin.git');
  seed = join(tempDir, 'seed');
  workdir = join(tempDir, 'agent');
  await run(
    `git init -q --bare ${shellQuote(origin)} && ` +
    `git init -q ${shellQuote(seed)} && ` +
    `git -C ${shellQuote(seed)} config user.name test && ` +
    `git -C ${shellQuote(seed)} config user.email test@example.com && ` +
    `printf base > ${shellQuote(join(seed, 'file.txt'))} && ` +
    `git -C ${shellQuote(seed)} add file.txt && ` +
    `git -C ${shellQuote(seed)} commit -q -m base && ` +
    `git -C ${shellQuote(seed)} branch -M main && ` +
    `git -C ${shellQuote(seed)} remote add origin ${shellQuote(origin)} && ` +
    `git -C ${shellQuote(seed)} push -q -u origin main && ` +
    `git -C ${shellQuote(origin)} symbolic-ref HEAD refs/heads/main && ` +
    `git clone -q ${shellQuote(origin)} ${shellQuote(workdir)} && ` +
    `git -C ${shellQuote(workdir)} config user.name test && ` +
    `git -C ${shellQuote(workdir)} config user.email test@example.com`,
  );
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('isAutoDeletableTaskBranch', () => {
  it('accepts only a proven baxian branch with the exact task namespace', () => {
    expect(isAutoDeletableTaskBranch({
      taskId: 'task-1',
      taskBranch: 'bx/task-1',
      branchCreatedByBaxian: true,
    })).toBe(true);
  });

  it.each([
    { taskId: 'task-1', taskBranch: 'feature/foo', branchCreatedByBaxian: false },
    { taskId: 'task-1', taskBranch: 'bx/task-1', branchCreatedByBaxian: false },
    { taskId: 'task-1', taskBranch: 'bx/task-2', branchCreatedByBaxian: true },
    { taskId: 'task-1', taskBranch: 'bx/task-1-backup', branchCreatedByBaxian: true },
    { taskBranch: 'bx/task-1', branchCreatedByBaxian: true },
  ])('rejects non-exact or unproven identity %#', identity => {
    expect(isAutoDeletableTaskBranch(identity)).toBe(false);
  });
});

describe('BranchManager', () => {
  it('creates the exact baxian task branch from origin/HEAD in the fixed workdir', async () => {
    const manager = new BranchManager(local);
    await manager.switchToTaskBranch(workdir, 'task-1', 'bx/task-1', true);

    expect(await manager.currentRef(workdir)).toBe('refs/heads/bx/task-1');
    expect(await run(`git -C ${shellQuote(workdir)} merge-base --is-ancestor origin/main HEAD; echo $?`)).toBe('0');
    expect(await run(`git -C ${shellQuote(workdir)} config --get branch.bx/task-1.baxian-task-id`)).toBe('task-1');
    expect(await run(`git -C ${shellQuote(workdir)} config --get branch.bx/task-1.remote`)).toBe('origin');
    expect(await run(`git -C ${shellQuote(workdir)} config --get branch.bx/task-1.merge`)).toBe('refs/heads/bx/task-1');
  });

  it('never fetches on its own: remote refresh belongs to the caller that prepared the workdir', async () => {
    const seen: string[] = [];
    const recording: CommandRunner = {
      exec: (command, options) => { seen.push(command); return local.exec(command, options); },
      writeFile: (path, content) => local.writeFile(path, content),
      execWithStdin: (command, stdin, options) => local.execWithStdin(command, stdin, options),
    };
    const manager = new BranchManager(recording);

    await manager.switchToTaskBranch(workdir, 'task-1', 'bx/task-1', true);
    await manager.parkOnDefaultDetached(workdir);
    await manager.switchToTaskBranch(workdir, 'task-1', 'bx/task-1', true);

    expect(await manager.currentRef(workdir)).toBe('refs/heads/bx/task-1');
    expect(seen.filter(c => /\bgit .*\bfetch\b/.test(c))).toEqual([]);
  });

  it('refuses to adopt a pre-existing local branch without baxian task binding proof', async () => {
    await run(`git -C ${shellQuote(workdir)} branch bx/task-1`);

    await expect(
      new BranchManager(local).switchToTaskBranch(workdir, 'task-1', 'bx/task-1', true),
    ).rejects.toThrow(/without baxian task binding proof/i);
    expect(await new BranchManager(local).currentRef(workdir)).toBe('refs/heads/main');
  });

  it('refuses to create an automatic task branch over an existing remote branch', async () => {
    await run(`git -C ${shellQuote(seed)} branch bx/task-1 && git -C ${shellQuote(seed)} push -q origin bx/task-1`);

    await expect(
      new BranchManager(local).switchToTaskBranch(workdir, 'task-1', 'bx/task-1', true),
    ).rejects.toThrow(/already exists on origin/i);
    expect(await new BranchManager(local).currentRef(workdir)).toBe('refs/heads/main');
  });

  async function pushTaskCommit(manager: BranchManager): Promise<string> {
    await manager.switchToTaskBranch(workdir, 'task-1', 'bx/task-1', true);
    await run(
      `printf task > ${shellQuote(join(workdir, 'task.txt'))} && ` +
      `git -C ${shellQuote(workdir)} add task.txt && ` +
      `git -C ${shellQuote(workdir)} commit -q -m task && ` +
      `git -C ${shellQuote(workdir)} push -q origin bx/task-1`,
    );
    return run(`git -C ${shellQuote(workdir)} rev-parse HEAD`);
  }

  async function pushTaskCommitAndCleanLocalRef(manager: BranchManager): Promise<string> {
    const pushedTip = await pushTaskCommit(manager);
    const cleanup = await manager.cleanupTaskBranch(workdir, {
      taskId: 'task-1', taskBranch: 'bx/task-1', branchCreatedByBaxian: true,
    }, async () => {});
    expect(cleanup).toEqual({ status: 'deleted', remoteTipSha: pushedTip });
    expect(await run(
      `git -C ${shellQuote(workdir)} show-ref --verify --quiet refs/heads/bx/task-1; echo $?`,
    )).toBe('1');
    return pushedTip;
  }

  it('restores the task branch from the remote credential after cleanup removed the local ref', async () => {
    const manager = new BranchManager(local);
    const pushedTip = await pushTaskCommitAndCleanLocalRef(manager);

    await manager.switchToTaskBranch(workdir, 'task-1', 'bx/task-1', true, {
      restorableRemoteTip: pushedTip,
    });

    expect(await manager.currentRef(workdir)).toBe('refs/heads/bx/task-1');
    expect(await run(`git -C ${shellQuote(workdir)} rev-parse HEAD`)).toBe(pushedTip);
    expect(await run(`git -C ${shellQuote(workdir)} config --get branch.bx/task-1.baxian-task-id`)).toBe('task-1');
    expect(await run(
      `git -C ${shellQuote(workdir)} rev-parse --symbolic-full-name ${shellQuote('bx/task-1@{upstream}')}`,
    )).toBe('refs/remotes/origin/bx/task-1');
  });

  it('refuses the restore when the remote branch no longer contains the cleaned tip', async () => {
    const manager = new BranchManager(local);
    const pushedTip = await pushTaskCommitAndCleanLocalRef(manager);
    await run(`git -C ${shellQuote(seed)} push -q -f origin main:bx/task-1`);

    await expect(
      manager.switchToTaskBranch(workdir, 'task-1', 'bx/task-1', true, {
        restorableRemoteTip: pushedTip,
      }),
    ).rejects.toThrow(/no longer contains/);
    expect(await manager.currentRef(workdir)).toBeNull();
  });

  it('a missing local branch with a remote namesake still refuses without the credential', async () => {
    const manager = new BranchManager(local);
    await pushTaskCommitAndCleanLocalRef(manager);

    await expect(
      manager.switchToTaskBranch(workdir, 'task-1', 'bx/task-1', true),
    ).rejects.toThrow(/already exists on origin/i);
  });

  it('a continuation with no local ref, no remote, and no credential refuses to recreate the branch', async () => {
    const manager = new BranchManager(local);
    await manager.switchToTaskBranch(workdir, 'task-1', 'bx/task-1', true);
    await run(
      `git -C ${shellQuote(workdir)} switch -q --detach origin/HEAD && ` +
      `git -C ${shellQuote(workdir)} branch -D bx/task-1`,
    );

    await expect(
      manager.switchToTaskBranch(workdir, 'task-1', 'bx/task-1', true, { requireExistingWork: true }),
    ).rejects.toThrow(/refusing to recreate it mid-task/);
    expect(await run(
      `git -C ${shellQuote(workdir)} show-ref --verify --quiet refs/heads/bx/task-1; echo $?`,
    )).toBe('1');
  });

  it('refuses to recreate the branch from scratch when the credential exists but the remote vanished', async () => {
    const manager = new BranchManager(local);
    const pushedTip = await pushTaskCommitAndCleanLocalRef(manager);
    await run(`git -C ${shellQuote(seed)} push -q origin :bx/task-1`);

    await expect(
      manager.switchToTaskBranch(workdir, 'task-1', 'bx/task-1', true, {
        restorableRemoteTip: pushedTip,
      }),
    ).rejects.toThrow(/vanished after its local ref was cleaned up/);
    expect(await manager.currentRef(workdir)).toBeNull();
    expect(await run(
      `git -C ${shellQuote(workdir)} show-ref --verify --quiet refs/heads/bx/task-1; echo $?`,
    )).toBe('1');
  });

  it('recovers an existing marked baxian branch without resetting it', async () => {
    const manager = new BranchManager(local);
    await manager.switchToTaskBranch(workdir, 'task-1', 'bx/task-1', true);
    await run(
      `printf task > ${shellQuote(join(workdir, 'task.txt'))} && ` +
      `git -C ${shellQuote(workdir)} add task.txt && ` +
      `git -C ${shellQuote(workdir)} commit -q -m task && ` +
      `git -C ${shellQuote(workdir)} switch -q --detach origin/HEAD`,
    );
    const taskHead = await run(`git -C ${shellQuote(workdir)} rev-parse bx/task-1`);

    await manager.switchToTaskBranch(workdir, 'task-1', 'bx/task-1', true);

    expect(await run(`git -C ${shellQuote(workdir)} rev-parse HEAD`)).toBe(taskHead);
  });

  it('creates and recovers a custom task branch only with its exact task binding', async () => {
    const manager = new BranchManager(local);
    await manager.switchToTaskBranch(workdir, 'task-1', 'feature/foo', false);
    expect(await run(
      `git -C ${shellQuote(workdir)} config --get branch.feature/foo.baxian-task-id`,
    )).toBe('task-1');
    expect(await run(`git -C ${shellQuote(workdir)} config --get branch.feature/foo.remote`)).toBe('origin');
    expect(await run(`git -C ${shellQuote(workdir)} config --get branch.feature/foo.merge`)).toBe(
      'refs/heads/feature/foo',
    );
    await run(
      `printf task > ${shellQuote(join(workdir, 'custom-task.txt'))} && ` +
      `git -C ${shellQuote(workdir)} add custom-task.txt && ` +
      `git -C ${shellQuote(workdir)} commit -q -m custom-task && ` +
      `git -C ${shellQuote(workdir)} switch -q --detach origin/HEAD`,
    );
    const taskHead = await run(`git -C ${shellQuote(workdir)} rev-parse feature/foo`);

    await manager.switchToTaskBranch(workdir, 'task-1', 'feature/foo', false);

    expect(await manager.currentRef(workdir)).toBe('refs/heads/feature/foo');
    expect(await run(`git -C ${shellQuote(workdir)} rev-parse HEAD`)).toBe(taskHead);
  });

  it('refuses to adopt a pre-existing custom local branch without a task binding', async () => {
    await run(`git -C ${shellQuote(workdir)} branch feature/stale`);

    await expect(
      new BranchManager(local).switchToTaskBranch(workdir, 'task-1', 'feature/stale', false),
    ).rejects.toThrow(/without baxian task binding proof/i);
    expect(await new BranchManager(local).currentRef(workdir)).toBe('refs/heads/main');
  });

  it('refuses to reuse a custom branch bound to a different task', async () => {
    const manager = new BranchManager(local);
    await manager.switchToTaskBranch(workdir, 'task-1', 'feature/shared', false);
    await run(`git -C ${shellQuote(workdir)} switch -q --detach origin/HEAD`);

    await expect(
      manager.switchToTaskBranch(workdir, 'task-2', 'feature/shared', false),
    ).rejects.toThrow(/task binding proof for task task-2/i);
    expect(await manager.currentRef(workdir)).toBeNull();
  });

  it('refuses every dirty state before switching and does not discard it', async () => {
    const manager = new BranchManager(local);
    await run(`printf dirty > ${shellQuote(join(workdir, 'untracked.txt'))}`);

    await expect(
      manager.switchToTaskBranch(workdir, 'task-1', 'bx/task-1', true),
    ).rejects.toBeInstanceOf(DirtyWorkdirError);
    expect(await run(`test -f ${shellQuote(join(workdir, 'untracked.txt'))}; echo $?`)).toBe('0');
    expect(await manager.currentRef(workdir)).toBe('refs/heads/main');
  });

  it.each([
    ['staged', 'M  staged.txt\0'],
    ['tracked', ' M tracked.txt\0'],
    ['untracked', '?? untracked.txt\0'],
    ['conflicted', 'UU conflict.txt\0'],
    ['dirty submodule', ' m submodule\0'],
  ])('treats %s porcelain output as dirty', async (_name, stdout) => {
    const exec = vi.fn<CommandRunner['exec']>().mockResolvedValue({ stdout, stderr: '', exitCode: 0 });
    const manager = new BranchManager({ exec, writeFile: vi.fn(), execWithStdin: vi.fn() });

    await expect(manager.assertClean('/repo')).rejects.toBeInstanceOf(DirtyWorkdirError);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith(expect.stringContaining('--ignore-submodules=none'));
  });

  it('checks out a fetched review branch detached at its exact remote head', async () => {
    await run(
      `git -C ${shellQuote(seed)} switch -q -c review-head && ` +
      `printf review > ${shellQuote(join(seed, 'review.txt'))} && ` +
      `git -C ${shellQuote(seed)} add review.txt && ` +
      `git -C ${shellQuote(seed)} commit -q -m review && ` +
      `git -C ${shellQuote(seed)} push -q -u origin review-head`,
    );
    const expected = await run(`git -C ${shellQuote(seed)} rev-parse HEAD`);
    const manager = new BranchManager(local);

    await manager.switchToRemoteBranchDetached(workdir, 'review-head', expected);

    expect(await manager.currentRef(workdir)).toBeNull();
    expect(await run(`git -C ${shellQuote(workdir)} rev-parse HEAD`)).toBe(expected);
  });

  it('refuses a review checkout without a valid expected head', async () => {
    await expect(
      new BranchManager(local).switchToRemoteBranchDetached(workdir, 'review-head', ''),
    ).rejects.toThrow(/missing a valid expected head/i);
  });

  it('refuses a fetched review branch when it no longer matches the recorded head', async () => {
    await run(
      `git -C ${shellQuote(seed)} switch -q -c review-raced && ` +
      `printf review > ${shellQuote(join(seed, 'review-raced.txt'))} && ` +
      `git -C ${shellQuote(seed)} add review-raced.txt && ` +
      `git -C ${shellQuote(seed)} commit -q -m review-raced && ` +
      `git -C ${shellQuote(seed)} push -q -u origin review-raced`,
    );

    await expect(
      new BranchManager(local).switchToRemoteBranchDetached(
        workdir,
        'review-raced',
        '0000000000000000000000000000000000000000',
      ),
    ).rejects.toThrow(/review head mismatch/i);
    expect(await new BranchManager(local).currentRef(workdir)).toBe('refs/heads/main');
  });

  it('refuses an existing task branch that tracks a different upstream', async () => {
    await run(
      `git -C ${shellQuote(workdir)} branch bx/task-1 && ` +
      `git -C ${shellQuote(workdir)} branch other && ` +
      `git -C ${shellQuote(workdir)} config branch.bx/task-1.baxian-task-id task-1 && ` +
      `git -C ${shellQuote(workdir)} config branch.bx/task-1.remote origin && ` +
      `git -C ${shellQuote(workdir)} config branch.bx/task-1.merge refs/heads/other`,
    );

    await expect(
      new BranchManager(local).switchToTaskBranch(workdir, 'task-1', 'bx/task-1', true),
    ).rejects.toThrow(/tracks .*other/i);
  });

  it('lists bx refs only as cleanup candidates', async () => {
    await run(
      `git -C ${shellQuote(workdir)} branch bx/task-1 && ` +
      `git -C ${shellQuote(workdir)} branch bx/task-1-backup && ` +
      `git -C ${shellQuote(workdir)} branch feature/foo`,
    );

    expect(await new BranchManager(local).listLocalTaskRefs(workdir)).toEqual([
      'refs/heads/bx/task-1',
      'refs/heads/bx/task-1-backup',
    ]);
  });

  it('deletes only the exact pushed baxian local branch and preserves its remote branch', async () => {
    const commands: string[] = [];
    const runner: CommandRunner = {
      exec: async (command, options) => {
        commands.push(command);
        return local.exec(command, options);
      },
      writeFile: (path, content) => local.writeFile(path, content),
      execWithStdin: (command, stdin, options) => local.execWithStdin(command, stdin, options),
    };
    const manager = new BranchManager(runner);
    await manager.switchToTaskBranch(workdir, 'task-1', 'bx/task-1', true);
    await run(
      `printf task > ${shellQuote(join(workdir, 'task.txt'))} && ` +
      `git -C ${shellQuote(workdir)} add task.txt && ` +
      `git -C ${shellQuote(workdir)} commit -q -m task && ` +
      `git -C ${shellQuote(workdir)} push -q origin bx/task-1`,
    );

    const result = await manager.cleanupTaskBranch(workdir, {
      taskId: 'task-1',
      taskBranch: 'bx/task-1',
      branchCreatedByBaxian: true,
    }, async () => undefined);

    expect(result).toEqual({ status: 'deleted', remoteTipSha: expect.stringMatching(/^[0-9a-f]{40,64}$/) });
    expect(await manager.currentRef(workdir)).toBeNull();
    expect(commands.some(command => command.includes('branch -d --'))).toBe(true);
    expect(commands.some(command => command.includes('branch -D'))).toBe(false);
    expect(await run(
      `git -C ${shellQuote(origin)} show-ref --verify refs/heads/bx/task-1`,
    )).toContain('refs/heads/bx/task-1');
  });

  it.each([
    ['feature/foo', false],
    ['release/x', false],
    ['hotfix/y', false],
    ['bx/task-1', false],
    ['bx/task-1-backup', true],
  ])('never invokes branch deletion for custom or near-match branch %s', async (taskBranch, branchCreatedByBaxian) => {
    const exec = vi.fn<CommandRunner['exec']>();
    const manager = new BranchManager({
      exec,
      writeFile: vi.fn(),
      execWithStdin: vi.fn(),
    });

    const result = await manager.cleanupTaskBranch('/repo', {
      taskId: 'task-1',
      taskBranch,
      branchCreatedByBaxian,
    }, async () => undefined);

    expect(result.status).toBe('skipped');
    expect(exec).not.toHaveBeenCalled();
  });

  it('keeps a baxian branch pending when upstream is missing', async () => {
    const commands: string[] = [];
    const runner: CommandRunner = {
      exec: async (command, options) => {
        commands.push(command);
        return local.exec(command, options);
      },
      writeFile: (path, content) => local.writeFile(path, content),
      execWithStdin: (command, stdin, options) => local.execWithStdin(command, stdin, options),
    };
    const manager = new BranchManager(runner);
    await manager.switchToTaskBranch(workdir, 'task-1', 'bx/task-1', true);
    await run(
      `git -C ${shellQuote(workdir)} push -q origin bx/task-1 && ` +
      `git -C ${shellQuote(workdir)} config --unset-all branch.bx/task-1.remote && ` +
      `git -C ${shellQuote(workdir)} config --unset-all branch.bx/task-1.merge`,
    );

    const result = await manager.cleanupTaskBranch(workdir, {
      taskId: 'task-1',
      taskBranch: 'bx/task-1',
      branchCreatedByBaxian: true,
    }, async () => undefined);

    expect(result).toMatchObject({ status: 'pending', reason: expect.stringContaining('upstream') });
    expect(commands.some(command => command.includes('branch -d'))).toBe(false);
    expect(await manager.currentRef(workdir)).toBe('refs/heads/bx/task-1');
  });

  it('preserves a never-pushed local baxian branch and stops retrying when the remote branch is absent', async () => {
    const commands: string[] = [];
    const runner: CommandRunner = {
      exec: async (command, options) => {
        commands.push(command);
        return local.exec(command, options);
      },
      writeFile: (path, content) => local.writeFile(path, content),
      execWithStdin: (command, stdin, options) => local.execWithStdin(command, stdin, options),
    };
    const manager = new BranchManager(runner);
    await manager.switchToTaskBranch(workdir, 'task-1', 'bx/task-1', true);

    const result = await manager.cleanupTaskBranch(workdir, {
      taskId: 'task-1',
      taskBranch: 'bx/task-1',
      branchCreatedByBaxian: true,
    }, async () => undefined);

    expect(result).toMatchObject({
      status: 'skipped',
      reason: expect.stringContaining('preserving the local branch without retry'),
    });
    expect(commands.some(command => command.includes('branch -d'))).toBe(false);
    expect(await run(`git -C ${shellQuote(workdir)} show-ref --verify --quiet refs/heads/bx/task-1; echo $?`)).toBe('0');
  });

  async function pushTaskCommitAndDropRemoteRef(manager: BranchManager): Promise<string> {
    const mergedHead = await pushTaskCommit(manager);
    await run(`git -C ${shellQuote(origin)} update-ref -d refs/heads/bx/task-1`);
    return mergedHead;
  }

  it('deletes the local branch via the merged-head credential when the remote branch is already gone', async () => {
    const manager = new BranchManager(local);
    const mergedHead = await pushTaskCommitAndDropRemoteRef(manager);

    const result = await manager.cleanupTaskBranch(workdir, {
      taskId: 'task-1',
      taskBranch: 'bx/task-1',
      branchCreatedByBaxian: true,
      resolveMergedHeadSha: async () => mergedHead,
    }, async () => undefined);

    expect(result).toEqual({ status: 'deleted' });
    expect(await run(`git -C ${shellQuote(workdir)} show-ref --verify --quiet refs/heads/bx/task-1; echo $?`)).toBe('1');
    expect(await run(
      `git -C ${shellQuote(workdir)} config --local --get branch.bx/task-1.baxian-task-id; echo $?`,
    )).toBe('1');
    expect(await manager.currentRef(workdir)).toBeNull();
  });

  it('keeps the local branch when the merged-head credential does not contain the local tip', async () => {
    const manager = new BranchManager(local);
    const mergedHead = await pushTaskCommitAndDropRemoteRef(manager);
    await run(
      `printf local > ${shellQuote(join(workdir, 'local-only.txt'))} && ` +
      `git -C ${shellQuote(workdir)} add local-only.txt && ` +
      `git -C ${shellQuote(workdir)} commit -q -m local-only`,
    );

    const result = await manager.cleanupTaskBranch(workdir, {
      taskId: 'task-1',
      taskBranch: 'bx/task-1',
      branchCreatedByBaxian: true,
      resolveMergedHeadSha: async () => mergedHead,
    }, async () => undefined);

    expect(result).toMatchObject({
      status: 'skipped',
      reason: expect.stringContaining('does not contain the local tip'),
    });
    expect(await manager.currentRef(workdir)).toBe('refs/heads/bx/task-1');
  });

  it('keeps the local branch when the merged-head credential is unknown to the local repository', async () => {
    const manager = new BranchManager(local);
    await pushTaskCommitAndDropRemoteRef(manager);

    const result = await manager.cleanupTaskBranch(workdir, {
      taskId: 'task-1',
      taskBranch: 'bx/task-1',
      branchCreatedByBaxian: true,
      resolveMergedHeadSha: async () => 'f'.repeat(40),
    }, async () => undefined);

    expect(result).toMatchObject({
      status: 'skipped',
      reason: expect.stringContaining('unknown to the local repository'),
    });
    expect(await run(`git -C ${shellQuote(workdir)} show-ref --verify --quiet refs/heads/bx/task-1; echo $?`)).toBe('0');
  });

  it('refuses the credential deletion while the branch is checked out in a linked worktree', async () => {
    const manager = new BranchManager(local);
    const mergedHead = await pushTaskCommitAndDropRemoteRef(manager);
    const wt = join(tempDir, 'wt');
    await run(
      `git -C ${shellQuote(workdir)} switch -q --detach && ` +
      `git -C ${shellQuote(workdir)} worktree add -q ${shellQuote(wt)} bx/task-1`,
    );

    const result = await manager.cleanupTaskBranch(workdir, {
      taskId: 'task-1',
      taskBranch: 'bx/task-1',
      branchCreatedByBaxian: true,
      resolveMergedHeadSha: async () => mergedHead,
    }, async () => undefined);

    expect(result).toMatchObject({ status: 'pending', reason: expect.stringContaining('worktree') });
    expect(await run(`git -C ${shellQuote(workdir)} show-ref --verify --quiet refs/heads/bx/task-1; echo $?`)).toBe('0');
    expect(await run(`git -C ${shellQuote(wt)} rev-parse HEAD`)).toBe(mergedHead);
  });

  it('keeps cleanup pending when the merged-head lookup rejects', async () => {
    const manager = new BranchManager(local);
    await pushTaskCommitAndDropRemoteRef(manager);

    const result = await manager.cleanupTaskBranch(workdir, {
      taskId: 'task-1',
      taskBranch: 'bx/task-1',
      branchCreatedByBaxian: true,
      resolveMergedHeadSha: async () => { throw new Error('gh api down'); },
    }, async () => undefined);

    expect(result).toMatchObject({
      status: 'pending',
      reason: expect.stringContaining('merged-head lookup failed'),
    });
    expect(await run(`git -C ${shellQuote(workdir)} show-ref --verify --quiet refs/heads/bx/task-1; echo $?`)).toBe('0');
  });

  it('keeps the local branch when the platform head sha is not a full object id', async () => {
    const manager = new BranchManager(local);
    const mergedHead = await pushTaskCommitAndDropRemoteRef(manager);

    const result = await manager.cleanupTaskBranch(workdir, {
      taskId: 'task-1',
      taskBranch: 'bx/task-1',
      branchCreatedByBaxian: true,
      resolveMergedHeadSha: async () => mergedHead.slice(0, 12),
    }, async () => undefined);

    expect(result).toMatchObject({
      status: 'skipped',
      reason: expect.stringContaining('not a full object id'),
    });
    expect(await run(`git -C ${shellQuote(workdir)} show-ref --verify --quiet refs/heads/bx/task-1; echo $?`)).toBe('0');
  });

  it('refuses the credential deletion when the branch advances after the containment check', async () => {
    const mergedHead = await pushTaskCommitAndDropRemoteRef(new BranchManager(local));
    let advanced = false;
    const runner: CommandRunner = {
      exec: async (command, options) => {
        const result = await local.exec(command, options);
        if (!advanced && command.includes('merge-base --is-ancestor')) {
          advanced = true;
          await local.exec(
            `git -C ${shellQuote(workdir)} commit -q --allow-empty -m sneak && ` +
            `git -C ${shellQuote(workdir)} update-ref refs/heads/bx/task-1 HEAD`,
          );
        }
        return result;
      },
      writeFile: (path, content) => local.writeFile(path, content),
      execWithStdin: (command, stdin, options) => local.execWithStdin(command, stdin, options),
    };

    const result = await new BranchManager(runner).cleanupTaskBranch(workdir, {
      taskId: 'task-1',
      taskBranch: 'bx/task-1',
      branchCreatedByBaxian: true,
      resolveMergedHeadSha: async () => mergedHead,
    }, async () => undefined);

    expect(result).toMatchObject({
      status: 'pending',
      reason: expect.stringContaining('refused'),
    });
    expect(await run(`git -C ${shellQuote(workdir)} show-ref --verify --quiet refs/heads/bx/task-1; echo $?`)).toBe('0');
  });

  it('converges a config cleanup failure through the next ref-missing pass', async () => {
    const mergedHead = await pushTaskCommitAndDropRemoteRef(new BranchManager(local));
    const runner: CommandRunner = {
      exec: async (command, options) => command.includes('--remove-section')
        ? { stdout: '', stderr: 'error: could not lock config file .git/config', exitCode: 255 }
        : local.exec(command, options),
      writeFile: (path, content) => local.writeFile(path, content),
      execWithStdin: (command, stdin, options) => local.execWithStdin(command, stdin, options),
    };
    const identity = {
      taskId: 'task-1',
      taskBranch: 'bx/task-1',
      branchCreatedByBaxian: true,
      resolveMergedHeadSha: async () => mergedHead,
    };

    const first = await new BranchManager(runner).cleanupTaskBranch(workdir, identity, async () => undefined);
    expect(first).toMatchObject({
      status: 'pending',
      reason: expect.stringContaining('config cleanup failed'),
    });
    expect(await run(`git -C ${shellQuote(workdir)} show-ref --verify --quiet refs/heads/bx/task-1; echo $?`)).toBe('1');
    expect(await run(
      `git -C ${shellQuote(workdir)} config --local --get branch.bx/task-1.baxian-task-id; echo $?`,
    )).toBe('task-1\n0');

    const second = await new BranchManager(local).cleanupTaskBranch(workdir, identity, async () => undefined);
    expect(second).toEqual({ status: 'deleted' });
    expect(await run(
      `git -C ${shellQuote(workdir)} config --local --get branch.bx/task-1.baxian-task-id; echo $?`,
    )).toBe('1');
  });

  it('sweeps leftover branch config when the local ref is already gone', async () => {
    const manager = new BranchManager(local);
    await manager.switchToTaskBranch(workdir, 'task-1', 'bx/task-1', true);
    await run(
      `git -C ${shellQuote(workdir)} switch -q --detach && ` +
      `git -C ${shellQuote(workdir)} update-ref --no-deref -d refs/heads/bx/task-1`,
    );

    const result = await manager.cleanupTaskBranch(workdir, {
      taskId: 'task-1',
      taskBranch: 'bx/task-1',
      branchCreatedByBaxian: true,
    }, async () => undefined);

    expect(result).toEqual({ status: 'deleted' });
    expect(await run(
      `git -C ${shellQuote(workdir)} config --local --get branch.bx/task-1.baxian-task-id; echo $?`,
    )).toBe('1');
  });

  it('leaves a foreign branch config section alone when sweeping a missing ref', async () => {
    const manager = new BranchManager(local);
    await manager.switchToTaskBranch(workdir, 'task-1', 'bx/task-1', true);
    await run(
      `git -C ${shellQuote(workdir)} switch -q --detach && ` +
      `git -C ${shellQuote(workdir)} update-ref --no-deref -d refs/heads/bx/task-1 && ` +
      `git -C ${shellQuote(workdir)} config --local branch.bx/task-1.baxian-task-id task-2`,
    );

    const result = await manager.cleanupTaskBranch(workdir, {
      taskId: 'task-1',
      taskBranch: 'bx/task-1',
      branchCreatedByBaxian: true,
    }, async () => undefined);

    expect(result).toEqual({ status: 'deleted' });
    expect(await run(
      `git -C ${shellQuote(workdir)} config --local --get branch.bx/task-1.baxian-task-id`,
    )).toBe('task-2');
  });

  it('keeps the remote tip credential on a pending config cleanup after the ref deletion', async () => {
    const manager = new BranchManager(local);
    const remoteTip = await pushTaskCommit(manager);
    let markerReads = 0;
    const runner: CommandRunner = {
      exec: async (command, options) => {
        if (command.includes('--remove-section')) {
          return { stdout: '', stderr: 'error: could not lock config file .git/config', exitCode: 255 };
        }
        if (command.includes('baxian-task-id') && command.includes('--get')) {
          markerReads += 1;
          if (markerReads > 1) return { stdout: 'task-1\n', stderr: '', exitCode: 0 };
        }
        return local.exec(command, options);
      },
      writeFile: (path, content) => local.writeFile(path, content),
      execWithStdin: (command, stdin, options) => local.execWithStdin(command, stdin, options),
    };

    const result = await new BranchManager(runner).cleanupTaskBranch(workdir, {
      taskId: 'task-1',
      taskBranch: 'bx/task-1',
      branchCreatedByBaxian: true,
    }, async () => undefined);

    expect(result).toEqual({
      status: 'pending',
      reason: expect.stringContaining('config cleanup failed'),
      remoteTipSha: remoteTip,
    });
    expect(await run(`git -C ${shellQuote(workdir)} show-ref --verify --quiet refs/heads/bx/task-1; echo $?`)).toBe('1');
  });

  it('keeps the cleanup retryable when the containment probe transport fails', async () => {
    const mergedHead = await pushTaskCommitAndDropRemoteRef(new BranchManager(local));
    const runner: CommandRunner = {
      exec: async (command, options) => command.includes('merge-base --is-ancestor')
        ? { stdout: '', stderr: 'ssh: connection to host lost', exitCode: 255 }
        : local.exec(command, options),
      writeFile: (path, content) => local.writeFile(path, content),
      execWithStdin: (command, stdin, options) => local.execWithStdin(command, stdin, options),
    };

    const result = await new BranchManager(runner).cleanupTaskBranch(workdir, {
      taskId: 'task-1',
      taskBranch: 'bx/task-1',
      branchCreatedByBaxian: true,
      resolveMergedHeadSha: async () => mergedHead,
    }, async () => undefined);

    expect(result).toMatchObject({
      status: 'pending',
      reason: expect.stringContaining('containment probe failed'),
    });
    expect(await run(`git -C ${shellQuote(workdir)} show-ref --verify --quiet refs/heads/bx/task-1; echo $?`)).toBe('0');
  });

  it('deletes via the merged-head credential when the remote branch disappears during cleanup', async () => {
    const mergedHead = await pushTaskCommit(new BranchManager(local));
    let probes = 0;
    const runner: CommandRunner = {
      exec: async (command, options) => {
        if (command.includes('ls-remote --heads origin')) {
          probes += 1;
          return {
            stdout: probes === 1 ? `${mergedHead}\trefs/heads/bx/task-1\n` : '',
            stderr: '',
            exitCode: 0,
          };
        }
        if (command.includes(' fetch origin')) {
          return { stdout: '', stderr: 'remote hung up unexpectedly', exitCode: 128 };
        }
        return local.exec(command, options);
      },
      writeFile: (path, content) => local.writeFile(path, content),
      execWithStdin: (command, stdin, options) => local.execWithStdin(command, stdin, options),
    };

    const result = await new BranchManager(runner).cleanupTaskBranch(workdir, {
      taskId: 'task-1',
      taskBranch: 'bx/task-1',
      branchCreatedByBaxian: true,
      resolveMergedHeadSha: async () => mergedHead,
    }, async () => undefined);

    expect(result).toEqual({ status: 'deleted' });
    expect(await run(`git -C ${shellQuote(workdir)} show-ref --verify --quiet refs/heads/bx/task-1; echo $?`)).toBe('1');
  });

  it('never deletes an exact bx task branch without the Git ownership marker', async () => {
    await run(
      `git -C ${shellQuote(workdir)} switch -q -c bx/task-1 && ` +
      `git -C ${shellQuote(workdir)} push -q -u origin bx/task-1`,
    );
    const manager = new BranchManager(local);

    const result = await manager.cleanupTaskBranch(workdir, {
      taskId: 'task-1',
      taskBranch: 'bx/task-1',
      branchCreatedByBaxian: true,
    }, async () => undefined);

    expect(result).toMatchObject({ status: 'skipped', reason: expect.stringContaining('ownership marker') });
    expect(await run(`git -C ${shellQuote(workdir)} show-ref --verify --quiet refs/heads/bx/task-1; echo $?`)).toBe('0');
  });

  it('keeps the local branch when the remote does not contain its latest commit', async () => {
    const manager = new BranchManager(local);
    await manager.switchToTaskBranch(workdir, 'task-1', 'bx/task-1', true);
    await run(`git -C ${shellQuote(workdir)} push -q -u origin bx/task-1`);
    await run(
      `printf local > ${shellQuote(join(workdir, 'local-only.txt'))} && ` +
      `git -C ${shellQuote(workdir)} add local-only.txt && ` +
      `git -C ${shellQuote(workdir)} commit -q -m local-only`,
    );

    const result = await manager.cleanupTaskBranch(workdir, {
      taskId: 'task-1',
      taskBranch: 'bx/task-1',
      branchCreatedByBaxian: true,
    }, async () => undefined);

    expect(result).toMatchObject({ status: 'pending', reason: expect.stringContaining('does not contain') });
    expect(await manager.currentRef(workdir)).toBe('refs/heads/bx/task-1');
  });

  it('reports an ancestry probe error instead of treating it as an ordinary divergence', async () => {
    const setup = new BranchManager(local);
    await setup.switchToTaskBranch(workdir, 'task-1', 'bx/task-1', true);
    await run(`git -C ${shellQuote(workdir)} push -q origin bx/task-1`);
    const runner: CommandRunner = {
      exec: (command, options) => command.includes('merge-base --is-ancestor')
        ? Promise.resolve({ stdout: '', stderr: 'object database unavailable', exitCode: 128 })
        : local.exec(command, options),
      writeFile: (path, content) => local.writeFile(path, content),
      execWithStdin: (command, stdin, options) => local.execWithStdin(command, stdin, options),
    };

    const result = await new BranchManager(runner).cleanupTaskBranch(workdir, {
      taskId: 'task-1',
      taskBranch: 'bx/task-1',
      branchCreatedByBaxian: true,
    }, async () => undefined);

    expect(result).toMatchObject({
      status: 'pending',
      reason: expect.stringContaining('ancestry probe failed'),
    });
    expect(await run(`git -C ${shellQuote(workdir)} show-ref --verify --quiet refs/heads/bx/task-1; echo $?`)).toBe('0');
  });

  it('stops before checkout or deletion when the ownership token changes', async () => {
    const manager = new BranchManager(local);
    await manager.switchToTaskBranch(workdir, 'task-1', 'bx/task-1', true);
    await run(`git -C ${shellQuote(workdir)} push -q -u origin bx/task-1`);

    await expect(manager.cleanupTaskBranch(workdir, {
      taskId: 'task-1',
      taskBranch: 'bx/task-1',
      branchCreatedByBaxian: true,
    }, async () => { throw new Error('stale owner token'); })).rejects.toThrow(/stale owner token/);

    expect(await manager.currentRef(workdir)).toBe('refs/heads/bx/task-1');
    expect(await run(`git -C ${shellQuote(workdir)} show-ref --verify --quiet refs/heads/bx/task-1; echo $?`)).toBe('0');
  });

  it('deletes safely when the remote is ahead but still contains the local tip', async () => {
    const manager = new BranchManager(local);
    await manager.switchToTaskBranch(workdir, 'task-1', 'bx/task-1', true);
    await run(`git -C ${shellQuote(workdir)} push -q -u origin bx/task-1`);
    await run(
      `git -C ${shellQuote(seed)} fetch -q origin bx/task-1 && ` +
      `git -C ${shellQuote(seed)} switch -q -c bx/task-1 --track origin/bx/task-1 && ` +
      `printf remote > ${shellQuote(join(seed, 'remote-only.txt'))} && ` +
      `git -C ${shellQuote(seed)} add remote-only.txt && ` +
      `git -C ${shellQuote(seed)} commit -q -m remote-only && ` +
      `git -C ${shellQuote(seed)} push -q origin bx/task-1`,
    );

    const result = await manager.cleanupTaskBranch(workdir, {
      taskId: 'task-1',
      taskBranch: 'bx/task-1',
      branchCreatedByBaxian: true,
    }, async () => undefined);

    expect(result).toEqual({ status: 'deleted', remoteTipSha: expect.stringMatching(/^[0-9a-f]{40,64}$/) });
  });

  it('keeps cleanup pending when the post-delete exact-ref probe fails', async () => {
    let deleted = false;
    const runner: CommandRunner = {
      exec: async (command, options) => {
        if (deleted && command.includes('show-ref --verify --quiet')) {
          return { stdout: '', stderr: 'git metadata unavailable', exitCode: 2 };
        }
        const result = await local.exec(command, options);
        if (command.includes('branch -d --') && result.exitCode === 0) deleted = true;
        return result;
      },
      writeFile: (path, content) => local.writeFile(path, content),
      execWithStdin: (command, stdin, options) => local.execWithStdin(command, stdin, options),
    };
    const manager = new BranchManager(runner);
    await manager.switchToTaskBranch(workdir, 'task-1', 'bx/task-1', true);
    await run(`git -C ${shellQuote(workdir)} push -q origin bx/task-1`);

    const result = await manager.cleanupTaskBranch(workdir, {
      taskId: 'task-1',
      taskBranch: 'bx/task-1',
      branchCreatedByBaxian: true,
    }, async () => undefined);

    expect(result).toMatchObject({
      status: 'pending',
      reason: expect.stringContaining('deletion verification failed'),
    });
  });

  it('periodic reconciliation deletes a proven terminal task branch and leaves user branches untouched', async () => {
    const now = new Date().toISOString();
    const autoTask = makeTask({
      id: 'task-1',
      title: 'auto',
      description: '',
      phase: 'code',
      platformBinding: undefined,
      status: 'merged',
      createdAt: now,
      updatedAt: now,
    });
    const customTask = makeTask({
      ...autoTask, id: 'task-2', title: 'custom', branch: 'bx/task-2', branchCreatedByBaxian: false,
    });
    await run(
      `git -C ${shellQuote(workdir)} switch -q -c bx/task-1 && ` +
      `printf task > ${shellQuote(join(workdir, 'task.txt'))} && ` +
      `git -C ${shellQuote(workdir)} add task.txt && ` +
      `git -C ${shellQuote(workdir)} commit -q -m task && ` +
      `git -C ${shellQuote(workdir)} config branch.bx/task-1.baxian-task-id task-1 && ` +
      `git -C ${shellQuote(workdir)} push -q -u origin bx/task-1 && ` +
      `git -C ${shellQuote(workdir)} branch bx/task-2`,
    );
    const stateRoot = join(tempDir, 'manager-state');
    const config = makeConfig({
      project: [{
        id: 'proj', repo: 'https://github.com/owner/repo.git', merge: null,
        agent: [[
          makeAgent({ runtime: 'codex', workdir }),
          makeAgent({ id: 'qa-1', runtime: 'codex', role: 'qa', workdir: '/tmp/qa-repo' }),
        ]],
      }],
    });
    const maintenanceRunner = fakeRunner({
      rules: [
        {
          match: 'tmux has-session',
          reply: { stderr: "can't find session: dev-1", exitCode: 1 },
        },
        {
          match: command => !command.includes('tmux '),
          reply: (command, options) => local.exec(command, options),
        },
      ],
    });
    const harness = await createManagerHarness(stateRoot, {
      config,
      deps: {
        runnerFactory: () => maintenanceRunner,
        platformRunner: maintenanceRunner,
      },
    });
    const { manager, agentStore, taskStore, lockManager } = harness;
    await agentStore.set({ id: 'dev-1', projectId: 'proj', workdir, updatedAt: now });
    await taskStore.set(autoTask);
    await taskStore.set(customTask);

    await manager.reconcileTaskBranches();

    expect(await run(`git -C ${shellQuote(workdir)} show-ref --verify --quiet refs/heads/bx/task-1; echo $?`)).toBe('1');
    expect(await run(`git -C ${shellQuote(workdir)} show-ref --verify --quiet refs/heads/bx/task-2; echo $?`)).toBe('0');
    expect(await lockManager.isLocked('dev-1')).toBe(false);
  });

  it('periodic reconciliation deletes a merged task branch via the merged-head credential after the remote is gone', async () => {
    const now = new Date().toISOString();
    const mergedHead = await pushTaskCommitAndDropRemoteRef(new BranchManager(local));
    const task = makeTask({
      id: 'task-1',
      title: 'auto',
      description: '',
      phase: 'code',
      platformBinding: undefined,
      status: 'merged',
      prNumber: 7,
      createdAt: now,
      updatedAt: now,
    });
    const stateRoot = join(tempDir, 'credential-manager-state');
    const config = makeConfig({
      project: [{
        id: 'proj', repo: 'https://github.com/owner/repo.git', merge: null,
        agent: [[
          makeAgent({ runtime: 'codex', workdir }),
          makeAgent({ id: 'qa-1', runtime: 'codex', role: 'qa', workdir: '/tmp/qa-repo' }),
        ]],
      }],
    });
    const maintenanceRunner = fakeRunner({
      rules: [
        {
          match: 'tmux has-session',
          reply: { stderr: "can't find session: dev-1", exitCode: 1 },
        },
        {
          match: 'repos/owner/repo/pulls/7',
          reply: {
            stdout: JSON.stringify({
              number: 7, html_url: 'https://github.com/owner/repo/pull/7', title: 'auto',
              state: 'closed', draft: false, merged_at: now, updated_at: now,
              head: { sha: mergedHead, ref: 'bx/task-1', repo: { id: 11 } },
              base: { ref: 'main', repo: { id: 11 } },
              user: { login: 'u' },
            }),
            exitCode: 0,
          },
        },
        {
          match: command => !command.includes('tmux '),
          reply: (command, options) => local.exec(command, options),
        },
      ],
    });
    const harness = await createManagerHarness(stateRoot, {
      config,
      deps: {
        runnerFactory: () => maintenanceRunner,
        platformRunner: maintenanceRunner,
      },
    });
    const { manager, agentStore, taskStore } = harness;
    await agentStore.set({ id: 'dev-1', projectId: 'proj', workdir, updatedAt: now });
    await taskStore.set(task);

    await manager.reconcileTaskBranches();

    expect(await run(`git -C ${shellQuote(workdir)} show-ref --verify --quiet refs/heads/bx/task-1; echo $?`)).toBe('1');
    const after = await taskStore.get('task-1');
    expect(after?.branchCleanupSkipped).toBeUndefined();
    expect(after?.branchCleanupPending).toBeUndefined();
  });

  it('periodic reconciliation converges a pending task whose local ref is already gone', async () => {
    const now = new Date().toISOString();
    await new BranchManager(local).switchToTaskBranch(workdir, 'task-1', 'bx/task-1', true);
    await run(
      `git -C ${shellQuote(workdir)} switch -q --detach && ` +
      `git -C ${shellQuote(workdir)} update-ref --no-deref -d refs/heads/bx/task-1`,
    );
    const task = makeTask({
      id: 'task-1',
      title: 'auto',
      description: '',
      phase: 'code',
      platformBinding: undefined,
      status: 'merged',
      branchCleanupPending: { agentId: 'dev-1', reason: 'branch config cleanup failed: lock', updatedAt: now },
      createdAt: now,
      updatedAt: now,
    });
    const stateRoot = join(tempDir, 'orphan-manager-state');
    const config = makeConfig({
      project: [{
        id: 'proj', repo: 'https://github.com/owner/repo.git', merge: null,
        agent: [[
          makeAgent({ runtime: 'codex', workdir }),
          makeAgent({ id: 'qa-1', runtime: 'codex', role: 'qa', workdir: '/tmp/qa-repo' }),
        ]],
      }],
    });
    const maintenanceRunner = fakeRunner({
      rules: [
        {
          match: 'tmux has-session',
          reply: { stderr: "can't find session: dev-1", exitCode: 1 },
        },
        {
          match: command => !command.includes('tmux '),
          reply: (command, options) => local.exec(command, options),
        },
      ],
    });
    const harness = await createManagerHarness(stateRoot, {
      config,
      deps: {
        runnerFactory: () => maintenanceRunner,
        platformRunner: maintenanceRunner,
      },
    });
    const { manager, agentStore, taskStore } = harness;
    await agentStore.set({ id: 'dev-1', projectId: 'proj', workdir, updatedAt: now });
    await taskStore.set(task);

    await manager.reconcileTaskBranches();

    const after = await taskStore.get('task-1');
    expect(after?.branchCleanupPending).toBeUndefined();
    expect(after?.branchCleanupSkipped).toBeUndefined();
    expect(await run(
      `git -C ${shellQuote(workdir)} config --local --get branch.bx/task-1.baxian-task-id; echo $?`,
    )).toBe('1');
  });

  it('periodic reconciliation leaves branches untouched while the runtime is not idle', async () => {
    const now = new Date().toISOString();
    const task = makeTask({
      id: 'task-1',
      title: 'auto',
      description: '',
      phase: 'code',
      platformBinding: undefined,
      status: 'merged',
      createdAt: now,
      updatedAt: now,
    });
    await run(
      `git -C ${shellQuote(workdir)} switch -q -c bx/task-1 && ` +
      `git -C ${shellQuote(workdir)} config branch.bx/task-1.baxian-task-id task-1 && ` +
      `git -C ${shellQuote(workdir)} config branch.bx/task-1.remote origin && ` +
      `git -C ${shellQuote(workdir)} config branch.bx/task-1.merge refs/heads/bx/task-1 && ` +
      `git -C ${shellQuote(workdir)} push -q origin bx/task-1`,
    );
    const stateRoot = join(tempDir, 'busy-manager-state');
    const config = makeConfig({
      project: [{
        id: 'proj', repo: 'https://github.com/owner/repo.git', merge: null,
        agent: [[
          makeAgent({ runtime: 'codex', workdir }),
          makeAgent({ id: 'qa-1', runtime: 'codex', role: 'qa', workdir: '/tmp/qa-repo' }),
        ]],
      }],
    });
    const runtimeRunner = fakeRunner({
      agents: {
        'dev-1': { paneId: '%7', process: 'codex' },
      },
      rules: [
        {
          match: command => !command.includes('tmux '),
          reply: (command, options) => local.exec(command, options),
        },
      ],
    });
    const harness = await createManagerHarness(stateRoot, {
      config,
      deps: {
        runnerFactory: () => runtimeRunner,
        platformRunner: runtimeRunner,
      },
    });
    const { manager, agentStore, taskStore, lockManager } = harness;
    await agentStore.set({ id: 'dev-1', projectId: 'proj', paneId: '%7', workdir, updatedAt: now });
    await taskStore.set(task);
    vi.spyOn(
      manager as unknown as { waitForReplPromptReady: (...args: unknown[]) => Promise<void> },
      'waitForReplPromptReady',
    ).mockRejectedValue(new ReplNotReadyError('%7', 'codex', 'runtime still busy'));

    await manager.reconcileTaskBranches();

    expect(await run(`git -C ${shellQuote(workdir)} show-ref --verify --quiet refs/heads/bx/task-1; echo $?`)).toBe('0');
    const first = await taskStore.get('task-1');
    expect(first).toMatchObject({
      branchCleanupPending: {
        agentId: 'dev-1',
        reason: expect.stringContaining('runtime is not idle'),
      },
    });
    expect(await lockManager.isLocked('dev-1')).toBe(false);

    await manager.reconcileTaskBranches();

    const second = await taskStore.get('task-1');
    expect(second?.updatedAt).toBe(first?.updatedAt);
    expect(second?.branchCleanupPending?.updatedAt).toBe(first?.branchCleanupPending?.updatedAt);
  });

  it('does not acquire a maintenance lock for a terminal branch already marked as preserved', async () => {
    const now = new Date().toISOString();
    const stateRoot = join(tempDir, 'skipped-manager-state');
    const config = makeConfig({
      project: [{
        id: 'proj', repo: 'https://github.com/owner/repo.git', merge: null,
        agent: [[
          makeAgent({ runtime: 'codex', workdir }),
          makeAgent({ id: 'qa-1', runtime: 'codex', role: 'qa', workdir: '/tmp/qa-repo' }),
        ]],
      }],
    });
    const harness = await createManagerHarness(stateRoot, {
      config,
      deps: {
        runnerFactory: () => local,
        platformRunner: local,
      },
    });
    const { manager, agentStore, taskStore, lockManager } = harness;
    await agentStore.set({ id: 'dev-1', projectId: 'proj', workdir, updatedAt: now });
    await taskStore.set(makeTask({
      id: 'task-1',
      title: 'auto',
      description: '',
      phase: 'code',
      platformBinding: undefined,
      status: 'merged',
      branchCleanupSkipped: {
        agentId: 'dev-1',
        reason: 'remote branch is absent; preserving the local branch without retry',
        updatedAt: now,
      },
      createdAt: now,
      updatedAt: now,
    }));
    const acquireSpy = vi.spyOn(lockManager, 'acquire');
    const refSpy = vi.spyOn(BranchManager.prototype, 'listLocalTaskRefs');

    await manager.reconcileTaskBranches();

    expect(refSpy).not.toHaveBeenCalled();
    expect(acquireSpy).not.toHaveBeenCalled();
  });

});
