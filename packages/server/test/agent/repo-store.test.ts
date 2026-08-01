import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RepoStore,
  accessMethodDiffers,
  createRepoStoreCache,
  ensureBaxianRuntimeDirsSafe,
  moveFileIntoPlace,
  stageFile,
  sweepStrayFile,
  trashBatchDir,
} from '../../src/agent/repo-store.js';
import { ExecOutcomeUnknownError } from '../../src/agent/net-exec.js';
import { LocalRunner, shellQuote, type CommandRunner, type ExecOptions, type ExecResult } from '../../src/agent/runner.js';

const PROJECT_REPO = 'https://github.com/group/project.git';
const local = new LocalRunner();
const testTrash = (home: string): string => trashBatchDir(home, 'test-agent', 'test');
let tempDir: string;
let origin: string;

async function run(command: string): Promise<string> {
  const result = await local.exec(command);
  if (result.exitCode !== 0) throw new Error(`${command}: ${result.stderr}`);
  return result.stdout.trim();
}

class TestRunner implements CommandRunner {
  readonly commands: string[] = [];
  failFetch = false;
  failOriginHead = false;
  emptyRemoteRefs = false;

  constructor(
    private home: string,
    private cloneSource: string,
    private cloneOrigin = PROJECT_REPO,
  ) {}

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    this.commands.push(command);
    if (command === 'printf %s "$HOME"') {
      return { stdout: this.home, stderr: '', exitCode: 0 };
    }
    if (command.includes('git fetch --all --prune')) {
      if (this.failOriginHead) {
        return { stdout: '', stderr: 'cannot determine remote HEAD', exitCode: 1 };
      }
      return this.failFetch
        ? { stdout: '', stderr: 'network down', exitCode: 1 }
        : { stdout: '', stderr: '', exitCode: 0 };
    }
    if (this.emptyRemoteRefs && command.includes('for-each-ref') && command.includes('refs/remotes/')) {
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    const cloneTarget = command.match(/git clone (?:'[^']+'|\S+) '([^']+)'/)?.[1];
    if (cloneTarget) {
      const cloned = await local.exec(
        `git clone -q ${shellQuote(this.cloneSource)} ${shellQuote(cloneTarget)} && ` +
        `git -C ${shellQuote(cloneTarget)} remote set-url origin ${shellQuote(this.cloneOrigin)}`,
        options,
      );
      return cloned;
    }
    return local.exec(command, options);
  }

  writeFile(path: string, content: Buffer | string): Promise<void> {
    return local.writeFile(path, content);
  }

  execWithStdin(command: string, stdin: Buffer, options?: ExecOptions): Promise<ExecResult> {
    return local.execWithStdin(command, stdin, options);
  }
}

async function cloneAt(path: string, remote = PROJECT_REPO): Promise<void> {
  await run(
    `git clone -q ${shellQuote(origin)} ${shellQuote(path)} && ` +
    `git -C ${shellQuote(path)} remote set-url origin ${shellQuote(remote)}`,
  );
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-repo-store-'));
  origin = join(tempDir, 'origin.git');
  const seed = join(tempDir, 'seed');
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
    `git -C ${shellQuote(seed)} push -q origin main && ` +
    `git -C ${shellQuote(origin)} symbolic-ref HEAD refs/heads/main`,
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tempDir, { recursive: true, force: true });
});

