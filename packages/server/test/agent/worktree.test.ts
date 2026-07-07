import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorktreeManager } from '../../src/agent/worktree.js';
import type { CommandRunner, ExecResult } from '../../src/agent/runner.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalRunner, shellQuote } from '../../src/agent/runner.js';
import { GIT_NET_ENV, NET_EXEC_TIMEOUT_MS, __setNetExecSleepForTests } from '../../src/agent/net-exec.js';
import { REVIEW_INBOX_DIR } from '../../src/shared/index.js';

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
    __setNetExecSleepForTests(async () => {});
  });

  afterEach(() => {
    __setNetExecSleepForTests();
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

    it('never sets up remote tracking — origin/HEAD must not become the branch upstream', async () => {
      await wt.create('/repo', 'task-001', 'origin/HEAD');
      expect(cmdAt(0)).toContain('--no-track');
      runner.exec.mockClear();
      queueExec(fail('', 128), exitOk, exitOk, exitOk);
      await wt.create('/repo', 'task-002', 'origin/HEAD', 'feat/custom');
      expect(cmdAt(2)).toContain('--no-track');
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
    it('fetches into the branch-scoped remote-tracking ref, then adds the worktree as separate commands', async () => {
      queueExec(
        exitOk,
        out('abc123\n'),
        exitOk,
        exitOk,
        exitOk,
      );
      const path = await wt.adopt('/repo', 'task-001', 'feat/existing');
      expect(path).toMatch(/task-001_[0-9a-f]{16}$/);
      const fetchCmd = cmdAt(0);
      expect(fetchCmd).toContain(`${GIT_NET_ENV} git fetch origin`);
      expect(fetchCmd).toContain('+refs/heads/feat/existing:refs/remotes/origin/feat/existing');
      expect(fetchCmd).not.toContain('git worktree add');
      const revParseCmd = cmdAt(1);
      expect(revParseCmd).toContain('git rev-parse --verify');
      expect(revParseCmd).toContain('refs/remotes/origin/feat/existing');
      expect(revParseCmd).not.toContain('FETCH_HEAD');
      const addCmd = cmdAt(2);
      expect(addCmd).toContain('git worktree add -b');
      expect(addCmd).toContain('abc123');
      expect(addCmd).not.toContain('git fetch');
    });

    it('throws if fetch fails', async () => {
      queueExec(fail('fatal: no such ref', 128));
      await expect(wt.adopt('/repo', 'task-001', 'no-exist'))
        .rejects.toThrow(/Failed to adopt branch/);
    });

    it('retries a transient fetch failure before adopting', async () => {
      queueExec(
        fail('fatal: unable to access: Could not resolve host: github.com', 128),
        exitOk,
        out('abc123\n'),
        exitOk,
        exitOk,
        exitOk,
      );
      const path = await wt.adopt('/repo', 'task-001', 'feat/existing');
      expect(path).toMatch(/task-001_[0-9a-f]{16}$/);
      const fetches = runner.exec.mock.calls.filter(c => (c[0] as string).includes('git fetch origin'));
      expect(fetches).toHaveLength(2);
    });

    it('rolls back worktree if set-upstream-to fails', async () => {
      queueExec(
        exitOk,
        out('abc123\n'),
        exitOk,
        fail('error: no upstream'),
        exitOk,
      );
      await expect(wt.adopt('/repo', 'task-001', 'feat/x'))
        .rejects.toThrow(/Failed to set upstream tracking/);
      expect(cmdAt(4)).toContain('git worktree remove');
    });

    it('handles local branch already exists with matching SHA', async () => {
      queueExec(
        exitOk,
        out('abc123\n'),
        fail("fatal: 'feat/x' already exists", 128),
        out('worktree /repo\nbranch refs/heads/main\n'),
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
        exitOk,
        out('abc123\n'),
        fail("fatal: 'feat/x' already exists", 128),
        out('worktree /repo/.baxian-worktrees/other\nbranch refs/heads/feat/x\n'),
      );
      await expect(wt.adopt('/repo', 'task-001', 'feat/x'))
        .rejects.toThrow(/checked out in another worktree/);
    });

    it('throws when local and remote branches diverge', async () => {
      queueExec(
        exitOk,
        out('bbb222\n'),
        fail("fatal: 'feat/x' already exists", 128),
        out('worktree /repo\nbranch refs/heads/main\n'),
        out('aaa111\n'),
        fail('', 1),
      );
      await expect(wt.adopt('/repo', 'task-001', 'feat/x'))
        .rejects.toThrow(/diverges from/);
    });
  });

  describe('createDetached', () => {
    it('fetches into the branch-scoped remote-tracking ref, then adds the detached worktree', async () => {
      queueExec(exitOk, out('abc123\n'), exitOk, exitOk);
      const path = await wt.createDetached('/repo', 'task-001', 'bx/task-001');
      const fetchCmd = cmdAt(0);
      expect(fetchCmd).toContain(`${GIT_NET_ENV} git fetch origin`);
      expect(fetchCmd).toContain('+refs/heads/bx/task-001:refs/remotes/origin/bx/task-001');
      expect(fetchCmd).not.toContain('git worktree add');
      const revParseCmd = cmdAt(1);
      expect(revParseCmd).toContain('refs/remotes/origin/bx/task-001');
      expect(revParseCmd).not.toContain('FETCH_HEAD');
      const addCmd = cmdAt(2);
      expect(addCmd).toContain('git worktree add --detach');
      expect(addCmd).toContain('abc123');
      expect(addCmd).toContain('task-001-review_');
      expect(path).toMatch(/task-001-review_[0-9a-f]{16}$/);
    });
  });

  describe('createDetachedAtBase', () => {
    it('fetches as its own command, then adds at origin/HEAD locally', async () => {
      const path = await wt.createDetachedAtBase('/repo', 'task-001');
      const fetchCmd = cmdAt(0);
      expect(fetchCmd).toContain(`${GIT_NET_ENV} git fetch origin --quiet`);
      expect(fetchCmd).not.toContain('git worktree add');
      const addCmd = cmdAt(1);
      expect(addCmd).toContain('git worktree add --detach');
      expect(addCmd).toContain('git symbolic-ref --short refs/remotes/origin/HEAD');
      expect(addCmd).not.toContain('git fetch');
      expect(path).toMatch(/task-001-review_[0-9a-f]{16}$/);
    });

    it('throws when the fetch fails without touching the worktree', async () => {
      queueExec(fail('fatal: unable to access: Failed to connect to github.com', 128));
      runner.exec.mockResolvedValue(fail('fatal: unable to access: Failed to connect to github.com', 128));
      await expect(wt.createDetachedAtBase('/repo', 'task-001'))
        .rejects.toThrow(/Failed to create base-detached worktree/);
      const cmds = runner.exec.mock.calls.map(c => c[0] as string);
      expect(cmds.some(c => c.includes('git worktree add'))).toBe(false);
    });
  });

  describe('network guardrails', () => {
    it('runs ls-remote under the network timeout with the low-speed guard', async () => {
      queueExec(fail('', 128), exitOk, exitOk, exitOk);
      await wt.create('/repo', 'task-001', undefined, 'feat/new');
      const lsRemote = runner.exec.mock.calls.find(c => (c[0] as string).includes('ls-remote'));
      expect(lsRemote).toBeDefined();
      expect(lsRemote![0]).toContain(`${GIT_NET_ENV} git ls-remote --heads origin`);
      expect((lsRemote![1] as { timeout?: number } | undefined)?.timeout).toBe(NET_EXEC_TIMEOUT_MS);
    });

    it('retries a transient ls-remote failure', async () => {
      queueExec(
        fail('', 128),
        fail('fatal: unable to access: Could not resolve host: github.com', 128),
        exitOk,
        exitOk,
        exitOk,
      );
      await wt.create('/repo', 'task-001', undefined, 'feat/new');
      const lsRemotes = runner.exec.mock.calls.filter(c => (c[0] as string).includes('ls-remote'));
      expect(lsRemotes).toHaveLength(2);
    });

    it('fetch commands carry the default network timeout', async () => {
      queueExec(exitOk, out('abc123\n'), exitOk, exitOk, exitOk);
      await wt.adopt('/repo', 'task-001', 'feat/x');
      const fetchCall = runner.exec.mock.calls.find(c => (c[0] as string).includes('git fetch origin'));
      expect((fetchCall![1] as { timeout?: number } | undefined)?.timeout).toBe(NET_EXEC_TIMEOUT_MS);
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
      queueExec(exitOk, out('abc123\n'), exitOk, exitOk);
      await wt.createDetached('/repo', 'task-001', 'bx/task-001');
      expect(runner.exec).toHaveBeenCalledTimes(4);
      expect(isExcludeCmd(cmdAt(3))).toBe(true);
    });

    it('createDetachedAtBase issues the exclude command after the add', async () => {
      await wt.createDetachedAtBase('/repo', 'task-001');
      expect(runner.exec).toHaveBeenCalledTimes(3);
      expect(isExcludeCmd(cmdAt(2))).toBe(true);
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
      queueExec(exitOk, out('abc123\n'), exitOk, fail('permission denied'));
      await expect(wt.createDetached('/repo', 'task-001', 'bx/task-001')).rejects.toThrow(/exclude/i);
      const removeCmd = cmdAt(4);
      expect(removeCmd).toContain('git worktree remove');
      expect(removeCmd).toContain('task-001-review_');
    });

    it('createDetachedAtBase removes the just-created worktree when exclude fails', async () => {
      queueExec(exitOk, exitOk, fail('permission denied'));
      await expect(wt.createDetachedAtBase('/repo', 'task-001')).rejects.toThrow(/exclude/i);
      const removeCmd = cmdAt(3);
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

describe('git safety: inbox files are invisible to git (real git)', () => {
  async function withRealGitRepo(run: (repo: string) => Promise<void>): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), 'baxian-inbox-git-'));
    try {
      const local = new LocalRunner();
      const origin = join(root, 'origin.git');
      const repo = join(root, 'repo');
      const setup = await local.exec(
        `git init -q --bare ${shellQuote(origin)} && ` +
        `git clone -q ${shellQuote(origin)} ${shellQuote(repo)} && ` +
        `cd ${shellQuote(repo)} && git config user.email t@t && git config user.name t && ` +
        `git commit --allow-empty -qm init && git push -q origin HEAD && ` +
        `b=$(git branch --show-current) && ` +
        `git update-ref "refs/remotes/origin/$b" HEAD && ` +
        `git symbolic-ref refs/remotes/origin/HEAD "refs/remotes/origin/$b"`,
      );
      expect(setup.exitCode).toBe(0);
      await run(repo);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  async function assertInboxInvisible(worktreePath: string): Promise<void> {
    const local = new LocalRunner();
    const inboxFile = `${worktreePath}/${REVIEW_INBOX_DIR}/spec-round-1.md`;
    const write = await local.exec(
      `mkdir -p ${shellQuote(`${worktreePath}/${REVIEW_INBOX_DIR}`)} && printf 'payload' > ${shellQuote(inboxFile)}`,
    );
    expect(write.exitCode).toBe(0);
    const status = await local.exec(`cd ${shellQuote(worktreePath)} && git status --porcelain`);
    expect(status.exitCode).toBe(0);
    expect(status.stdout.trim()).toBe('');
    const ignored = await local.exec(
      `cd ${shellQuote(worktreePath)} && git check-ignore ${shellQuote(`${REVIEW_INBOX_DIR}/spec-round-1.md`)}`,
    );
    expect(ignored.exitCode).toBe(0);
  }

  it('create: an inbox file never appears in git status and is check-ignore matched', () =>
    withRealGitRepo(async (repo) => {
      const wt = new WorktreeManager(new LocalRunner());
      await assertInboxInvisible(await wt.create(repo, 'task-gs1'));
    }), 20_000);

  it('createDetachedAtBase: an inbox file never appears in git status and is check-ignore matched', () =>
    withRealGitRepo(async (repo) => {
      const wt = new WorktreeManager(new LocalRunner());
      await assertInboxInvisible(await wt.createDetachedAtBase(repo, 'task-gs2'));
    }), 20_000);
});

describe('bare repo store: worktrees isolate agents from the shared clone (real git)', () => {
  async function withBareStore(run: (store: string) => Promise<void>): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), 'baxian-bare-store-'));
    try {
      const local = new LocalRunner();
      const origin = join(root, 'origin.git');
      const seed = join(root, 'seed');
      const store = join(root, 'store');
      const setup = await local.exec(
        `git init -q --bare ${shellQuote(origin)} && ` +
        `git clone -q ${shellQuote(origin)} ${shellQuote(seed)} && ` +
        `cd ${shellQuote(seed)} && git config user.email t@t && git config user.name t && ` +
        `git commit --allow-empty -qm init && git push -q origin HEAD && ` +
        `git clone --bare -q ${shellQuote(origin)} ${shellQuote(store)} && ` +
        `git -C ${shellQuote(store)} config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*' && ` +
        `git -C ${shellQuote(store)} fetch -q --all --prune && ` +
        `git -C ${shellQuote(store)} remote set-head origin --auto`,
      );
      expect(setup.exitCode).toBe(0);
      await run(store);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it('create() on a bare store yields a commit-ready worktree branched from origin/HEAD', () =>
    withBareStore(async (store) => {
      const wt = new WorktreeManager(new LocalRunner());
      const path = await wt.create(store, 'task-bare1', 'origin/HEAD');
      const local = new LocalRunner();
      const branch = await local.exec(`cd ${shellQuote(path)} && git branch --show-current`);
      expect(branch.stdout.trim()).toBe('bx/task-bare1');
      const commit = await local.exec(
        `cd ${shellQuote(path)} && git -c user.email=t@t -c user.name=t commit --allow-empty -qm work`,
      );
      expect(commit.exitCode).toBe(0);
      const upstream = await local.exec(
        `cd ${shellQuote(path)} && git rev-parse --abbrev-ref @{u}`,
      );
      expect(upstream.exitCode).not.toBe(0);
    }), 20_000);

  it('createDetachedAtBase() works against a bare store', () =>
    withBareStore(async (store) => {
      const wt = new WorktreeManager(new LocalRunner());
      const path = await wt.createDetachedAtBase(store, 'task-bare2');
      const local = new LocalRunner();
      const head = await local.exec(`cd ${shellQuote(path)} && git rev-parse HEAD`);
      expect(head.exitCode).toBe(0);
    }), 20_000);

  it('the bare store itself refuses commits and checkouts — nothing for a stray agent to contaminate', () =>
    withBareStore(async (store) => {
      const local = new LocalRunner();
      const commit = await local.exec(
        `cd ${shellQuote(store)} && git -c user.email=t@t -c user.name=t commit --allow-empty -m stray`,
      );
      expect(commit.exitCode).not.toBe(0);
      expect(commit.stderr).toMatch(/work tree|working tree/i);
      const checkout = await local.exec(`cd ${shellQuote(store)} && git checkout -b stray-branch`);
      expect(checkout.exitCode).not.toBe(0);
    }), 20_000);
});

describe('concurrent fetch isolation: adopt pins the requested branch tip (real git)', () => {
  it('a rival fetch landing between fetch and rev-parse cannot redirect the adopted worktree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'baxian-interleave-'));
    try {
      const local = new LocalRunner();
      const origin = join(root, 'origin.git');
      const seed = join(root, 'seed');
      const store = join(root, 'store');
      const setup = await local.exec(
        `git init -q --bare ${shellQuote(origin)} && ` +
        `git clone -q ${shellQuote(origin)} ${shellQuote(seed)} && ` +
        `cd ${shellQuote(seed)} && git config user.email t@t && git config user.name t && ` +
        `git commit --allow-empty -qm init && git push -q origin HEAD && ` +
        `git checkout -qb feat-a && git commit --allow-empty -qm a && git push -q origin feat-a && ` +
        `git checkout -qb feat-b && git commit --allow-empty -qm b && git push -q origin feat-b && ` +
        `git clone --bare -q ${shellQuote(origin)} ${shellQuote(store)} && ` +
        `git -C ${shellQuote(store)} config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'`,
      );
      expect(setup.exitCode).toBe(0);

      const rivalFetch = `cd ${shellQuote(store)} && git fetch -q origin -- feat-b`;
      const interleaving: CommandRunner = {
        exec: async (cmd, opts) => {
          const result = await local.exec(cmd, opts);
          if (cmd.includes('git fetch') && cmd.includes('feat-a')) {
            const rival = await local.exec(rivalFetch);
            expect(rival.exitCode).toBe(0);
          }
          return result;
        },
        writeFile: (path, content) => local.writeFile(path, content),
        execWithStdin: (cmd, stdin, opts) => local.execWithStdin(cmd, stdin, opts),
      };

      const wt = new WorktreeManager(interleaving);
      const worktreePath = await wt.adopt(store, 'task-ia', 'feat-a');

      const headSha = (await local.exec(`cd ${shellQuote(worktreePath)} && git rev-parse HEAD`)).stdout.trim();
      const expected = (await local.exec(`cd ${shellQuote(seed)} && git rev-parse feat-a`)).stdout.trim();
      expect(headSha).toBe(expected);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});
