import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lstat, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RepoStore,
  accessMethodDiffers,
  ancestorSymlinkGuard,
  isUnder,
  createRepoStoreCache,
  moveFileIntoPlace,
  stageFileGuarded,
  sweepStrayFile,
} from '../../src/agent/repo-store.js';
import { LocalRunner, shellQuote, type CommandRunner, type ExecOptions, type ExecResult } from '../../src/agent/runner.js';

const PROJECT_REPO = 'https://git.example.com/group/project.git';
const local = new LocalRunner();
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
    const cloneTarget = command.match(/(?:git clone|gh repo clone) (?:'[^']+'|\S+) '([^']+)'/)?.[1];
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

  it('creates real directories for every baxian runtime path', async () => {
    const path = join(tempDir, 'custom-runtime-dirs');
    await cloneAt(path);
    const store = new RepoStore(
      new TestRunner(tempDir, origin), PROJECT_REPO, 'local', undefined,
      createRepoStoreCache(), 'dev-1', path,
    );

    await store.ensure();

    for (const relative of ['.baxian', '.baxian/review', '.baxian/review/inbox', '.baxian/review-inbox']) {
      const stat = await lstat(join(path, relative));
      expect(stat.isDirectory()).toBe(true);
      expect(stat.isSymbolicLink()).toBe(false);
    }
  });

  it.each(['.baxian', '.baxian/review'])('rejects a symbolic-link runtime directory at %s', async (relative) => {
    const path = join(tempDir, `custom-symlink-${relative.replaceAll('/', '-')}`);
    const outside = join(tempDir, `outside-${relative.replaceAll('/', '-')}`);
    await cloneAt(path);
    await run(`mkdir -p ${shellQuote(outside)}`);
    if (relative.includes('/')) await run(`mkdir -p ${shellQuote(join(path, '.baxian'))}`);
    await symlink(outside, join(path, relative));
    const store = new RepoStore(
      new TestRunner(tempDir, origin), PROJECT_REPO, 'local', undefined,
      createRepoStoreCache(), 'dev-1', path,
    );

    await expect(store.ensure()).rejects.toThrow(/unsafe \.baxian runtime path/i);
    expect((await lstat(join(path, relative))).isSymbolicLink()).toBe(true);
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
    await cloneAt(path, 'https://git.example.com/other/project.git');
    const store = new RepoStore(
      new TestRunner(tempDir, origin), PROJECT_REPO, 'local', undefined,
      createRepoStoreCache(), 'dev-1', path,
    );

    await expect(store.ensure()).rejects.toThrow(/does not match project\.repo/i);
  });

  it('validates but does not rewrite the origin access method in a user-specified Workdir', async () => {
    const path = join(tempDir, 'custom-ssh-origin');
    const sshOrigin = 'git@git.example.com:group/project.git';
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

  it('GitHub auto clone command never requests a bare repository', async () => {
    const home = join(tempDir, 'home');
    await run(`mkdir -p ${shellQuote(home)}`);
    const runner = new TestRunner(home, origin, 'https://github.com/owner/repo.git');
    const store = new RepoStore(
      runner, 'owner/repo', 'remote', { hostname: 'box-a' },
      createRepoStoreCache(), 'dev-1',
    );

    await store.ensure();

    const clone = runner.commands.find(command => command.includes('gh repo clone'));
    expect(clone).toContain("gh repo clone 'owner/repo'");
    expect(clone).not.toContain('--bare');
  });

  it('clones a github repo with plain git when the resolved tool is not gh', async () => {
    const origin = join(tempDir, 'origin.git');
    await run(`git init --bare ${shellQuote(origin)}`);
    const home = join(tempDir, 'home');
    await run(`mkdir -p ${shellQuote(home)}`);
    const runner = new TestRunner(home, origin, 'https://github.com/owner/repo.git');
    const store = new RepoStore(
      runner, 'https://github.com/owner/repo.git', 'remote', { hostname: 'box-a' },
      createRepoStoreCache(), 'dev-1', undefined, false,
    );

    await store.ensure();

    expect(runner.commands.some(command => command.includes('gh repo clone'))).toBe(false);
    const clone = runner.commands.find(command => command.includes('git clone'));
    expect(clone).toContain("git clone 'https://github.com/owner/repo.git'");
  });
});

describe('accessMethodDiffers', () => {
  it('distinguishes HTTPS and SSH while treating equivalent SSH forms alike', () => {
    expect(accessMethodDiffers('https://git.example.com/g/p.git', 'git@git.example.com:g/p.git')).toBe(true);
    expect(accessMethodDiffers('ssh://git@git.example.com/g/p.git', 'git@git.example.com:g/p.git')).toBe(false);
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

describe('RepoStore destructive-cleanup guards', () => {
  it('aborts ensure when the existence probe fails at the exec layer, without cloning or removing', async () => {
    const runner = new ScriptedRunner('/home/u', [
      [/^test -d /, { stdout: '', stderr: 'Connection timed out during banner exchange', exitCode: 255 }],
    ]);

    await expect(scriptedStore(runner).ensure()).rejects.toThrow(/Cannot probe workdir/);

    expect(runner.commands.some(c => c.includes('clone'))).toBe(false);
    expect(runner.commands.some(c => c.includes('rm -rf'))).toBe(false);
  });

  it('clones into a unique staging name and only ever deletes that name on failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runner = new ScriptedRunner('/home/u', [
      [/^test -d /, { stdout: '', stderr: '', exitCode: 1 }],
      [/mkdir -p /, ok],
      [/git clone /, { stdout: '', stderr: 'fatal: unable to access remote', exitCode: 128 }],
      [/rm -rf /, ok],
      [/rmdir /, ok],
    ]);

    await expect(scriptedStore(runner).ensure()).rejects.toThrow(/git clone .* failed/);

    const final = '/home/u/.baxian/agents/dev-1/repo';
    const cloneCmd = runner.commands.find(c => c.includes('git clone '));
    expect(cloneCmd).toMatch(/repo\.claim-[0-9a-f-]+'/);
    expect(cloneCmd).not.toContain(`${final}'`);
    const removal = runner.commands.find(c => c.includes('rm -rf '));
    expect(removal).toContain(`[ "$(cd -- '/home/u' 2>/dev/null && pwd -P)" = '/home/u' ]`);
    expect(removal).toMatch(new RegExp(`then rm -rf '${final}\\.claim-[0-9a-f-]+' && echo BX_STAGING_REMOVED;`));
    expect(runner.commands.some(c => c.includes('rmdir '))).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('removing staged clone'));
  });

  it('discards the staging by its unique name when promotion fails, leaving nothing behind', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runner = new ScriptedRunner('/home/u', [
      [/^test -d /, { stdout: '', stderr: '', exitCode: 1 }],
      [/mkdir -p /, ok],
      [/git clone /, ok],
      [/baxian-promote-claim'$/, ok],
      [/&& mv '/, { stdout: '', stderr: 'mv: rename failed', exitCode: 1 }],
      [/rm -rf /, ok],
    ]);

    await expect(scriptedStore(runner).ensure()).rejects.toThrow(/Cannot promote staged clone/);

    const removal = runner.commands.find(c => c.includes('rm -rf '));
    expect(removal).toMatch(/then rm -rf '\/home\/u\/\.baxian\/agents\/dev-1\/repo\.claim-[0-9a-f-]+' && echo BX_STAGING_REMOVED;/);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('removing staged clone'));
  });

  it('discards a nested staging by its unique name when the final path was recreated mid-promote', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runner = new ScriptedRunner('/home/u', [
      [/^test -d /, { stdout: '', stderr: '', exitCode: 1 }],
      [/mkdir -p /, ok],
      [/git clone /, ok],
      [/baxian-promote-claim'$/, ok],
      [/&& mv '[^']*claim[^']*' '\/home\/u\/\.baxian\/agents\/dev-1\/repo'$/, ok],
      [/^test -e /, ok],
      [/rm -rf /, ok],
    ]);

    await expect(scriptedStore(runner).ensure()).rejects.toThrow(/recreated while promoting/);

    const removal = runner.commands.find(c => c.includes('rm -rf '));
    expect(removal).toMatch(/then rm -rf '\/home\/u\/\.baxian\/agents\/dev-1\/repo\/repo\.claim-[0-9a-f-]+' && echo BX_STAGING_REMOVED;/);
    expect(runner.commands.some(c => /^mv '\/home\/u\/\.baxian\/agents\/dev-1\/repo\/repo\.claim-/.test(c))).toBe(false);
    // On a nested race `final` is a foreign directory; its baxian-promote-claim must NOT be deleted.
    expect(runner.commands.some(c => /rm -f '[^']*baxian-promote-claim'/.test(c))).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('recreated concurrently'));
  });

  it('refuses to adopt the promoted clone when its ownership marker is no longer ours (replaced after mv)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runner = new ScriptedRunner('/home/u', [
      [/^test -d /, { stdout: '', stderr: '', exitCode: 1 }],
      [/mkdir -p /, ok],
      [/git clone /, ok],
      [/baxian-promote-claim'$/, ok], // stamp our nonce
      [/&& mv '[^']*claim[^']*' '\/home\/u\/\.baxian\/agents\/dev-1\/repo'$/, ok], // promote mv succeeds (exit 0)
      [/^test -e /, { stdout: '', stderr: '', exitCode: 1 }], // no nested copy → `final` is where we landed
      // The nonce-checked marker clear reports REFUSED: `final` was replaced after the mv (foreign clone).
      [/then rm -f '[^']*baxian-promote-claim'/, { stdout: 'BX_MARKER_REFUSED\n', stderr: '', exitCode: 0 }],
    ]);

    await expect(scriptedStore(runner).ensure()).rejects.toThrow(/refusing to adopt/i);
    warn.mockRestore();
  });

  it('discards the staging when the promote-claim stamp cannot be written', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runner = new ScriptedRunner('/home/u', [
      [/^test -d /, { stdout: '', stderr: '', exitCode: 1 }],
      [/mkdir -p /, ok],
      [/git clone /, ok],
      [/baxian-promote-claim'$/, { stdout: '', stderr: 'sh: cannot create', exitCode: 1 }],
      [/rm -rf /, ok],
    ]);

    await expect(scriptedStore(runner).ensure()).rejects.toThrow(/Cannot stamp staged clone/);

    const removals = runner.commands.filter(c => c.includes('rm -rf '));
    expect(removals).toHaveLength(1);
    expect(removals[0]).toMatch(/then rm -rf '\/home\/u\/\.baxian\/agents\/dev-1\/repo\.claim-[0-9a-f-]+' && echo BX_STAGING_REMOVED;/);
    expect(runner.commands.some(c => c.includes('&& mv '))).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('removing staged clone'));
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
      [/rm -rf /, ok],
    ]);

    await expect(scriptedStore(runner).ensure()).rejects.toThrow(/not executed; staged clone withdrawn/);

    const removals = runner.commands.filter(c => c.includes('rm -rf '));
    expect(removals).toHaveLength(1);
    expect(removals[0]).toMatch(/then rm -rf '\/home\/u\/\.baxian\/agents\/dev-1\/repo\.claim-[0-9a-f-]+' && echo BX_STAGING_REMOVED;/);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('removing staged clone'));
  });

  it('reconciles an uncertain promote mv as completed when the final clone holds our claim nonce', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const final = '/home/u/.baxian/agents/dev-1/repo';
    let nonce = '';
    const runner = new ScriptedRunner('/home/u', [
      [/^test -d '\/home\/u\/\.baxian\/agents\/dev-1\/repo'$/, { stdout: '', stderr: '', exitCode: 1 }],
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
    expect(runner.commands.some(c => c.includes('rm -rf '))).toBe(false);
    expect(runner.commands.some(c => c.includes('config --get-regexp '))).toBe(true);
    // The marker rm re-checks the nonce in the SAME command (not a separate cat→rm that a race could exploit).
    expect(runner.commands.some(c =>
      c.includes("cat '") && c.includes('baxian-promote-claim')
      && c.includes('rm -f') && c.includes(nonce),
    )).toBe(true);
  });

  it('reconcile refuses to adopt when the marker clear reports refused (final replaced after the nonce read)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let nonce = '';
    const runner = new ScriptedRunner('/home/u', [
      [/^test -d '\/home\/u\/\.baxian\/agents\/dev-1\/repo'$/, { stdout: '', stderr: '', exitCode: 1 }],
      [/mkdir -p /, ok],
      [/git clone /, ok],
      // The atomic nonce-checked clear reports REFUSED: `final` was replaced after the separate cat.
      [/then rm -f '[^']*baxian-promote-claim'/, { stdout: 'BX_MARKER_REFUSED\n', stderr: '', exitCode: 0 }],
      [/baxian-promote-claim'$/, (c) => { nonce = /printf %s '([^']+)' >/.exec(c)![1]; return ok; }],
      [/&& mv '/, { stdout: '', stderr: 'client_loop: send disconnect: Broken pipe', exitCode: 255 }],
      [/^test -e '\/home\/u\/\.baxian\/agents\/dev-1\/repo\.claim-[0-9a-f-]+'$/, { stdout: '', stderr: '', exitCode: 1 }],
      [/^cat '/, () => ({ stdout: `${nonce}\n`, stderr: '', exitCode: 0 })],
    ]);

    await expect(scriptedStore(runner).ensure()).rejects.toThrow(/refusing to adopt/i);
    warn.mockRestore();
  });

  it('discards a nested staging by its unique name when an uncertain promote nested on a target race', async () => {
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

    const removals = runner.commands.filter(c => c.includes('rm -rf '));
    expect(removals).toHaveLength(1);
    expect(removals[0]).toContain(`[ ! -L '/home/u/.baxian/agents/dev-1/repo' ]`);
    expect(removals[0]).toMatch(/then rm -rf '\/home\/u\/\.baxian\/agents\/dev-1\/repo\/repo\.claim-[0-9a-f-]+' && echo BX_STAGING_REMOVED;/);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('removing staged clone'));
  });

  it('keeps every location and fails loud when reconciliation probes are inconclusive', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runner = new ScriptedRunner('/home/u', [
      [/^test -d /, { stdout: '', stderr: '', exitCode: 1 }],
      [/mkdir -p /, ok],
      [/git clone /, ok],
      [/baxian-promote-claim'$/, ok],
      [/&& mv '/, { stdout: '', stderr: 'client_loop: send disconnect: Broken pipe', exitCode: 255 }],
      [/^test -e /, { stdout: '', stderr: 'Connection reset by peer', exitCode: 255 }],
    ]);

    await expect(scriptedStore(runner).ensure()).rejects.toThrow(/all locations inconclusive/);

    expect(runner.commands.some(c => c.includes('rm -rf'))).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('outcome UNKNOWN'));
  });

  it('sweeps both staging homes and fails loud when the nested probe is transport-uncertain', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runner = new ScriptedRunner('/home/u', [
      [/^test -d /, { stdout: '', stderr: '', exitCode: 1 }],
      [/mkdir -p /, ok],
      [/git clone /, ok],
      [/baxian-promote-claim'$/, ok],
      [/&& mv '/, ok],
      [/^test -e /, { stdout: '', stderr: 'Connection reset by peer', exitCode: 255 }],
      [/rm -rf /, ok],
    ]);

    await expect(scriptedStore(runner).ensure()).rejects.toThrow(/Cannot verify promoted clone/);

    const removals = runner.commands.filter(c => c.includes('rm -rf '));
    expect(removals).toHaveLength(2);
    expect(removals.some(c => /repo\.claim-[0-9a-f-]+' && echo BX_STAGING_REMOVED;/.test(c) && !c.includes('/repo/repo.claim'))).toBe(true);
    expect(removals.some(c => c.includes('/repo/repo.claim'))).toBe(true);
  });

  it('treats exit 1 with transient noise as a failed existence probe, not absence', async () => {
    const runner = new ScriptedRunner('/home/u', [
      [/^test -d /, { stdout: '', stderr: 'kex_exchange_identification: Connection closed by remote host', exitCode: 1 }],
    ]);

    await expect(scriptedStore(runner).ensure()).rejects.toThrow(/Cannot probe workdir/);

    expect(runner.commands.some(c => c.includes('clone'))).toBe(false);
    expect(runner.commands.some(c => c.includes('rm -rf'))).toBe(false);
  });

  it('aborts leftover-dir recovery when rmdir fails at the transport layer', async () => {
    const runner = new ScriptedRunner('/home/u', [
      [/^test -d /, ok],
      [/rev-parse --resolve-git-dir /, { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 }],
      [/rev-parse --show-toplevel/, { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 }],
      [/rmdir /, { stdout: '', stderr: 'ssh: connect to host box-a: Connection timed out', exitCode: 255 }],
    ]);

    await expect(scriptedStore(runner).ensure()).rejects.toThrow(/Cannot probe leftover dir/);

    expect(runner.commands.some(c => c.includes('rm -rf'))).toBe(false);
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
      [/rm -rf /, ok],
    ]);

    await expect(scriptedStore(runner).ensure()).rejects.toThrow(/git clone .* failed/);

    expect(runner.commands.find(c => c.includes('rmdir '))).toBe(
      `${ancestorSymlinkGuard('/home/u', '/home/u/.baxian/agents/dev-1/repo')} && rmdir '/home/u/.baxian/agents/dev-1/repo'`,
    );
    expect(runner.commands.some(c => c.includes('git clone '))).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('removed leftover empty dir'));
  });

  it('tolerates pushurl-unset exit 5 (key absent) and moves on', async () => {
    const runner = new ScriptedRunner('/home/u', [
      [/^test -d /, ok],
      [/rev-parse --resolve-git-dir /, ok],
      [/remote get-url origin/, { stdout: 'git@git.example.com:group/project.git\n', stderr: '', exitCode: 0 }],
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
      [/remote get-url origin/, { stdout: 'git@git.example.com:group/project.git\n', stderr: '', exitCode: 0 }],
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
      [/remote get-url origin/, { stdout: 'git@git.example.com:group/project.git\n', stderr: '', exitCode: 0 }],
      [/--unset-all remote\.origin\.pushurl/, { stdout: '', stderr: 'error: could not lock config file', exitCode: 4 }],
    ]);

    await expect(scriptedStore(runner).ensure()).rejects.toThrow(/Failed to clear remote\.origin\.pushurl/);
  });

  it('aborts when pushurl-unset fails at the transport layer', async () => {
    const runner = new ScriptedRunner('/home/u', [
      [/^test -d /, ok],
      [/rev-parse --resolve-git-dir /, ok],
      [/remote get-url origin/, { stdout: 'git@git.example.com:group/project.git\n', stderr: '', exitCode: 0 }],
      [/--unset-all remote\.origin\.pushurl/, { stdout: '', stderr: 'ssh: connect to host box-a: Connection timed out', exitCode: 255 }],
    ]);

    await expect(scriptedStore(runner).ensure()).rejects.toThrow(/Cannot probe remote\.origin\.pushurl removal/);
  });

  it('validate-stage probes fail closed on transport errors', async () => {
    const runner = new ScriptedRunner('/home/u', [
      [/^test -d /, ok],
      [/rev-parse --resolve-git-dir '[^']*\.git'/, ok],
      [/remote get-url origin/, { stdout: 'https://git.example.com/group/project.git\n', stderr: '', exitCode: 0 }],
      [/rev-parse --show-toplevel/, { stdout: '', stderr: 'ssh: connect to host box-a: Connection timed out', exitCode: 255 }],
    ]);

    await expect(scriptedStore(runner).ensure()).rejects.toThrow(/Cannot probe worktree top/);

    expect(runner.commands.some(c => c.includes('rm -rf'))).toBe(false);
  });

  it('aborts instead of advising manual removal when the git-dir probe fails in transit', async () => {
    const runner = new ScriptedRunner('/home/u', [
      [/^test -d /, ok],
      [/rev-parse --resolve-git-dir /, { stdout: '', stderr: 'ssh: connect to host box-a: Connection timed out', exitCode: 255 }],
    ]);

    await expect(scriptedStore(runner).ensure()).rejects.toThrow(/Cannot probe git dir/);

    expect(runner.commands.some(c => c.includes('rm -rf'))).toBe(false);
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

    expect(runner.commands.some(c => c.includes('rm -rf'))).toBe(false);
  });

  it('fails closed when the bare probe dies in transit instead of advising manual removal', async () => {
    const runner = new ScriptedRunner('/home/u', [
      [/^test -d /, ok],
      [/rev-parse --resolve-git-dir '[^']*\.git'/, { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 }],
      [/rev-parse --show-toplevel/, { stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories)', exitCode: 128 }],
      [/rev-parse --resolve-git-dir /, { stdout: '', stderr: 'Connection reset by peer', exitCode: 255 }],
    ]);

    await expect(scriptedStore(runner).ensure()).rejects.toThrow(/Cannot probe repo layout/);

    expect(runner.commands.some(c => c.includes('rm -rf'))).toBe(false);
  });
});

describe('moveFileIntoPlace (real filesystem)', () => {
  let dir: string;

  beforeEach(async () => {
    // The canonical root guard requires a symlink-free base (macOS tmpdir sits under /var -> /private/var).
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
    await moveFileIntoPlace(local, `${dir}/tmp1`, `${dir}/final`);
    expect(await run(`cat ${shellQuote(`${dir}/final`)}`)).toBe('new');
  });

  it('fails closed before mv when the target is a directory — no nested tmp ever lands', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await run(`mkdir -p ${shellQuote(`${dir}/final`)}`);
    await write(`${dir}/tmp2`, 'payload');

    await expect(moveFileIntoPlace(local, `${dir}/tmp2`, `${dir}/final`)).rejects.toThrow(/atomic replace/);

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

    await expect(moveFileIntoPlace(local, `${dir}/tmp3`, `${dir}/final`)).rejects.toThrow(/atomic replace/);

    expect(await run(`ls -A ${shellQuote(`${dir}/real`)}`)).toBe('');
  });

  it('sweeps a tmp already nested under a directory target', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await run(`mkdir -p ${shellQuote(`${dir}/final`)}`);
    await write(`${dir}/final/tmp4`, 'nested-stray');

    await expect(moveFileIntoPlace(local, `${dir}/tmp4`, `${dir}/final`)).rejects.toThrow(/atomic replace/);

    const nested = await local.exec(`test -e ${shellQuote(`${dir}/final/tmp4`)}`);
    expect(nested.exitCode).toBe(1);
  });

  it('refuses to walk through a symlinked ancestor when guardRoot is set', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await run(`mkdir -p ${shellQuote(`${dir}/outside`)}`);
    await write(`${dir}/outside/keep`, 'safe');
    await symlink(`${dir}/outside`, `${dir}/sub`);
    await write(`${dir}/tmp5`, 'payload');

    await expect(
      moveFileIntoPlace(local, `${dir}/tmp5`, `${dir}/sub/keep`, { guardRoot: dir }),
    ).rejects.toThrow(/atomic replace/);

    expect(await run(`cat ${shellQuote(`${dir}/outside/keep`)}`)).toBe('safe');
  });

  it('refuses when the guard root itself is a symlink — external files stay intact', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await run(`mkdir -p ${shellQuote(`${dir}/outside/.baxian/research`)}`);
    await write(`${dir}/outside/.baxian/research/evidence`, 'precious');
    const rootLink = `${dir}/work`;
    await symlink(`${dir}/outside`, rootLink);
    await write(`${dir}/tmp6`, 'payload');

    await expect(
      moveFileIntoPlace(local, `${dir}/tmp6`, `${rootLink}/.baxian/research/evidence`, { guardRoot: rootLink }),
    ).rejects.toThrow(/atomic replace/);

    expect(await run(`cat ${shellQuote(`${dir}/outside/.baxian/research/evidence`)}`)).toBe('precious');
  });

  it('never sweeps a nested tmp through a symlinked final — foreign same-name files survive', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await run(`mkdir -p ${shellQuote(`${dir}/outside`)}`);
    await write(`${dir}/outside/tmp7`, 'foreign-precious');
    await symlink(`${dir}/outside`, `${dir}/final`);
    await write(`${dir}/tmp7`, 'payload');

    await expect(moveFileIntoPlace(local, `${dir}/tmp7`, `${dir}/final`)).rejects.toThrow(/atomic replace/);

    expect(await run(`cat ${shellQuote(`${dir}/outside/tmp7`)}`)).toBe('foreign-precious');
  });

  it('guarded discard (clone/promote cleanup) refuses to delete through a rebound managed parent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Managed root `dir`; the per-agent parent `dir/agents/a1` is rebound to an external directory
    // that happens to hold a same-named staging dir. The guarded sweep must leave the external file.
    await run(`mkdir -p ${shellQuote(`${dir}/agents`)} ${shellQuote(`${dir}/external/repo.claim-x`)}`);
    await write(`${dir}/external/repo.claim-x/precious`, 'foreign');
    await symlink(`${dir}/external`, `${dir}/agents/a1`);
    const staging = `${dir}/agents/a1/repo.claim-x`; // logical path resolves into the external dir

    await sweepStrayFile(local, staging, ancestorSymlinkGuard(dir, staging));

    // The guard (a1 is a symlink) fails closed → external file survives, and the keep is audited.
    expect(await run(`cat ${shellQuote(`${dir}/external/repo.claim-x/precious`)}`)).toBe('foreign');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('guard refused'));
  });
});

