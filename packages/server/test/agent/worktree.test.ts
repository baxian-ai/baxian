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

describe('WorktreeManager', () => {
  let runner: ReturnType<typeof mockRunner>;
  let wt: WorktreeManager;

  beforeEach(() => {
    runner = mockRunner();
    wt = new WorktreeManager(runner);
  });

  describe('remove', () => {
    it('throws when git worktree remove exits non-zero (so callers can react)', async () => {
      runner.exec.mockResolvedValue({ stdout: '', stderr: 'fatal: worktree is locked', exitCode: 1 });
      await expect(wt.remove('/repo', '/repo/.baxian-worktrees/x')).rejects.toThrow(/Failed to remove worktree/);
    });

    it('resolves on exit 0', async () => {
      await expect(wt.remove('/repo', '/repo/.baxian-worktrees/x')).resolves.toBeUndefined();
      expect(runner.exec.mock.calls[0][0]).toContain('git worktree remove');
    });
  });

  describe('create', () => {
    it('without baseRef: command has no commit-ish suffix', async () => {
      await wt.create('/repo', 'task-001');
      const cmd = runner.exec.mock.calls[0][0];
      expect(cmd).toContain('git worktree add');
      expect(cmd).toContain('-B');
      expect(cmd).toContain('bx/task-001');
      expect(cmd).not.toContain('origin/HEAD');
    });

    it('with baseRef: command appends the ref at the end', async () => {
      await wt.create('/repo', 'task-001', 'origin/HEAD');
      const cmd = runner.exec.mock.calls[0][0];
      expect(cmd).toContain("-B 'bx/task-001' 'origin/HEAD'");
    });

    it('returns the worktree path (regardless of baseRef)', async () => {
      const path = await wt.create('/repo', 'task-001', 'origin/HEAD');
      expect(path).toMatch(/^\/repo\/\.baxian-worktrees\/task-001_[0-9a-f]{16}$/);
    });
  });

  describe('createDetached', () => {
    it('creates detached worktree for QA review using FETCH_HEAD', async () => {
      const path = await wt.createDetached('/repo', 'task-001', 'bx/task-001');
      const cmd = runner.exec.mock.calls[0][0];
      expect(cmd).toContain('git fetch origin');
      expect(cmd).toContain('bx/task-001');
      expect(cmd).toContain('git worktree add --detach');
      expect(cmd).toContain('FETCH_HEAD');
      expect(cmd).toContain('task-001-review_');
      expect(path).toMatch(/task-001-review_[0-9a-f]{16}$/);
    });
  });

  describe('excludes .baxian/ after every successful add', () => {
    // The exclude command runs as a SECOND exec, after the add (calls[0]) succeeds.
    const isExcludeCmd = (cmd: string) =>
      cmd.includes('info/exclude') && cmd.includes('.baxian/');

    it('create issues the exclude command in the worktree, after the add', async () => {
      const worktreePath = await wt.create('/repo', 'task-001');
      expect(runner.exec).toHaveBeenCalledTimes(2);
      expect(isExcludeCmd(runner.exec.mock.calls[0][0])).toBe(false);
      const cmd = runner.exec.mock.calls[1][0];
      expect(isExcludeCmd(cmd)).toBe(true);
      expect(cmd).toContain(`cd '${worktreePath}'`);
      expect(cmd).toContain('git rev-parse --git-path info/exclude');
      expect(cmd).toContain("grep -qxF '.baxian/'");
    });

    it('createDetached issues the exclude command after the add', async () => {
      await wt.createDetached('/repo', 'task-001', 'bx/task-001');
      expect(runner.exec).toHaveBeenCalledTimes(2);
      expect(isExcludeCmd(runner.exec.mock.calls[1][0])).toBe(true);
    });

    it('createDetachedAtBase issues the exclude command after the add', async () => {
      await wt.createDetachedAtBase('/repo', 'task-001');
      expect(runner.exec).toHaveBeenCalledTimes(2);
      expect(isExcludeCmd(runner.exec.mock.calls[1][0])).toBe(true);
    });

    it('throws when the exclude write fails, and removes the just-created worktree', async () => {
      // First exec (add) succeeds; second exec (exclude) is a real failure.
      runner.exec
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
        .mockResolvedValueOnce({ stdout: '', stderr: 'permission denied', exitCode: 1 });
      await expect(wt.create('/repo', 'task-001')).rejects.toThrow(/exclude/i);
      expect(runner.exec).toHaveBeenCalledTimes(3);
      const removeCmd = runner.exec.mock.calls[2][0];
      expect(removeCmd).toContain('git worktree remove');
      expect(removeCmd).toContain('task-001_');
      expect(removeCmd).toContain('--force');
    });

    it('still throws the exclude error when the cleanup remove also fails', async () => {
      runner.exec
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
        .mockResolvedValueOnce({ stdout: '', stderr: 'disk full', exitCode: 1 })
        .mockResolvedValueOnce({ stdout: '', stderr: 'worktree is locked', exitCode: 1 });
      await expect(wt.create('/repo', 'task-001')).rejects.toThrow(/exclude/i);
    });

    it('createDetached removes the just-created worktree when exclude fails', async () => {
      runner.exec
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
        .mockResolvedValueOnce({ stdout: '', stderr: 'permission denied', exitCode: 1 });
      await expect(wt.createDetached('/repo', 'task-001', 'bx/task-001')).rejects.toThrow(/exclude/i);
      const removeCmd = runner.exec.mock.calls[2][0];
      expect(removeCmd).toContain('git worktree remove');
      expect(removeCmd).toContain('task-001-review_');
    });

    it('createDetachedAtBase removes the just-created worktree when exclude fails', async () => {
      runner.exec
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
        .mockResolvedValueOnce({ stdout: '', stderr: 'permission denied', exitCode: 1 });
      await expect(wt.createDetachedAtBase('/repo', 'task-001')).rejects.toThrow(/exclude/i);
      const removeCmd = runner.exec.mock.calls[2][0];
      expect(removeCmd).toContain('git worktree remove');
      expect(removeCmd).toContain('task-001-review_');
    });

    it('does not run the exclude command when the add itself fails', async () => {
      runner.exec.mockResolvedValueOnce({ stdout: '', stderr: 'fatal', exitCode: 1 });
      await expect(wt.create('/repo', 'task-001')).rejects.toThrow(/Failed to create worktree/);
      expect(runner.exec).toHaveBeenCalledTimes(1);
    });
  });

  describe('remove', () => {
    it('runs git worktree remove', async () => {
      await wt.remove('/repo', '/repo/.baxian-worktrees/task-001_abcd');
      const cmd = runner.exec.mock.calls[0][0];
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