describe('RepoStore per-agent Workdir', () => {
  it('auto-creates an ordinary clone at ~/.baxian/agents/<agentId>/repo', async () => {
    const home = join(tempDir, 'home');
    await run(`mkdir -p ${shellQuote(home)}`);
    const canonicalHome = await run(`cd ${shellQuote(home)} && pwd -P`);
    const runner = new TestRunner(home, origin);
    const store = new RepoStore(
      runner,
      PROJECT_REPO,
      'remote',
      { hostname: 'box-a' },
      createRepoStoreCache(),
      'dev-1',
    );

    const path = await store.ensure();

    expect(path).toBe(join(canonicalHome, '.baxian/agents/dev-1/repo'));
    expect(await run(`git -C ${shellQuote(path)} rev-parse --is-bare-repository`)).toBe('false');
    expect(await run(`git -C ${shellQuote(path)} rev-parse --show-toplevel`)).toBe(path);
    expect(runner.commands.some(command => command.includes('--bare'))).toBe(false);
  });

  it('gives two agents independent clones, branches, and object databases', async () => {
    const home = join(tempDir, 'home');
    await run(`mkdir -p ${shellQuote(home)}`);
    const cache = createRepoStoreCache();
    const runner = new TestRunner(home, origin);
    const dev = new RepoStore(runner, PROJECT_REPO, 'remote', { hostname: 'box-a' }, cache, 'dev-1');
    const qa = new RepoStore(runner, PROJECT_REPO, 'remote', { hostname: 'box-a' }, cache, 'qa-1');

    const [devPath, qaPath] = await Promise.all([dev.ensure(), qa.ensure()]);

    expect(devPath).not.toBe(qaPath);
    expect(await run(`git -C ${shellQuote(devPath)} rev-parse --absolute-git-dir`)).not.toBe(
      await run(`git -C ${shellQuote(qaPath)} rev-parse --absolute-git-dir`),
    );
  });

  it('adopts an existing custom Workdir only when it is the exact ordinary clone root', async () => {
    const path = join(tempDir, 'custom');
    await cloneAt(path);
    const store = new RepoStore(
      new TestRunner(tempDir, origin),
      PROJECT_REPO,
      'local',
      undefined,
      createRepoStoreCache(),
      'dev-1',
      path,
    );

    await expect(store.ensure()).resolves.toBe(await run(`cd ${shellQuote(path)} && pwd -P`));
  });

  it('creates the baxian runtime directory', async () => {
    const path = join(tempDir, 'custom-runtime-dirs');
    await cloneAt(path);
    const store = new RepoStore(
      new TestRunner(tempDir, origin), PROJECT_REPO, 'local', undefined,
      createRepoStoreCache(), 'dev-1', path,
    );

    await store.ensure();

    const stat = await lstat(join(path, '.baxian'));
    expect(stat.isDirectory()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);

    await mkdir(join(path, 'sub'), { recursive: true });
    await writeFile(join(path, 'sub', '.baxian'), 'user file');
    expect((await local.exec(`cd ${shellQuote(path)} && git check-ignore -q -- .baxian`)).exitCode).toBe(0);
    expect((await local.exec(`cd ${shellQuote(path)} && git check-ignore -q -- sub/.baxian`)).exitCode).toBe(1);
  });

  it('accepts a user-planted symlink runtime directory and keeps the link', async () => {
    const path = join(tempDir, 'custom-symlink-runtime');
    const outside = join(tempDir, 'outside-runtime');
    await cloneAt(path);
    await run(`mkdir -p ${shellQuote(outside)}`);
    await symlink(outside, join(path, '.baxian'));
    const store = new RepoStore(
      new TestRunner(tempDir, origin), PROJECT_REPO, 'local', undefined,
      createRepoStoreCache(), 'dev-1', path,
    );

    await store.ensure();

    expect((await lstat(join(path, '.baxian'))).isSymbolicLink()).toBe(true);
  });

  it('fails fast instead of creating a missing custom Workdir', async () => {
    const path = join(tempDir, 'missing');
    const store = new RepoStore(
      new TestRunner(tempDir, origin), PROJECT_REPO, 'local', undefined,
      createRepoStoreCache(), 'dev-1', path,
    );

    await expect(store.ensure()).rejects.toThrow(/never creates a user-specified Workdir/i);
    await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a repository subdirectory and a bare repository', async () => {
    const path = join(tempDir, 'custom');
    await cloneAt(path);
    await run(`mkdir -p ${shellQuote(join(path, 'subdir'))}`);
    const cache = createRepoStoreCache();
    const subdir = new RepoStore(
      new TestRunner(tempDir, origin), PROJECT_REPO, 'local', undefined,
      cache, 'dev-1', join(path, 'subdir'),
    );
    const bare = new RepoStore(
      new TestRunner(tempDir, origin), PROJECT_REPO, 'local', undefined,
      cache, 'qa-1', origin,
    );

    await expect(subdir.ensure()).rejects.toThrow(/exact top-level/i);
    await expect(bare.ensure()).rejects.toThrow(/non-bare/i);
  });

  it('rejects linked worktrees and clones that share objects through alternates', async () => {
    const clone = join(tempDir, 'clone');
    const linked = join(tempDir, 'linked');
    const alternate = join(tempDir, 'alternate');
    await cloneAt(clone);
    await run(`git -C ${shellQuote(clone)} worktree add -q -b linked-test ${shellQuote(linked)}`);
    await cloneAt(alternate);
    await run(
      `mkdir -p ${shellQuote(join(alternate, '.git/objects/info'))} && ` +
      `printf '%s\n' ${shellQuote(join(clone, '.git/objects'))} > ` +
      `${shellQuote(join(alternate, '.git/objects/info/alternates'))}`,
    );

    const linkedStore = new RepoStore(
      new TestRunner(tempDir, origin), PROJECT_REPO, 'local', undefined,
      createRepoStoreCache(), 'dev-1', linked,
    );
    const alternateStore = new RepoStore(
      new TestRunner(tempDir, origin), PROJECT_REPO, 'local', undefined,
      createRepoStoreCache(), 'qa-1', alternate,
    );

    await expect(linkedStore.ensure()).rejects.toThrow(/independent ordinary clone/i);
    await expect(alternateStore.ensure()).rejects.toThrow(/independent ordinary clone/i);
  });

  it.each([
    ['remote.origin.promisor', 'true'],
    ['remote.origin.partialclonefilter', 'blob:none'],
  ])('rejects a partial/promisor clone marked by %s', async (key, value) => {
    const path = join(tempDir, `partial-${key.replaceAll('.', '-')}`);
    await cloneAt(path);
    await run(`git -C ${shellQuote(path)} config ${shellQuote(key)} ${shellQuote(value)}`);
    const store = new RepoStore(
      new TestRunner(tempDir, origin), PROJECT_REPO, 'local', undefined,
      createRepoStoreCache(), 'dev-1', path,
    );

    await expect(store.ensure()).rejects.toThrow(/partial\/promisor clone/i);
  });

  it('rejects an origin that does not match the project repository', async () => {
    const path = join(tempDir, 'wrong-origin');
    await cloneAt(path, 'https://github.com/other/project.git');
    const store = new RepoStore(
      new TestRunner(tempDir, origin), PROJECT_REPO, 'local', undefined,
      createRepoStoreCache(), 'dev-1', path,
    );

    await expect(store.ensure()).rejects.toThrow(/does not match project\.repo/i);
  });

  it('validates but does not rewrite the origin access method in a user-specified Workdir', async () => {
    const path = join(tempDir, 'custom-ssh-origin');
    const sshOrigin = 'git@github.com:group/project.git';
    await cloneAt(path, sshOrigin);
    const store = new RepoStore(
      new TestRunner(tempDir, origin), PROJECT_REPO, 'local', undefined,
      createRepoStoreCache(), 'dev-1', path,
    );

    await store.ensure();

    expect(await run(`git -C ${shellQuote(path)} remote get-url origin`)).toBe(sshOrigin);
  });

  it('rejects two agents that resolve to the same canonical path on one host', async () => {
    const path = join(tempDir, 'custom');
    const alias = join(tempDir, 'custom-link');
    await cloneAt(path);
    await symlink(path, alias);
    const cache = createRepoStoreCache();
    const runner = new TestRunner(tempDir, origin);
    const first = new RepoStore(runner, PROJECT_REPO, 'local', undefined, cache, 'dev-1', path);
    const second = new RepoStore(runner, PROJECT_REPO, 'local', undefined, cache, 'qa-1', alias);

    await first.ensure();
    await expect(second.ensure()).rejects.toThrow(/already owned by agent "dev-1"/i);
  });

  it('atomically rejects concurrent agents that resolve to the same canonical path', async () => {
    const path = join(tempDir, 'concurrent-custom');
    const alias = join(tempDir, 'concurrent-link');
    await cloneAt(path);
    await symlink(path, alias);
    const cache = createRepoStoreCache();
    const runner = new TestRunner(tempDir, origin);
    const first = new RepoStore(runner, PROJECT_REPO, 'local', undefined, cache, 'dev-1', path);
    const second = new RepoStore(runner, PROJECT_REPO, 'local', undefined, cache, 'qa-1', alias);

    const results = await Promise.allSettled([first.ensure(), second.ensure()]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(String(rejected.reason)).toMatch(/already owned by agent/i);
  });

  it('does not confuse the same path text on different hosts', async () => {
    const path = join(tempDir, 'custom');
    await cloneAt(path);
    const cache = createRepoStoreCache();
    const runner = new TestRunner(tempDir, origin);
    const first = new RepoStore(runner, PROJECT_REPO, 'remote', { hostname: 'box-a' }, cache, 'dev-1', path);
    const second = new RepoStore(runner, PROJECT_REPO, 'remote', { hostname: 'box-b' }, cache, 'qa-1', path);

    const canonical = await run(`cd ${shellQuote(path)} && pwd -P`);
    await expect(first.ensure()).resolves.toBe(canonical);
    await expect(second.ensure()).resolves.toBe(canonical);
  });

  it('treats omitted and explicit default SSH ports as one Workdir owner scope', async () => {
    const path = join(tempDir, 'same-default-port');
    await cloneAt(path);
    const cache = createRepoStoreCache();
    const runner = new TestRunner(tempDir, origin);
    const first = new RepoStore(
      runner, PROJECT_REPO, 'remote', { hostname: 'box-a', user: 'git' },
      cache, 'dev-1', path,
    );
    const second = new RepoStore(
      runner, PROJECT_REPO, 'remote', { hostname: 'box-a', user: 'git', port: 22 },
      cache, 'qa-1', path,
    );

    await first.ensure();
    await expect(second.ensure()).rejects.toThrow(/already owned by agent "dev-1"/i);
  });

  it('surfaces fetch failures and does not cache a successful refresh', async () => {
    const path = join(tempDir, 'custom');
    await cloneAt(path);
    const runner = new TestRunner(tempDir, origin);
    runner.failFetch = true;
    const store = new RepoStore(
      runner, PROJECT_REPO, 'local', undefined, createRepoStoreCache(), 'dev-1', path,
    );

    await expect(store.ensure()).rejects.toThrow(/git fetch failed/i);
  });

  it('fails when origin/HEAD cannot be refreshed instead of hiding the warning', async () => {
    const path = join(tempDir, 'custom');
    await cloneAt(path);
    const runner = new TestRunner(tempDir, origin);
    runner.failOriginHead = true;
    const store = new RepoStore(
      runner, PROJECT_REPO, 'local', undefined, createRepoStoreCache(), 'dev-1', path,
    );

    await expect(store.ensure()).rejects.toThrow(/origin\/HEAD could not be refreshed/i);
  });

  it('rejects a clone whose remote-tracking ref listing succeeds but is empty', async () => {
    const path = join(tempDir, 'custom');
    await cloneAt(path);
    const runner = new TestRunner(tempDir, origin);
    runner.emptyRemoteRefs = true;
    const store = new RepoStore(
      runner, PROJECT_REPO, 'local', undefined, createRepoStoreCache(), 'dev-1', path,
    );

    await expect(store.ensure()).rejects.toThrow(/no readable remote-tracking refs/i);
  });

  it('auto clone uses the configured URL with ordinary git', async () => {
    const home = join(tempDir, 'home');
    await run(`mkdir -p ${shellQuote(home)}`);
    const runner = new TestRunner(home, origin, 'https://github.com/owner/repo.git');
    const store = new RepoStore(
      runner, 'https://github.com/owner/repo.git', 'remote', { hostname: 'box-a' },
      createRepoStoreCache(), 'dev-1',
    );

    await store.ensure();

    const clone = runner.commands.find(command => command.includes('git clone'));
    expect(clone).toContain("git clone 'https://github.com/owner/repo.git'");
    expect(clone).not.toContain('--bare');
  });
});

describe('accessMethodDiffers', () => {
  it('distinguishes HTTPS and SSH while treating equivalent SSH forms alike', () => {
    expect(accessMethodDiffers('https://github.com/g/p.git', 'git@github.com:g/p.git')).toBe(true);
    expect(accessMethodDiffers('ssh://git@github.com/g/p.git', 'git@github.com:g/p.git')).toBe(false);
  });
});

type ScriptedResult = ExecResult | ExecResult[] | ((command: string) => ExecResult);

class ScriptedRunner implements CommandRunner {
  readonly commands: string[] = [];
  private queues = new Map<RegExp, ExecResult[]>();

  constructor(
    private home: string,
    private rules: Array<[RegExp, ScriptedResult]>,
  ) {}

  async exec(command: string): Promise<ExecResult> {
    this.commands.push(command);
    if (command === 'printf %s "$HOME"' || command === `cd ${shellQuote(this.home)} && pwd -P`) {
      return { stdout: this.home, stderr: '', exitCode: 0 };
    }
    for (const [pattern, result] of this.rules) {
      if (!pattern.test(command)) continue;
      if (typeof result === 'function') return result(command);
      if (!Array.isArray(result)) return result;
      let queue = this.queues.get(pattern);
      if (!queue) {
        queue = [...result];
        this.queues.set(pattern, queue);
      }
      return queue.length > 1 ? queue.shift()! : queue[0];
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  writeFile(): Promise<void> {
    return Promise.resolve();
  }

  execWithStdin(): Promise<ExecResult> {
    return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
  }
}

const ok: ExecResult = { stdout: '', stderr: '', exitCode: 0 };

function scriptedStore(runner: ScriptedRunner): RepoStore {
  return new RepoStore(
    runner, PROJECT_REPO, 'remote', { hostname: 'box-a' },
    createRepoStoreCache(), 'dev-1',
  );
}

function expectTrashMove(cmd: string | undefined, srcPattern: string): void {
  expect(cmd).toBeDefined();
  expect(cmd!).toMatch(new RegExp(`t='/home/u/\\.baxian/agents/dev-1/\\.baxian-trash/[^']+'/"\\$base"`));
  expect(cmd!).toMatch(new RegExp(`mv -- '${srcPattern}' "\\$t" && printf '%s' BX_TRASHED; else false; fi`));
}

describe('RepoStore destructive-cleanup guards', () => {
  it('aborts ensure when the existence probe fails at the exec layer, without cloning or removing', async () => {
    const runner = new ScriptedRunner('/home/u', [
      [/^test -d /, { stdout: '', stderr: 'Connection timed out during banner exchange', exitCode: 255 }],
    ]);

    await expect(scriptedStore(runner).ensure()).rejects.toThrow(/Cannot probe workdir/);

    expect(runner.commands.some(c => c.includes('clone'))).toBe(false);
    expect(runner.commands.some(c => c.includes('mv -- '))).toBe(false);
  });

  it('clones into a unique staging name and only ever trashes that name on failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runner = new ScriptedRunner('/home/u', [
      [/^test -d /, { stdout: '', stderr: '', exitCode: 1 }],
      [/mkdir -p /, ok],
      [/git clone /, { stdout: '', stderr: 'fatal: unable to access remote', exitCode: 128 }],
      [/rmdir /, ok],
    ]);

    await expect(scriptedStore(runner).ensure()).rejects.toThrow(/git clone .* failed/);

    const final = '/home/u/.baxian/agents/dev-1/repo';
    const cloneCmd = runner.commands.find(c => c.includes('git clone '));
    expect(cloneCmd).toMatch(/repo\.claim-[0-9a-f-]+'/);
    expect(cloneCmd).not.toContain(`${final}'`);
    const removal = runner.commands.find(c => /mv -- '[^']*\/repo\.claim-/.test(c));
    expectTrashMove(removal, `${final}\\.claim-[0-9a-f-]+`);
    expect(runner.commands.some(c => c.includes('rmdir '))).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('trashing staged clone'));
  });

  it('stops before promote when the claim write returns exit 0 with transient output', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runner = new ScriptedRunner('/home/u', [
      [/^test -d /, { stdout: '', stderr: '', exitCode: 1 }],
      [/baxian-promote-claim'$/, { stdout: '', stderr: 'ssh: connect to host box-a port 22: Connection timed out', exitCode: 0 }],
      [/mkdir -p /, ok],
      [/git clone /, ok],
    ]);

    await expect(scriptedStore(runner).ensure()).rejects.toThrow(/Promote-claim write .* outcome unknown/);

    expect(runner.commands.some(c => c.includes('&& mv '))).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('trashing staged clone'));
    warn.mockRestore();
  });

  it('treats a transient .baxian exclude reply as outcome unknown, not success', async () => {
    const phys = '/home/u/.baxian/agents/dev-1/repo';
    const runner = new ScriptedRunner('/home/u', [
      [/^test -d /, ok],
      [/rev-parse --show-toplevel/, { stdout: `${phys}\n`, stderr: '', exitCode: 0 }],
      [/^cd '\/home\/u\/\.baxian\/agents\/dev-1\/repo' && pwd -P$/, { stdout: `${phys}\n`, stderr: '', exitCode: 0 }],
      [/--is-bare-repository/, { stdout: 'false\n', stderr: '', exitCode: 0 }],
      [/remote get-url origin/, { stdout: `${PROJECT_REPO}\n`, stderr: '', exitCode: 0 }],
      [/config --get-regexp /, { stdout: '', stderr: '', exitCode: 1 }],
      [/for-each-ref/, { stdout: 'refs/remotes/origin/main\n', stderr: '', exitCode: 0 }],
      [/check-ignore/, { stdout: '', stderr: 'Connection reset by peer', exitCode: 0 }],
    ]);

    await expect(scriptedStore(runner).ensure()).rejects.toThrow(/exclude probe .* outcome unknown/);
  });

  it('flags a transient trash reply as outcome UNKNOWN even with exit 0 and marker', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runner = new ScriptedRunner('/home/u', [
      [/^test -d /, { stdout: '', stderr: '', exitCode: 1 }],
      [/BX_TRASH_ABSENT/, { stdout: 'BX_TRASHED', stderr: 'Connection reset by peer', exitCode: 0 }],
      [/mkdir -p /, ok],
      [/git clone /, { stdout: '', stderr: 'fatal: unable to access remote', exitCode: 128 }],
    ]);

    await expect(scriptedStore(runner).ensure()).rejects.toThrow(/git clone .* failed/);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('trash outcome UNKNOWN'));
    warn.mockRestore();
  });

  it('accepts an auto Workdir routed through a symlinked agents tree (physical top equals physical workdir)', async () => {
    const phys = '/data/agents-store/dev-1/repo';
    const runner = new ScriptedRunner('/home/u', [
      [/^test -d /, ok],
      [/rev-parse --show-toplevel/, { stdout: `${phys}\n`, stderr: '', exitCode: 0 }],
      [/^cd '\/data\/agents-store\/dev-1\/repo' && pwd -P$/, { stdout: `${phys}\n`, stderr: '', exitCode: 0 }],
      [/^cd '\/home\/u\/\.baxian\/agents\/dev-1\/repo' && pwd -P$/, { stdout: `${phys}\n`, stderr: '', exitCode: 0 }],
      [/--is-bare-repository/, { stdout: 'false\n', stderr: '', exitCode: 0 }],
      [/remote get-url origin/, { stdout: `${PROJECT_REPO}\n`, stderr: '', exitCode: 0 }],
      [/config --get-regexp /, { stdout: '', stderr: '', exitCode: 1 }],
      [/for-each-ref/, { stdout: 'refs/remotes/origin/main\n', stderr: '', exitCode: 0 }],
    ]);

    await expect(scriptedStore(runner).ensure()).resolves.toBe('/home/u/.baxian/agents/dev-1/repo');
  });

  it('withdraws only the staging when the promote guard fails before mv (no precheck marker)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runner = new ScriptedRunner('/home/u', [
      [/^test -d /, { stdout: '', stderr: '', exitCode: 1 }],
      [/mkdir -p /, ok],
      [/git clone /, ok],
      [/baxian-promote-claim'$/, ok],
      [/&& mv '/, { stdout: '', stderr: 'guard: final path exists', exitCode: 1 }],
    ]);

    await expect(scriptedStore(runner).ensure()).rejects.toThrow(/Cannot promote staged clone/);

    const removal = runner.commands.find(c => /mv -- '[^']*\/repo\.claim-/.test(c));
    expectTrashMove(removal, `/home/u/\\.baxian/agents/dev-1/repo\\.claim-[0-9a-f-]+`);
    expect(runner.commands.some(c => /mv -- '[^']*\/repo\/repo\.claim-/.test(c))).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('trashing staged clone'));
  });

  it('trashes both staging homes when mv provably started and then failed (precheck marker present)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runner = new ScriptedRunner('/home/u', [
      [/^test -d /, { stdout: '', stderr: '', exitCode: 1 }],
      [/mkdir -p /, ok],
      [/git clone /, ok],
      [/baxian-promote-claim'$/, ok],
      [/&& mv '/, { stdout: 'BX_MV_PRECHECK', stderr: 'mv: rename failed', exitCode: 1 }],
    ]);

    await expect(scriptedStore(runner).ensure()).rejects.toThrow(/Cannot promote staged clone/);

    const removals = runner.commands.filter(c => /mv -- '[^']*repo\.claim-/.test(c));
    expect(removals.some(c => /\/repo\.claim-/.test(c) && !/\/repo\/repo\.claim-/.test(c))).toBe(true);
    expect(removals.some(c => /\/repo\/repo\.claim-/.test(c))).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('trashing staged clone'));
  });

  it('trashes a nested staging by its unique name when the final path was recreated mid-promote', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runner = new ScriptedRunner('/home/u', [
      [/^test -d /, { stdout: '', stderr: '', exitCode: 1 }],
      [/mkdir -p /, ok],
      [/git clone /, ok],
      [/baxian-promote-claim'$/, ok],
      [/&& mv '[^']*claim[^']*' '\/home\/u\/\.baxian\/agents\/dev-1\/repo'$/, ok],
      [/^test -e /, ok],
    ]);

    await expect(scriptedStore(runner).ensure()).rejects.toThrow(/recreated while promoting/);

    const removal = runner.commands.find(c => /mv -- '[^']*\/repo\/repo\.claim-/.test(c));
    expectTrashMove(removal, `/home/u/\\.baxian/agents/dev-1/repo/repo\\.claim-[0-9a-f-]+`);
    expect(runner.commands.some(c => /^mv '\/home\/u\/\.baxian\/agents\/dev-1\/repo\/repo\.claim-/.test(c))).toBe(false);
    expect(runner.commands.some(c => /mv -- '[^']*baxian-promote-claim'/.test(c))).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('recreated concurrently'));
  });

  it('refuses to adopt the promoted clone when its ownership marker is no longer ours (replaced after mv)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runner = new ScriptedRunner('/home/u', [
      [/^test -d /, { stdout: '', stderr: '', exitCode: 1 }],
      // The nonce-checked marker clear reports REFUSED: `final` was replaced after the mv (foreign clone).
      // Must outrank the generic mkdir rule — the trash-move clear embeds `mkdir -p <batch>`.
      [/then mkdir -p '[^']+' && mv -- '[^']*baxian-promote-claim'/, { stdout: 'BX_MARKER_REFUSED\n', stderr: '', exitCode: 0 }],
      [/mkdir -p /, ok],
      [/git clone /, ok],
      [/baxian-promote-claim'$/, ok],
      [/&& mv '[^']*claim[^']*' '\/home\/u\/\.baxian\/agents\/dev-1\/repo'$/, ok],
      [/^test -e /, { stdout: '', stderr: '', exitCode: 1 }],
    ]);

    await expect(scriptedStore(runner).ensure()).rejects.toThrow(/refusing to adopt/i);
    warn.mockRestore();
  });

  it('trashes the staging when the promote-claim stamp cannot be written', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runner = new ScriptedRunner('/home/u', [
      [/^test -d /, { stdout: '', stderr: '', exitCode: 1 }],
      [/mkdir -p /, ok],
      [/git clone /, ok],
      [/baxian-promote-claim'$/, { stdout: '', stderr: 'sh: cannot create', exitCode: 1 }],
    ]);

    await expect(scriptedStore(runner).ensure()).rejects.toThrow(/Cannot stamp staged clone/);

    const removals = runner.commands.filter(c => /mv -- '[^']*\/repo\.claim-/.test(c));
    expect(removals).toHaveLength(1);
    expectTrashMove(removals[0], `/home/u/\\.baxian/agents/dev-1/repo\\.claim-[0-9a-f-]+`);
    expect(runner.commands.some(c => c.includes("&& mv '"))).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('trashing staged clone'));
  });

  it('reconciles an uncertain promote mv as not-executed when the staging is still present', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runner = new ScriptedRunner('/home/u', [
      [/^test -d /, { stdout: '', stderr: '', exitCode: 1 }],
      [/mkdir -p /, ok],
      [/git clone /, ok],
      [/baxian-promote-claim'$/, ok],
      [/&& mv '/, { stdout: '', stderr: 'client_loop: send disconnect: Broken pipe', exitCode: 255 }],
      [/^test -e /, ok],
    ]);

    await expect(scriptedStore(runner).ensure()).rejects.toThrow(/not executed; staged clone withdrawn/);

    const removals = runner.commands.filter(c => /mv -- '[^']*\/repo\.claim-/.test(c));
    expect(removals).toHaveLength(1);
    expectTrashMove(removals[0], `/home/u/\\.baxian/agents/dev-1/repo\\.claim-[0-9a-f-]+`);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('trashing staged clone'));
  });

  it('keeps everything in place when the reconciliation staging probe is transient-tainted', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runner = new ScriptedRunner('/home/u', [
      [/^test -d /, { stdout: '', stderr: '', exitCode: 1 }],
      [/mkdir -p /, ok],
      [/git clone /, ok],
      [/baxian-promote-claim'$/, ok],
      [/&& mv '/, { stdout: '', stderr: 'client_loop: send disconnect: Broken pipe', exitCode: 255 }],
      [/^test -e /, { stdout: '', stderr: 'Connection reset by peer', exitCode: 0 }],
    ]);

    await expect(scriptedStore(runner).ensure()).rejects.toThrow(/staging probe outcome unknown/);

    expect(runner.commands.some(c => /mv -- '/.test(c))).toBe(false);
    warn.mockRestore();
  });

  it('keeps everything in place when the reconciliation nested probe is transient-tainted', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runner = new ScriptedRunner('/home/u', [
      [/^test -d /, { stdout: '', stderr: '', exitCode: 1 }],
      [/mkdir -p /, ok],
      [/git clone /, ok],
      [/baxian-promote-claim'$/, ok],
      [/&& mv '/, { stdout: '', stderr: 'client_loop: send disconnect: Broken pipe', exitCode: 255 }],
      [/^test -e '\/home\/u\/\.baxian\/agents\/dev-1\/repo\.claim-/, { stdout: '', stderr: '', exitCode: 1 }],
      [/^cat '/, { stdout: '', stderr: '', exitCode: 1 }],
      [/^test -e '\/home\/u\/\.baxian\/agents\/dev-1\/repo\/repo\.claim-/, { stdout: '', stderr: 'Connection reset by peer', exitCode: 0 }],
    ]);

    await expect(scriptedStore(runner).ensure()).rejects.toThrow(/nested probe outcome unknown/);

    expect(runner.commands.some(c => /mv -- '/.test(c))).toBe(false);
    warn.mockRestore();
  });

  it('routes an exit-0 promote mv with transient output into nonce reconciliation, not the success path', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runner = new ScriptedRunner('/home/u', [
      [/^test -d /, { stdout: '', stderr: '', exitCode: 1 }],
      [/mkdir -p /, ok],
      [/git clone /, ok],
      [/baxian-promote-claim'$/, ok],
      [/&& mv '/, { stdout: '', stderr: 'ssh: connect to host box-a port 22: Connection timed out', exitCode: 0 }],
      [/^test -e /, ok],
    ]);

    await expect(scriptedStore(runner).ensure()).rejects.toThrow(/not executed; staged clone withdrawn/);

    expect(runner.commands.some(c => c.startsWith('test -e ') && c.includes('repo.claim-'))).toBe(true);
    expect(runner.commands.some(c => /^test -e '[^']*\/repo\/repo\.claim-/.test(c))).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('trashing staged clone'));
    warn.mockRestore();
  });

  it('reconciles an uncertain promote mv as completed when the final clone holds our claim nonce', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const final = '/home/u/.baxian/agents/dev-1/repo';
    let nonce = '';
    const runner = new ScriptedRunner('/home/u', [
      [/^test -d '\/home\/u\/\.baxian\/agents\/dev-1\/repo'$/, { stdout: '', stderr: '', exitCode: 1 }],
      [/then mkdir -p '[^']+' && mv -- '[^']*baxian-promote-claim'/, { stdout: 'BX_MARKER_TRASHED\n', stderr: '', exitCode: 0 }],
      [/mkdir -p /, ok],
      [/git clone /, ok],
      [/baxian-promote-claim'$/, (c) => {
        nonce = /printf %s '([^']+)' >/.exec(c)![1];
        return ok;
      }],
      [/&& mv '/, { stdout: '', stderr: 'client_loop: send disconnect: Broken pipe', exitCode: 255 }],
      [/^test -e '\/home\/u\/\.baxian\/agents\/dev-1\/repo\.claim-[0-9a-f-]+'$/, { stdout: '', stderr: '', exitCode: 1 }],
      [/^cat '/, () => ({ stdout: `${nonce}\n`, stderr: '', exitCode: 0 })],
      [/rev-parse --show-toplevel/, { stdout: `${final}\n`, stderr: '', exitCode: 0 }],
      [/^cd '\/home\/u\/\.baxian\/agents\/dev-1\/repo' && pwd -P$/, { stdout: `${final}\n`, stderr: '', exitCode: 0 }],
      [/--is-bare-repository/, { stdout: 'false\n', stderr: '', exitCode: 0 }],
      [/config --get-regexp /, { stdout: '', stderr: '', exitCode: 1 }],
      [/for-each-ref/, { stdout: 'refs/remotes/origin/main\n', stderr: '', exitCode: 0 }],
    ]);

    await expect(scriptedStore(runner).ensure()).resolves.toBe(final);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('reconciled as already-completed'));
    expect(runner.commands.some(c => /mv -- '[^']*\/repo\.claim-/.test(c))).toBe(false);
    expect(runner.commands.some(c => c.includes('config --get-regexp '))).toBe(true);
    expect(runner.commands.some(c =>
      c.includes("cat '") && c.includes('baxian-promote-claim')
      && c.includes('mv -- ') && c.includes(nonce),
    )).toBe(true);
  });

  it('treats a marker clear that reports no outcome marker as failed, never as removed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runner = new ScriptedRunner('/home/u', [
      [/^test -d '\/home\/u\/\.baxian\/agents\/dev-1\/repo'$/, { stdout: '', stderr: '', exitCode: 1 }],
      // exit 0 with an empty stdout must not be read as a successful clear.
      [/then mkdir -p '[^']+' && mv -- '[^']*baxian-promote-claim'/, ok],
      [/mkdir -p /, ok],
      [/git clone /, ok],
      [/baxian-promote-claim'$/, ok],
      [/&& mv '[^']*claim[^']*' '\/home\/u\/\.baxian\/agents\/dev-1\/repo'$/, ok],
      [/^test -e /, { stdout: '', stderr: '', exitCode: 1 }],
    ]);

    await expect(scriptedStore(runner).ensure()).rejects.toThrow(/refusing to adopt/i);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no outcome marker'));
    warn.mockRestore();
  });

  it('reconcile refuses to adopt when the marker clear reports refused (final replaced after the nonce read)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let nonce = '';
    const runner = new ScriptedRunner('/home/u', [
      [/^test -d '\/home\/u\/\.baxian\/agents\/dev-1\/repo'$/, { stdout: '', stderr: '', exitCode: 1 }],
      // The atomic nonce-checked clear reports REFUSED: `final` was replaced after the separate cat.
      // Must outrank the generic mkdir rule — the trash-move clear embeds `mkdir -p <batch>`.
      [/then mkdir -p '[^']+' && mv -- '[^']*baxian-promote-claim'/, { stdout: 'BX_MARKER_REFUSED\n', stderr: '', exitCode: 0 }],
      [/mkdir -p /, ok],
      [/git clone /, ok],
      [/baxian-promote-claim'$/, (c) => { nonce = /printf %s '([^']+)' >/.exec(c)![1]; return ok; }],
      [/&& mv '/, { stdout: '', stderr: 'client_loop: send disconnect: Broken pipe', exitCode: 255 }],
      [/^test -e '\/home\/u\/\.baxian\/agents\/dev-1\/repo\.claim-[0-9a-f-]+'$/, { stdout: '', stderr: '', exitCode: 1 }],
      [/^cat '/, () => ({ stdout: `${nonce}\n`, stderr: '', exitCode: 0 })],
    ]);

    await expect(scriptedStore(runner).ensure()).rejects.toThrow(/refusing to adopt/i);
    warn.mockRestore();
  });

  it('trashes a nested staging by its unique name when an uncertain promote nested on a target race', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runner = new ScriptedRunner('/home/u', [
      [/^test -d /, { stdout: '', stderr: '', exitCode: 1 }],
      [/mkdir -p /, ok],
      [/git clone /, ok],
      [/baxian-promote-claim'$/, ok],
      [/&& mv '/, { stdout: '', stderr: 'client_loop: send disconnect: Broken pipe', exitCode: 255 }],
      [/^test -e '\/home\/u\/\.baxian\/agents\/dev-1\/repo\.claim-[0-9a-f-]+'$/, { stdout: '', stderr: '', exitCode: 1 }],
      [/^cat '/, { stdout: '', stderr: 'cat: no such file', exitCode: 1 }],
      [/^test -e '\/home\/u\/\.baxian\/agents\/dev-1\/repo\/repo\.claim-[0-9a-f-]+'$/, ok],
    ]);

    await expect(scriptedStore(runner).ensure()).rejects.toThrow(/nested on a target race/);

    const removals = runner.commands.filter(c => /mv -- '[^']*\/repo\/repo\.claim-/.test(c));
    expect(removals).toHaveLength(1);
    expectTrashMove(removals[0], `/home/u/\\.baxian/agents/dev-1/repo/repo\\.claim-[0-9a-f-]+`);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('trashing staged clone'));
  });

  it('keeps every location and fails loud when reconciliation probes are inconclusive', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runner = new ScriptedRunner('/home/u', [
      [/^test -d /, { stdout: '', stderr: '', exitCode: 1 }],
      [/mkdir -p /, ok],
      [/git clone /, ok],
      [/baxian-promote-claim'$/, ok],
      [/&& mv '/, { stdout: '', stderr: 'client_loop: send disconnect: Broken pipe', exitCode: 255 }],
      [/^test -e /, { stdout: '', stderr: 'probe hiccup', exitCode: 2 }],
    ]);

    await expect(scriptedStore(runner).ensure()).rejects.toThrow(/all locations inconclusive/);

    expect(runner.commands.some(c => /mv -- '[^']*\/repo\.claim-/.test(c))).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('outcome UNKNOWN'));
  });

  it('keeps both staging homes when the success-path nested probe is transport-uncertain', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runner = new ScriptedRunner('/home/u', [
      [/^test -d /, { stdout: '', stderr: '', exitCode: 1 }],
      [/mkdir -p /, ok],
      [/git clone /, ok],
      [/baxian-promote-claim'$/, ok],
      [/&& mv '/, ok],
      [/^test -e /, { stdout: '', stderr: 'Connection reset by peer', exitCode: 255 }],
    ]);

    await expect(scriptedStore(runner).ensure()).rejects.toThrow(/nested probe outcome unknown/);

    expect(runner.commands.some(c => /mv -- '[^']*repo\.claim-/.test(c))).toBe(false);
  });

  it('treats exit 1 with transient noise as a failed existence probe, not absence', async () => {
    const runner = new ScriptedRunner('/home/u', [
      [/^test -d /, { stdout: '', stderr: 'kex_exchange_identification: Connection closed by remote host', exitCode: 1 }],
    ]);

    await expect(scriptedStore(runner).ensure()).rejects.toThrow(/Cannot probe workdir/);

    expect(runner.commands.some(c => c.includes('clone'))).toBe(false);
    expect(runner.commands.some(c => c.includes('mv -- '))).toBe(false);
  });

  it('aborts leftover-dir recovery when rmdir fails at the transport layer', async () => {
    const runner = new ScriptedRunner('/home/u', [
      [/^test -d /, ok],
      [/rev-parse --resolve-git-dir /, { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 }],
      [/rev-parse --show-toplevel/, { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 }],
      [/rmdir /, { stdout: '', stderr: 'ssh: connect to host box-a: Connection timed out', exitCode: 255 }],
    ]);

    await expect(scriptedStore(runner).ensure()).rejects.toThrow(/Cannot probe leftover dir/);

    expect(runner.commands.some(c => c.includes('mv -- '))).toBe(false);
    expect(runner.commands.some(c => c.includes('git clone'))).toBe(false);
  });

  it('still reports non-empty leftovers as unrecoverable after a clean rmdir refusal', async () => {
    const runner = new ScriptedRunner('/home/u', [
      [/^test -d /, ok],
      [/rev-parse --resolve-git-dir /, { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 }],
      [/rev-parse --show-toplevel/, { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 }],
      [/rmdir /, { stdout: '', stderr: 'rmdir: failed to remove: Directory not empty', exitCode: 1 }],
    ]);

    await expect(scriptedStore(runner).ensure()).rejects.toThrow(/not a git repository\. Remove it manually/);
  });

  it('recovers a leftover empty dir with rmdir and retries the clone', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runner = new ScriptedRunner('/home/u', [
      [/^test -d /, [
        { stdout: '', stderr: '', exitCode: 0 },
        { stdout: '', stderr: '', exitCode: 1 },
      ]],
      [/rev-parse --resolve-git-dir '[^']*\.git'/, { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 }],
      [/rev-parse --show-toplevel/, { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 }],
      [/rev-parse --resolve-git-dir /, { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 }],
      [/rmdir /, ok],
      [/mkdir -p /, ok],
      [/git clone /, { stdout: '', stderr: 'fatal: early EOF', exitCode: 128 }],
    ]);

    await expect(scriptedStore(runner).ensure()).rejects.toThrow(/git clone .* failed/);

    expect(runner.commands.find(c => c.includes('rmdir '))).toBe(
      `rmdir '/home/u/.baxian/agents/dev-1/repo'`,
    );
    expect(runner.commands.some(c => c.includes('git clone '))).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('removed leftover empty dir'));
  });

  it('tolerates pushurl-unset exit 5 (key absent) and moves on', async () => {
    const runner = new ScriptedRunner('/home/u', [
      [/^test -d /, ok],
      [/rev-parse --resolve-git-dir /, ok],
      [/remote get-url origin/, { stdout: 'git@github.com:group/project.git\n', stderr: '', exitCode: 0 }],
      [/--unset-all remote\.origin\.pushurl/, { stdout: '', stderr: '', exitCode: 5 }],
    ]);

    const rejection = await scriptedStore(runner).ensure().catch((err: Error) => err);

    expect(runner.commands.some(c => c.includes('--unset-all remote.origin.pushurl'))).toBe(true);
    expect(String(rejection)).not.toMatch(/pushurl/);
  });

  it('clears pushurl before flipping the URL, so a failed unset stays retryable', async () => {
    const rules: Array<[RegExp, ExecResult | ExecResult[]]> = [
      [/^test -d /, ok],
      [/rev-parse --resolve-git-dir /, ok],
      [/remote get-url origin/, { stdout: 'git@github.com:group/project.git\n', stderr: '', exitCode: 0 }],
      [/--unset-all remote\.origin\.pushurl/, [
        { stdout: '', stderr: 'error: could not lock config file', exitCode: 4 },
        { stdout: '', stderr: '', exitCode: 5 },
      ]],
      [/--replace-all remote\.origin\.url/, ok],
    ];
    const runner = new ScriptedRunner('/home/u', rules);
    const store = scriptedStore(runner);

    await expect(store.ensure()).rejects.toThrow(/Failed to clear remote\.origin\.pushurl/);
    expect(runner.commands.some(c => c.includes('--replace-all remote.origin.url'))).toBe(false);

    await store.ensure().catch(() => undefined);
    const unsets = runner.commands.filter(c => c.includes('--unset-all remote.origin.pushurl'));
    const replaceIdx = runner.commands.findIndex(c => c.includes('--replace-all remote.origin.url'));
    expect(unsets).toHaveLength(2);
    expect(replaceIdx).toBeGreaterThan(runner.commands.findIndex(c => c.includes('--unset-all')));
  });

  it('fails loud when pushurl-unset reports a config write failure', async () => {
    const runner = new ScriptedRunner('/home/u', [
      [/^test -d /, ok],
      [/rev-parse --resolve-git-dir /, ok],
      [/remote get-url origin/, { stdout: 'git@github.com:group/project.git\n', stderr: '', exitCode: 0 }],
      [/--unset-all remote\.origin\.pushurl/, { stdout: '', stderr: 'error: could not lock config file', exitCode: 4 }],
    ]);

    await expect(scriptedStore(runner).ensure()).rejects.toThrow(/Failed to clear remote\.origin\.pushurl/);
  });

  it('aborts when pushurl-unset fails at the transport layer', async () => {
    const runner = new ScriptedRunner('/home/u', [
      [/^test -d /, ok],
      [/rev-parse --resolve-git-dir /, ok],
      [/remote get-url origin/, { stdout: 'git@github.com:group/project.git\n', stderr: '', exitCode: 0 }],
      [/--unset-all remote\.origin\.pushurl/, { stdout: '', stderr: 'ssh: connect to host box-a: Connection timed out', exitCode: 255 }],
    ]);

    await expect(scriptedStore(runner).ensure()).rejects.toThrow(/Cannot probe remote\.origin\.pushurl removal/);
  });

  it('validate-stage probes fail closed on transport errors', async () => {
    const runner = new ScriptedRunner('/home/u', [
      [/^test -d /, ok],
      [/rev-parse --resolve-git-dir '[^']*\.git'/, ok],
      [/remote get-url origin/, { stdout: 'https://github.com/group/project.git\n', stderr: '', exitCode: 0 }],
      [/rev-parse --show-toplevel/, { stdout: '', stderr: 'ssh: connect to host box-a: Connection timed out', exitCode: 255 }],
    ]);

    await expect(scriptedStore(runner).ensure()).rejects.toThrow(/Cannot probe worktree top/);

    expect(runner.commands.some(c => c.includes('mv -- '))).toBe(false);
  });

  it('aborts instead of advising manual removal when the git-dir probe fails in transit', async () => {
    const runner = new ScriptedRunner('/home/u', [
      [/^test -d /, ok],
      [/rev-parse --resolve-git-dir /, { stdout: '', stderr: 'ssh: connect to host box-a: Connection timed out', exitCode: 255 }],
    ]);

    await expect(scriptedStore(runner).ensure()).rejects.toThrow(/Cannot probe git dir/);

    expect(runner.commands.some(c => c.includes('mv -- '))).toBe(false);
  });

  it('treats transient noise on stdout as a failed git-dir probe too', async () => {
    const runner = new ScriptedRunner('/home/u', [
      [/^test -d /, ok],
      [/rev-parse --resolve-git-dir /, { stdout: 'kex_exchange_identification: Connection closed by remote host', stderr: '', exitCode: 1 }],
    ]);

    await expect(scriptedStore(runner).ensure()).rejects.toThrow(/Cannot probe git dir/);
  });

  it('fails closed when the subdirectory probe dies in transit after a legitimate git-dir "no"', async () => {
    const runner = new ScriptedRunner('/home/u', [
      [/^test -d /, ok],
      [/rev-parse --resolve-git-dir '[^']*\.git'/, { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 }],
      [/rev-parse --show-toplevel/, { stdout: '', stderr: 'ssh: connect to host box-a: Connection timed out', exitCode: 255 }],
    ]);

    await expect(scriptedStore(runner).ensure()).rejects.toThrow(/Cannot probe repo layout/);

    expect(runner.commands.some(c => c.includes('mv -- '))).toBe(false);
  });

  it('fails closed when the bare probe dies in transit instead of advising manual removal', async () => {
    const runner = new ScriptedRunner('/home/u', [
      [/^test -d /, ok],
      [/rev-parse --resolve-git-dir '[^']*\.git'/, { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 }],
      [/rev-parse --show-toplevel/, { stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories)', exitCode: 128 }],
      [/rev-parse --resolve-git-dir /, { stdout: '', stderr: 'Connection reset by peer', exitCode: 255 }],
    ]);

    await expect(scriptedStore(runner).ensure()).rejects.toThrow(/Cannot probe repo layout/);

    expect(runner.commands.some(c => c.includes('mv -- '))).toBe(false);
  });
});

