import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lstat, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RepoStore,
  accessMethodDiffers,
  createRepoStoreCache,
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
});

describe('accessMethodDiffers', () => {
  it('distinguishes HTTPS and SSH while treating equivalent SSH forms alike', () => {
    expect(accessMethodDiffers('https://git.example.com/g/p.git', 'git@git.example.com:g/p.git')).toBe(true);
    expect(accessMethodDiffers('ssh://git@git.example.com/g/p.git', 'git@git.example.com:g/p.git')).toBe(false);
  });
});
