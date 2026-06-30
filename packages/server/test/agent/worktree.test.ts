import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorktreeManager } from '../../src/agent/worktree.js';
import type { CommandRunner, ExecResult } from '../../src/agent/runner.js';

function mockRunner(): CommandRunner & { exec: ReturnType<typeof vi.fn> } {
  return {
    exec: vi.fn<(cmd: string) => Promise<ExecResult>>().mockResolvedValue({
      stdout: '', stderr: '', exitCode: 0,
    }),
  };
}

const exitOk: ExecResult = { stdout: '', stderr: '', exitCode: 0 };
const out = (stdout: string): ExecResult => ({ stdout, stderr: '', exitCode: 0 });
const fail = (stderr: string, exitCode = 1): ExecResult => ({ stdout: '', stderr, exitCode });

describe('WorktreeManager', () => {
  let runner: ReturnType<typeof mockRunner>;
  let wt: WorktreeManager;

  function queueExec(...results: ExecResult[]): void {
    for (const r of results) runner.exec.mockResolvedValueOnce(r);
  }
  const cmdAt = (n: number): string => runner.exec.mock.calls[n][0];

  beforeEach(() => {
    runner = mockRunner();
    wt = new WorktreeManager(runner);
  });

  describe('remove', () => {
    it('throws when git worktree remove exits non-zero (so callers can react)', async () => {
      runner.exec.mockResolvedValue(fail('fatal: worktree is locked'));
      await expect(wt.remove('/repo', '/repo/.baxian-worktrees/x')).rejects.toThrow(/Failed to remove worktree/);
    });

    it('resolves on exit 0', async () => {
      await expect(wt.remove('/repo', '/repo/.baxian-worktrees/x')).resolves.toBeUndefined();
      expect(cmdAt(0)).toContain('git worktree remove');
    });
  });

  describe('create', () => {
    it('without baseRef: command has no commit-ish suffix', async () => {
      await wt.create('/repo', 'task-001');
      const cmd = cmdAt(0);
      expect(cmd).toContain('git worktree add');
      expect(cmd).toContain('-B');
      expect(cmd).toContain('bx/task-001');
      expect(cmd).not.toContain('origin/HEAD');
    });

    it('with baseRef: command appends the ref at the end', async () => {
      await wt.create('/repo', 'task-001', 'origin/HEAD');
      expect(cmdAt(0)).toContain("-B 'bx/task-001' 'origin/HEAD'");
    });

    it('returns the worktree path (regardless of baseRef)', async () => {
      const path = await wt.create('/repo', 'task-001', 'origin/HEAD');
      expect(path).toMatch(/^\/repo\/\.baxian-worktrees\/task-001_[0-9a-f]{16}$/);
    });
  });

  describe('create with custom branchName', () => {
    it('checks local and remote ref before creating with -b (not -B)', async () => {
      queueExec(
        fail('', 128),
        exitOk,
        exitOk,
        exitOk,
      );
      const path = await wt.create('/repo', 'task-001', 'origin/HEAD', 'feat/my-feature');
      expect(path).toMatch(/task-001_[0-9a-f]{16}$/);
      const addCmd = cmdAt(2);
      expect(addCmd).toContain('-b');
      expect(addCmd).not.toContain('-B');
      expect(addCmd).toContain('feat/my-feature');
    });

    it('throws if local branch already exists', async () => {
      queueExec(out('abc123'));
      await expect(wt.create('/repo', 'task-001', undefined, 'feat/exists'))
        .rejects.toThrow(/already exists locally/);
    });

    it('throws if ls-remote exits non-zero (network/auth error)', async () => {
      queueExec(fail('', 128), fail('fatal: auth failed', 128));
      await expect(wt.create('/repo', 'task-001', undefined, 'feat/new'))
        .rejects.toThrow(/Failed to check remote.*auth failed/);
    });

    it('throws if remote branch already exists', async () => {
      queueExec(fail('', 128), out('abc123\trefs/heads/feat/taken'));
      await expect(wt.create('/repo', 'task-001', undefined, 'feat/taken'))
        .rejects.toThrow(/already exists on remote/);
    });

    it('uses full ref path for ls-remote so team/foo does not block foo', async () => {
      queueExec(
        fail('', 128),
        exitOk,
        exitOk,
        exitOk,
      );
      await wt.create('/repo', 'task-001', undefined, 'foo');
      expect(cmdAt(1)).toContain('refs/heads/foo');
    });
  });

  describe('adopt', () => {
    it('fetches and creates worktree with -b on happy path', async () => {
      queueExec(
        exitOk,
        exitOk,
        exitOk,
      );
      const path = await wt.adopt('/repo', 'task-001', 'feat/existing');
      expect(path).toMatch(/task-001_[0-9a-f]{16}$/);
      const addCmd = cmdAt(0);
      expect(addCmd).toContain('git fetch origin');
      expect(addCmd).toContain('git worktree add -b');
      expect(addCmd).toContain('FETCH_HEAD');
    });

    it('throws if fetch fails', async () => {
      queueExec(fail('fatal: no such ref', 128));
      await expect(wt.adopt('/repo', 'task-001', 'no-exist'))
        .rejects.toThrow(/Failed to adopt branch/);
    });

    it('rolls back worktree if set-upstream-to fails', async () => {
      queueExec(
        exitOk,
        fail('error: no upstream'),
        exitOk,
      );
      await expect(wt.adopt('/repo', 'task-001', 'feat/x'))
        .rejects.toThrow(/Failed to set upstream tracking/);
      expect(cmdAt(2)).toContain('git worktree remove');
    });

    it('handles local branch already exists with matching SHA', async () => {
      queueExec(
        fail("fatal: 'feat/x' already exists", 128),
        out('worktree /repo\nbranch refs/heads/main\n'),
        out('abc123\n'),
        out('abc123\n'),
        exitOk,
        exitOk,
        exitOk,
      );
      const path = await wt.adopt('/repo', 'task-001', 'feat/x');
      expect(path).toMatch(/task-001_[0-9a-f]{16}$/);
    });

    it('throws when local branch is checked out in another worktree', async () => {
      queueExec(
        fail("fatal: 'feat/x' already exists", 128),
        out('worktree /repo/.baxian-worktrees/other\nbranch refs/heads/feat/x\n'),
      );
      await expect(wt.adopt('/repo', 'task-001', 'feat/x'))
        .rejects.toThrow(/checked out in another worktree/);
    });

    it('throws when local and remote branches diverge', async () => {
      queueExec(
        fail("fatal: 'feat/x' already exists", 128),
        out('worktree /repo\nbranch refs/heads/main\n'),
        out('aaa111\n'),
        out('bbb222\n'),
        fail('', 1),
      );
      await expect(wt.adopt('/repo', 'task-001', 'feat/x'))
        .rejects.toThrow(/diverges from/);
    });
  });

  describe('createDetached', () => {
    it('creates detached worktree for QA review using FETCH_HEAD', async () => {
      const path = await wt.createDetached('/repo', 'task-001', 'bx/task-001');
      const cmd = cmdAt(0);
      expect(cmd).toContain('git fetch origin');
      expect(cmd).toContain('bx/task-001');
      expect(cmd).toContain('git worktree add --detach');
      expect(cmd).toContain('FETCH_HEAD');
      expect(cmd).toContain('task-001-review_');
      expect(path).toMatch(/task-001-review_[0-9a-f]{16}$/);
    });
  });

  describe('excludes .baxian/ after every successful add', () => {
    const isExcludeCmd = (cmd: string) =>
      cmd.includes('info/exclude') && cmd.includes('.baxian/');

    it('create issues the exclude command in the worktree, after the add', async () => {
      const worktreePath = await wt.create('/repo', 'task-001');
      expect(runner.exec).toHaveBeenCalledTimes(2);
      expect(isExcludeCmd(cmdAt(0))).toBe(false);
      const cmd = cmdAt(1);
      expect(isExcludeCmd(cmd)).toBe(true);
      expect(cmd).toContain(`cd '${worktreePath}'`);
      expect(cmd).toContain('git rev-parse --git-path info/exclude');
      expect(cmd).toContain("grep -qxF '.baxian/'");
    });

    it('createDetached issues the exclude command after the add', async () => {
      await wt.createDetached('/repo', 'task-001', 'bx/task-001');
      expect(runner.exec).toHaveBeenCalledTimes(2);
      expect(isExcludeCmd(cmdAt(1))).toBe(true);
    });

    it('createDetachedAtBase issues the exclude command after the add', async () => {
      await wt.createDetachedAtBase('/repo', 'task-001');
      expect(runner.exec).toHaveBeenCalledTimes(2);
      expect(isExcludeCmd(cmdAt(1))).toBe(true);
    });

    it('throws when the exclude write fails, and removes the just-created worktree', async () => {
      queueExec(exitOk, fail('permission denied'));
      await expect(wt.create('/repo', 'task-001')).rejects.toThrow(/exclude/i);
      expect(runner.exec).toHaveBeenCalledTimes(3);
      const removeCmd = cmdAt(2);
      expect(removeCmd).toContain('git worktree remove');
      expect(removeCmd).toContain('task-001_');
      expect(removeCmd).toContain('--force');
    });

    it('custom branch: exclude failure also deletes the orphaned branch ref', async () => {
      queueExec(
        fail('', 128),
        exitOk,
        exitOk,
        fail('permission denied'),
        exitOk,
        exitOk,
      );
      await expect(wt.create('/repo', 'task-001', 'origin/HEAD', 'feat/my-feature'))
        .rejects.toThrow(/exclude/i);
      const branchDeleteCmd = cmdAt(5);
      expect(branchDeleteCmd).toContain('git branch -D');
      expect(branchDeleteCmd).toContain('feat/my-feature');
    });

    it('still throws the exclude error when the cleanup remove also fails', async () => {
      queueExec(exitOk, fail('disk full'), fail('worktree is locked'));
      await expect(wt.create('/repo', 'task-001')).rejects.toThrow(/exclude/i);
    });

    it('createDetached removes the just-created worktree when exclude fails', async () => {
      queueExec(exitOk, fail('permission denied'));
      await expect(wt.createDetached('/repo', 'task-001', 'bx/task-001')).rejects.toThrow(/exclude/i);
      const removeCmd = cmdAt(2);
      expect(removeCmd).toContain('git worktree remove');
      expect(removeCmd).toContain('task-001-review_');
    });

    it('createDetachedAtBase removes the just-created worktree when exclude fails', async () => {
      queueExec(exitOk, fail('permission denied'));
      await expect(wt.createDetachedAtBase('/repo', 'task-001')).rejects.toThrow(/exclude/i);
      const removeCmd = cmdAt(2);
      expect(removeCmd).toContain('git worktree remove');
      expect(removeCmd).toContain('task-001-review_');
    });

    it('does not run the exclude command when the add itself fails', async () => {
      queueExec(fail('fatal'));
      await expect(wt.create('/repo', 'task-001')).rejects.toThrow(/Failed to create worktree/);
      expect(runner.exec).toHaveBeenCalledTimes(1);
    });
  });

  describe('removeWithBranch', () => {
    it('removes worktree then deletes branch when branchName is provided', async () => {
      await wt.removeWithBranch('/repo', '/repo/.baxian-worktrees/x', 'feat/custom');
      expect(runner.exec).toHaveBeenCalledTimes(2);
      expect(cmdAt(0)).toContain('git worktree remove');
      const branchCmd = cmdAt(1);
      expect(branchCmd).toContain('git branch -D');
      expect(branchCmd).toContain('feat/custom');
    });

    it('skips branch delete when branchName is undefined', async () => {
      await wt.removeWithBranch('/repo', '/repo/.baxian-worktrees/x');
      expect(runner.exec).toHaveBeenCalledTimes(1);
      expect(cmdAt(0)).toContain('git worktree remove');
    });
  });

  describe('remove', () => {
    it('runs git worktree remove', async () => {
      await wt.remove('/repo', '/repo/.baxian-worktrees/task-001_abcd');
      const cmd = cmdAt(0);
      expect(cmd).toContain('git worktree remove');
      expect(cmd).toContain('task-001_abcd');
      expect(cmd).toContain('--force');
    });
  });

  describe('list', () => {
    it('parses porcelain output', async () => {
      runner.exec.mockResolvedValue({
        stdout: [
          'worktree /repo', 'HEAD abc123', 'branch refs/heads/main', '',
          'worktree /repo/.baxian-worktrees/task-001_a3f8', 'HEAD def456', 'branch refs/heads/bx/task-001', '',
        ].join('\n'),
        stderr: '', exitCode: 0,
      });
      const worktrees = await wt.list('/repo');
      expect(worktrees).toEqual(['/repo', '/repo/.baxian-worktrees/task-001_a3f8']);
    });
  });
});