describe('moveFileIntoPlace (real filesystem)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'bx-mvip-')));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const write = async (path: string, content: string): Promise<void> => {
    await run(`printf %s ${shellQuote(content)} > ${shellQuote(path)}`);
  };

  it('replaces a plain-file target atomically', async () => {
    await write(`${dir}/tmp1`, 'new');
    await write(`${dir}/final`, 'old');
    await moveFileIntoPlace(local, `${dir}/tmp1`, `${dir}/final`, { trashDir: testTrash(dir) });
    expect(await run(`cat ${shellQuote(`${dir}/final`)}`)).toBe('new');
  });

  it('refuses to publish a staging leaf that was replaced by a symlink', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const external = `${dir}/external`;
    await write(external, 'foreign');
    await symlink(external, `${dir}/tmp-link`);

    await expect(moveFileIntoPlace(local, `${dir}/tmp-link`, `${dir}/final-link`, { trashDir: testTrash(dir) }))
      .rejects.toThrow(/atomic replace/);

    expect(await run(`cat ${shellQuote(external)}`)).toBe('foreign');
    await expect(lstat(`${dir}/final-link`)).rejects.toMatchObject({ code: 'ENOENT' });
    warn.mockRestore();
  });

  it('pins non-symlink checks for both staging and published leaves in the atomic command', async () => {
    const exec = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
    const runner = {
      exec,
      writeFile: vi.fn(async () => undefined),
      execWithStdin: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    } as CommandRunner;

    await moveFileIntoPlace(runner, '/work/tmp', '/work/final', { trashDir: testTrash('/work') });

    expect(exec).toHaveBeenCalledOnce();
    const command = exec.mock.calls[0]![0];
    expect(command).toContain("[ -f '/work/tmp' ] && [ ! -L '/work/tmp' ]");
    expect(command).toContain("[ -f '/work/final' ] && [ ! -L '/work/final' ]");
  });

  it('fails closed before mv when the target is a directory — no nested tmp ever lands', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await run(`mkdir -p ${shellQuote(`${dir}/final`)}`);
    await write(`${dir}/tmp2`, 'payload');

    await expect(moveFileIntoPlace(local, `${dir}/tmp2`, `${dir}/final`, { trashDir: testTrash(dir) })).rejects.toThrow(/atomic replace/);

    expect(await run(`ls -A ${shellQuote(`${dir}/final`)}`)).toBe('');
    const tmpLeft = await local.exec(`test -e ${shellQuote(`${dir}/tmp2`)}`);
    expect(tmpLeft.exitCode).toBe(1);
    warn.mockRestore();
  });

  it('fails closed when the target is a symlink to a directory', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await run(`mkdir -p ${shellQuote(`${dir}/real`)}`);
    await symlink(`${dir}/real`, `${dir}/final`);
    await write(`${dir}/tmp3`, 'payload');

    await expect(moveFileIntoPlace(local, `${dir}/tmp3`, `${dir}/final`, { trashDir: testTrash(dir) })).rejects.toThrow(/atomic replace/);

    expect(await run(`ls -A ${shellQuote(`${dir}/real`)}`)).toBe('');
  });

  it('leaves a same-named file inside a directory target alone when mv never ran', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await run(`mkdir -p ${shellQuote(`${dir}/final`)}`);
    await write(`${dir}/final/tmp4`, 'not ours');
    await write(`${dir}/tmp4`, 'payload');

    await expect(moveFileIntoPlace(local, `${dir}/tmp4`, `${dir}/final`, { trashDir: testTrash(dir) })).rejects.toThrow(/atomic replace/);

    expect(await run(`cat ${shellQuote(`${dir}/final/tmp4`)}`)).toBe('not ours');
    const tmpLeft = await local.exec(`test -e ${shellQuote(`${dir}/tmp4`)}`);
    expect(tmpLeft.exitCode).toBe(1);
  });

  it('keeps an unrelated same-named file behind a symlinked directory target out of trash', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await run(`mkdir -p ${shellQuote(`${dir}/real`)}`);
    await write(`${dir}/real/tmp5`, 'user data behind the link');
    await symlink(`${dir}/real`, `${dir}/final5`);
    await write(`${dir}/tmp5`, 'payload');

    await expect(moveFileIntoPlace(local, `${dir}/tmp5`, `${dir}/final5`, { trashDir: testTrash(dir) })).rejects.toThrow(/atomic replace/);

    expect(await run(`cat ${shellQuote(`${dir}/real/tmp5`)}`)).toBe('user data behind the link');
    const link = await lstat(`${dir}/final5`);
    expect(link.isSymbolicLink()).toBe(true);
  });

  it('moves a swept file into the trash batch instead of deleting it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await write(`${dir}/stray`, 'recoverable');
    const trash = testTrash(dir);

    await sweepStrayFile(local, `${dir}/stray`, trash);

    expect(await run(`cat ${shellQuote(`${trash}/stray`)}`)).toBe('recoverable');
    warn.mockRestore();
  });

  it('gives same-named entries unique targets inside one batch', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await run(`mkdir -p ${shellQuote(`${dir}/a`)} ${shellQuote(`${dir}/b`)}`);
    await write(`${dir}/a/same`, 'first');
    await write(`${dir}/b/same`, 'second');
    const trash = testTrash(dir);

    await sweepStrayFile(local, `${dir}/a/same`, trash);
    await sweepStrayFile(local, `${dir}/b/same`, trash);

    expect(await run(`cat ${shellQuote(`${trash}/same`)}`)).toBe('first');
    expect(await run(`cat ${shellQuote(`${trash}/same.1`)}`)).toBe('second');
  });

  it('treats an absent sweep target as success without creating a batch dir', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const trash = testTrash(dir);

    await sweepStrayFile(local, `${dir}/never-existed`, trash);

    expect(warn).not.toHaveBeenCalled();
    const batch = await local.exec(`test -e ${shellQuote(trash)}`);
    expect(batch.exitCode).toBe(1);
    warn.mockRestore();
  });

});