describe('ancestorSymlinkGuard', () => {
  it('proves the root canonical, then one symlink check per component below it', () => {
    expect(ancestorSymlinkGuard('/wt', '/wt/.baxian/review/inbox/f.md')).toBe(
      `[ "$(cd -- '/wt' 2>/dev/null && pwd -P)" = '/wt' ] && [ ! -L '/wt/.baxian' ] && [ ! -L '/wt/.baxian/review' ] && [ ! -L '/wt/.baxian/review/inbox' ] && [ ! -L '/wt/.baxian/review/inbox/f.md' ]`,
    );
  });

  it('rejects targets outside the root', () => {
    expect(() => ancestorSymlinkGuard('/wt', '/elsewhere/f')).toThrow(/is not under/);
  });

  it('keeps "/" as the root for HOME=/ hosts (no cd -- \'\' break, no // in component paths)', () => {
    expect(ancestorSymlinkGuard('/', '/.baxian/agents/dev-1/repo')).toBe(
      `[ "$(cd -- '/' 2>/dev/null && pwd -P)" = '/' ] && [ ! -L '/.baxian' ] && [ ! -L '/.baxian/agents' ] && [ ! -L '/.baxian/agents/dev-1' ] && [ ! -L '/.baxian/agents/dev-1/repo' ]`,
    );
    expect(isUnder('/', '/.baxian/x')).toBe(true);
    expect(isUnder('/', '/')).toBe(false);
  });
});