describe('ensureBaxianRuntimeDirsSafe outcome classification', () => {
  function runnerWith(results: Array<ExecResult | Error>): CommandRunner {
    let index = 0;
    return {
      exec: async () => {
        const result = results[index++]!;
        if (result instanceof Error) throw result;
        return result;
      },
      writeFile: async () => undefined,
      execWithStdin: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    };
  }

  it('accepts a clean tracked probe and prepares the runtime dirs', async () => {
    await expect(ensureBaxianRuntimeDirsSafe(runnerWith([
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
    ]), '/wt')).resolves.toBeUndefined();
  });

  it.each([
    ['tracked-path exit 255', [
      { stdout: '', stderr: 'ssh disconnected', exitCode: 255 },
    ]],
    ['mkdir transient failure', [
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: '', stderr: 'Connection timed out', exitCode: 9 },
    ]],
    ['tracked-path transient output with exit zero', [
      { stdout: '', stderr: 'Connection timed out', exitCode: 0 },
    ]],
    ['mkdir transient output with exit zero', [
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: '', stderr: 'Connection timed out', exitCode: 0 },
    ]],
    ['runner rejection', [new Error('runner unavailable')]],
  ])('maps %s to probe-failed, never unsafe', async (_label, results) => {
    await expect(ensureBaxianRuntimeDirsSafe(
      runnerWith(results as Array<ExecResult | Error>),
      '/wt',
    )).rejects.toMatchObject({ reason: 'runtime-path-probe-failed' });
  });

  it('maps tracked .baxian paths to unsafe-runtime-path', async () => {
    await expect(ensureBaxianRuntimeDirsSafe(runnerWith([
      { stdout: '.baxian/x\n', stderr: '', exitCode: 0 },
    ]), '/wt')).rejects.toMatchObject({ reason: 'unsafe-runtime-path' });
  });
});

describe('stageFile (real filesystem)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'bx-stage-')));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes the tmp', async () => {
    await run(`mkdir -p ${shellQuote(`${dir}/sub`)}`);
    await stageFile(local, `${dir}/sub/.tmp-abc`, 'payload', { trashDir: testTrash(dir) });
    expect(await run(`cat ${shellQuote(`${dir}/sub/.tmp-abc`)}`)).toBe('payload');
  });

  it('creates missing parent directories inside the staged command', async () => {
    const tmp = `${dir}/.baxian/artifacts/task/put-spec.baxian-tmp-abc123`;
    await stageFile(local, tmp, 'helper-body', { trashDir: testTrash(dir) });
    expect(await run(`cat ${shellQuote(tmp)}`)).toBe('helper-body');
  });
});

describe('staged file mutation outcome classification', () => {
  function mutationRunner(results: {
    stage?: ExecResult;
    move?: ExecResult;
  }): CommandRunner {
    return {
      exec: async command => command.includes('mv -f --')
        ? results.move ?? ok
        : { stdout: 'BX_TRASHED', stderr: '', exitCode: 0 },
      writeFile: async () => undefined,
      execWithStdin: async () => results.stage ?? ok,
    };
  }

  it('preserves an outcome-unknown type for a staged write transport failure', async () => {
    const runner = mutationRunner({
      stage: { stdout: '', stderr: 'ssh response lost', exitCode: 255 },
    });

    await expect(stageFile(runner, '/wt/.tmp-request', 'payload', { trashDir: testTrash('/wt') }))
      .rejects.toBeInstanceOf(ExecOutcomeUnknownError);
  });

  it('distinguishes an outcome-unknown move from a definite command refusal', async () => {
    const unknown = mutationRunner({
      move: { stdout: '', stderr: 'Connection reset by peer', exitCode: 255 },
    });
    const refused = mutationRunner({
      move: { stdout: '', stderr: 'permission denied', exitCode: 9 },
    });

    await expect(moveFileIntoPlace(unknown, '/wt/.tmp-request', '/wt/request', { trashDir: testTrash('/wt') }))
      .rejects.toBeInstanceOf(ExecOutcomeUnknownError);
    const refusal = await moveFileIntoPlace(refused, '/wt/.tmp-request', '/wt/request', { trashDir: testTrash('/wt') })
      .then(() => undefined, err => err);
    expect(refusal).toBeInstanceOf(Error);
    expect(refusal).not.toBeInstanceOf(ExecOutcomeUnknownError);
  });
});