describe('stageFileGuarded (real filesystem)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'bx-stage-')));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes the tmp when the ancestor chain is clean', async () => {
    await run(`mkdir -p ${shellQuote(`${dir}/sub`)}`);
    await stageFileGuarded(local, dir, `${dir}/sub/.tmp-abc`, 'payload');
    expect(await run(`cat ${shellQuote(`${dir}/sub/.tmp-abc`)}`)).toBe('payload');
  });

  it('refuses to write through a symlinked ancestor — the victim never sees staging bytes', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await run(`mkdir -p ${shellQuote(`${dir}/outside`)}`);
    await run(`printf original > ${shellQuote(`${dir}/outside/victim.baxian-tmp`)}`);
    await symlink(`${dir}/outside`, `${dir}/skills`);

    await expect(
      stageFileGuarded(local, dir, `${dir}/skills/victim.baxian-tmp`, 'attacker-content'),
    ).rejects.toThrow(/staged write/);

    expect(await run(`cat ${shellQuote(`${dir}/outside/victim.baxian-tmp`)}`)).toBe('original');
  });

  it('refuses when the root itself has been swapped for a symlink', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await run(`mkdir -p ${shellQuote(`${dir}/outside/sub`)}`);
    await run(`printf keep > ${shellQuote(`${dir}/outside/sub/f`)}`);
    const rootLink = `${dir}/work`;
    await symlink(`${dir}/outside`, rootLink);

    await expect(
      stageFileGuarded(local, rootLink, `${rootLink}/sub/f`, 'overwrite'),
    ).rejects.toThrow(/staged write/);

    expect(await run(`cat ${shellQuote(`${dir}/outside/sub/f`)}`)).toBe('keep');
  });
});

describe('stageFileGuarded parent directories (real filesystem)', () => {
  it('creates missing parent directories inside the guarded command (fresh skill dirs)', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'bx-stage-mkdir-')));
    try {
      const tmp = `${dir}/.claude/skills/baxian-new/SKILL.md.baxian-tmp-abc123`;
      await stageFileGuarded(local, dir, tmp, 'skill-body');
      expect(await run(`cat ${shellQuote(tmp)}`)).toBe('skill-body');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