describe('sweepStrayFile real-shell outcomes', () => {
  let dir: string;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bx-trash-'));
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    warn.mockRestore();
    await chmod(join(dir, 'batch'), 0o755).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  it('moves an existing entry into the batch under its own name', async () => {
    await writeFile(join(dir, 'doomed.txt'), 'keep me');
    const batch = join(dir, 'batch');
    await sweepStrayFile(local, join(dir, 'doomed.txt'), batch);
    expect(existsSync(join(dir, 'doomed.txt'))).toBe(false);
    expect(await readFile(join(batch, 'doomed.txt'), 'utf-8')).toBe('keep me');
    expect(warn).not.toHaveBeenCalled();
  });

  it('treats an absent source as success without creating the batch', async () => {
    await sweepStrayFile(local, join(dir, 'never-existed'), join(dir, 'batch'));
    expect(warn).not.toHaveBeenCalled();
    expect(existsSync(join(dir, 'batch'))).toBe(false);
  });

  it('surfaces a batch mkdir failure as move-failed, not unknown, and keeps the source', async () => {
    await writeFile(join(dir, 'blocker'), '');
    await writeFile(join(dir, 'src.txt'), 'still here');
    await sweepStrayFile(local, join(dir, 'src.txt'), join(dir, 'blocker', 'batch'));
    expect(await readFile(join(dir, 'src.txt'), 'utf-8')).toBe('still here');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/move failed \(exit [1-9]/);
    expect(String(warn.mock.calls[0][0])).not.toMatch(/UNKNOWN/);
  });

  it('surfaces an mv failure into a read-only batch and keeps the source', async () => {
    await mkdir(join(dir, 'batch'));
    await chmod(join(dir, 'batch'), 0o555);
    await writeFile(join(dir, 'src.txt'), 'still here');
    await sweepStrayFile(local, join(dir, 'src.txt'), join(dir, 'batch'));
    expect(await readFile(join(dir, 'src.txt'), 'utf-8')).toBe('still here');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/move failed/);
  });
});
