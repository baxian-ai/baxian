import { describe, it, expect, vi, beforeEach } from 'vitest';
import { homedir } from 'node:os';
import { RepoStore, createRepoStoreCache, nonGitHubSubpath, accessMethodDiffers, type RepoStoreCache } from '../../src/agent/repo-store.js';
import { shellQuote, type CommandRunner, type ExecResult } from '../../src/agent/runner.js';

type ExecMock = ReturnType<typeof vi.fn<(cmd: string) => Promise<ExecResult>>>;

function makeRunner(handler: (cmd: string) => ExecResult): CommandRunner & { exec: ExecMock } {
  return { exec: vi.fn(async (cmd: string) => handler(cmd)) };
}

const OK: ExecResult = { stdout: '', stderr: '', exitCode: 0 };
const FAIL: ExecResult = { stdout: '', stderr: 'fail', exitCode: 1 };

function originStdout(url: string): ExecResult {
  return { stdout: `${url}\n`, stderr: '', exitCode: 0 };
}

function existingOrigin(originUrl: string): (cmd: string) => ExecResult {
  return cmd => {
    if (cmd.includes('test -d')) return OK;
    if (cmd.includes('remote get-url origin')) return originStdout(originUrl);
    if (cmd.includes('config --replace-all')) return OK;
    if (cmd.includes('config --unset-all')) return OK;
    if (cmd.includes('git fetch')) return OK;
    return FAIL;
  };
}

const GH_ORIGIN = 'https://github.com/user/repo.git';
const fetchCount = (runner: { exec: ExecMock }): number =>
  runner.exec.mock.calls.filter(c => c[0].includes('git fetch')).length;

function existingGitHubOriginAllOk(cmd: string): ExecResult {
  if (cmd.includes('remote get-url origin')) return originStdout(GH_ORIGIN);
  return OK;
}

describe('RepoStore.ensure (clone path)', () => {
  let cache: RepoStoreCache;
  beforeEach(() => { cache = createRepoStoreCache(); });

  it('clones with gh repo clone --no-upstream when neither dir nor .git exists', async () => {
    const runner = makeRunner(cmd => {
      if (cmd.includes('test -d')) return FAIL;
      if (cmd.startsWith('mkdir -p ')) return OK;
      if (cmd.includes('gh repo clone')) return OK;
      if (cmd.includes('git fetch')) return OK;
      if (cmd.includes('git remote set-head')) return OK;
      return FAIL;
    });
    const store = new RepoStore(runner, 'user/repo', 'local', undefined, cache);
    const path = await store.ensure();
    expect(path).toBe(`${homedir()}/.baxian/repos/user/repo`);
    const cmds = runner.exec.mock.calls.map(c => c[0]);
    expect(cmds.some(c => c.includes('gh repo clone') && c.includes('user/repo') && c.includes('--no-upstream'))).toBe(true);
    expect(cmds.some(c => /gh repo clone .+ -- /.test(c))).toBe(false);
    expect(cmds.some(c => c.includes('remote get-url origin'))).toBe(false);
  });

  it('syncs origin immediately when a full GitHub URL is cloned through gh', async () => {
    const runner = makeRunner(cmd => {
      if (cmd.includes('test -d')) return FAIL;
      if (cmd.startsWith('mkdir -p ')) return OK;
      if (cmd.includes('gh repo clone')) return OK;
      if (cmd.includes('remote get-url origin')) {
        return { stdout: 'https://github.com/user/repo.git\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('config --replace-all')) return OK;
      if (cmd.includes('config --unset-all')) return OK;
      if (cmd.includes('git fetch')) return OK;
      return FAIL;
    });
    const store = new RepoStore(runner, 'git@github.com:user/repo.git', 'local', undefined, cache);
    await store.ensure();
    const cmds = runner.exec.mock.calls.map(c => c[0]);
    expect(cmds.some(c => c.includes('gh repo clone') && c.includes('user/repo'))).toBe(true);
    const replaceCmd = cmds.find(c => c.includes('config --replace-all remote.origin.url'));
    expect(replaceCmd).toContain('git@github.com:user/repo.git');
    expect(cmds.some(c => c.includes('config --unset-all remote.origin.pushurl'))).toBe(true);
    expect(cmds.some(c => c.includes('git fetch'))).toBe(true);
  });

  it('rejects a mismatched origin immediately after a full GitHub URL clone', async () => {
    const runner = makeRunner(cmd => {
      if (cmd.includes('test -d')) return FAIL;
      if (cmd.startsWith('mkdir -p ')) return OK;
      if (cmd.includes('gh repo clone')) return OK;
      if (cmd.includes('remote get-url origin')) {
        return { stdout: 'https://github.com/other/repo.git\n', stderr: '', exitCode: 0 };
      }
      return FAIL;
    });
    const store = new RepoStore(runner, 'git@github.com:user/repo.git', 'local', undefined, cache);
    await expect(store.ensure()).rejects.toThrow(/does not match/i);
    const cmds = runner.exec.mock.calls.map(c => c[0]);
    expect(cmds.some(c => c.includes('git fetch'))).toBe(false);
  });

  it('skips clone when dir + .git both exist and origin matches', async () => {
    const runner = makeRunner(cmd => {
      if (cmd.includes('test -d')) return OK;
      if (cmd.includes('git -C') && cmd.includes('remote get-url origin')) {
        return { stdout: 'https://github.com/user/repo.git\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('git fetch')) return OK;
      if (cmd.includes('git remote set-head')) return OK;
      return FAIL;
    });
    const store = new RepoStore(runner, 'user/repo', 'local', undefined, cache);
    await store.ensure();
    const cmds = runner.exec.mock.calls.map(c => c[0]);
    expect(cmds.some(c => c.includes('gh repo clone'))).toBe(false);
  });

  it('throws when origin URL does not match repoSlug', async () => {
    const runner = makeRunner(cmd => {
      if (cmd.includes('test -d')) return OK;
      if (cmd.includes('remote get-url origin')) {
        return { stdout: 'https://github.com/other/different.git\n', stderr: '', exitCode: 0 };
      }
      return FAIL;
    });
    const store = new RepoStore(runner, 'user/repo', 'local', undefined, cache);
    await expect(store.ensure()).rejects.toThrow(/origin.*does not match|mismatch/i);
  });

  it('accepts case-insensitive slug match (GitHub repo names are case-insensitive)', async () => {
    const runner = makeRunner(existingOrigin(GH_ORIGIN));
    const store = new RepoStore(runner, 'User/Repo', 'local', undefined, cache);
    const path = await store.ensure();
    expect(path).toBe(`${homedir()}/.baxian/repos/user/repo`);
  });

  it('updates origin when GitHub config is a full SSH URL but clone uses HTTPS', async () => {
    const runner = makeRunner(existingOrigin(GH_ORIGIN));
    const store = new RepoStore(runner, 'git@github.com:user/repo.git', 'local', undefined, cache);
    await store.ensure();
    const cmds = runner.exec.mock.calls.map(c => c[0]);
    const replaceCmd = cmds.find(c => c.includes('config --replace-all remote.origin.url'));
    expect(replaceCmd).toContain('git@github.com:user/repo.git');
    expect(cmds.some(c => c.includes('config --unset-all remote.origin.pushurl'))).toBe(true);
  });

  it('does not update origin when GitHub config is a bare slug', async () => {
    const runner = makeRunner(existingOrigin(GH_ORIGIN));
    const store = new RepoStore(runner, 'user/repo', 'local', undefined, cache);
    await store.ensure();
    const cmds = runner.exec.mock.calls.map(c => c[0]);
    expect(cmds.some(c => c.includes('config --replace-all remote.origin.url'))).toBe(false);
  });

  it('throws when dir exists but .git does not (unsafe to overwrite)', async () => {
    const runner = makeRunner(cmd => {
      if (cmd.endsWith(`test -d ${shellQuote(`${homedir()}/.baxian/repos/user/repo/.git`)}`)) return FAIL;
      if (cmd.includes('test -d')) return OK;
      return FAIL;
    });
    const store = new RepoStore(runner, 'user/repo', 'local', undefined, cache);
    await expect(store.ensure()).rejects.toThrow(/not a git|exists.*not.*git/i);
  });
});

describe('RepoStore.refresh — throttle', () => {
  let cache: RepoStoreCache;
  beforeEach(() => { cache = createRepoStoreCache(); });

  it('skips fetch when called within 30s of last fetch', async () => {
    const runner = makeRunner(existingGitHubOriginAllOk);
    const store = new RepoStore(runner, 'user/repo', 'local', undefined, cache);
    const absPath = await store.ensure();
    const fetchCallsBefore = fetchCount(runner);
    await store.refresh(absPath);
    expect(fetchCount(runner)).toBe(fetchCallsBefore);
  });

  it('refetches once throttle window passes', async () => {
    const runner = makeRunner(existingGitHubOriginAllOk);
    const store = new RepoStore(runner, 'user/repo', 'local', undefined, cache);
    const absPath = await store.ensure();
    const before = fetchCount(runner);
    cache.lastFetchAt.set(`local:${absPath}`, Date.now() - 31_000);
    await store.refresh(absPath);
    expect(fetchCount(runner)).toBe(before + 1);
  });

  it('fetch command pairs set-head with || true so empty repos do not block ensure', async () => {
    const runner = makeRunner(cmd => {
      if (cmd.includes('test -d')) return FAIL;
      if (cmd.startsWith('mkdir -p ')) return OK;
      if (cmd.includes('gh repo clone')) return OK;
      return OK;
    });
    const store = new RepoStore(runner, 'user/repo', 'local', undefined, cache);
    await store.ensure();
    const fetchCmd = runner.exec.mock.calls.map(c => c[0]).find(c => c.includes('git fetch'));
    expect(fetchCmd).toContain('git fetch --all --prune');
    expect(fetchCmd).toContain('git remote set-head origin --auto || true');
  });
});

describe('RepoStore — mutex serialization', () => {
  it('two concurrent ensure() calls on same (host, repo) run sequentially', async () => {
    const cache = createRepoStoreCache();
    let running = 0;
    let maxRunning = 0;
    const runner = makeRunner(_cmd => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      const result: ExecResult = { stdout: 'https://github.com/user/repo.git\n', stderr: '', exitCode: 0 };
      queueMicrotask(() => { running--; });
      return result;
    });
    const store1 = new RepoStore(runner, 'user/repo', 'local', undefined, cache);
    const store2 = new RepoStore(runner, 'user/repo', 'local', undefined, cache);
    await Promise.all([store1.ensure(), store2.ensure()]);
    expect(maxRunning).toBeLessThanOrEqual(1);
  });
});

describe('RepoStore — hostKey isolation', () => {
  type Host = ConstructorParameters<typeof RepoStore>[3];
  it.each<{ name: string; homeKeys: string[]; first: ['local' | 'remote', Host]; second: ['local' | 'remote', Host] }>([
    {
      name: 'local and remote with same $HOME do NOT share fetch throttle',
      homeKeys: ['remote:rock@host:default'],
      first: ['local', undefined],
      second: ['remote', { hostname: 'host', user: 'rock' }],
    },
    {
      name: 'local mode and remote mode with hostname literally "local" do NOT share cache',
      homeKeys: ['remote:local:default'],
      first: ['local', undefined],
      second: ['remote', { hostname: 'local' }],
    },
    {
      name: 'same hostname/user on different ports do NOT share fetch throttle (port in hostKey)',
      homeKeys: ['remote:u@h:22', 'remote:u@h:2222'],
      first: ['remote', { hostname: 'h', user: 'u', port: 22 }],
      second: ['remote', { hostname: 'h', user: 'u', port: 2222 }],
    },
    {
      name: 'inline host without a port (:default) does NOT share cache with an explicit-22 registry host',
      homeKeys: ['remote:u@h:default', 'remote:u@h:22'],
      first: ['remote', { hostname: 'h', user: 'u' }],
      second: ['remote', { hostname: 'h', user: 'u', port: 22 }],
    },
  ])('$name', async ({ homeKeys, first, second }) => {
    const cache = createRepoStoreCache();
    for (const key of homeKeys) cache.homes.set(key, homedir());

    const firstRunner = makeRunner(existingGitHubOriginAllOk);
    const secondRunner = makeRunner(existingGitHubOriginAllOk);
    const firstStore = new RepoStore(firstRunner, 'user/repo', first[0], first[1], cache);
    const secondStore = new RepoStore(secondRunner, 'user/repo', second[0], second[1], cache);

    await firstStore.ensure();
    await secondStore.ensure();

    expect(fetchCount(secondRunner)).toBeGreaterThanOrEqual(1);
  });
});

describe('RepoStore.ensure — non-GitHub (generic git) repos', () => {
  let cache: RepoStoreCache;
  beforeEach(() => { cache = createRepoStoreCache(); });

  it('clones with plain `git clone` at repos-ext/<host>/<path> (case-preserved path)', async () => {
    const url = 'https://gitlab.example.com/Group/Sub/Proj.git';
    const runner = makeRunner(cmd => {
      if (cmd.includes('test -d')) return FAIL;
      if (cmd.startsWith('mkdir -p ')) return OK;
      if (cmd.includes('git clone')) return OK;
      if (cmd.includes('git fetch')) return OK;
      if (cmd.includes('git remote set-head')) return OK;
      return FAIL;
    });
    const store = new RepoStore(runner, url, 'local', undefined, cache);
    const path = await store.ensure();
    expect(path).toBe(`${homedir()}/.baxian/repos-ext/gitlab.example.com/Group/Sub/Proj`);
    const cmds = runner.exec.mock.calls.map(c => c[0]);
    expect(cmds.some(c => c.includes('git clone') && c.includes(url))).toBe(true);
    expect(cmds.some(c => c.includes('gh repo clone'))).toBe(false);
  });

  it('sanitizes ":" to "_" for a non-default-port host dir', async () => {
    const url = 'https://gitlab.example.com:8443/group/proj.git';
    const runner = makeRunner(cmd => {
      if (cmd.includes('test -d')) return FAIL;
      if (cmd.startsWith('mkdir -p ')) return OK;
      return OK;
    });
    const store = new RepoStore(runner, url, 'local', undefined, cache);
    const path = await store.ensure();
    expect(path).toBe(`${homedir()}/.baxian/repos-ext/gitlab.example.com_8443/group/proj`);
  });

  it('origin matches by host (case-insensitive) + path (case-sensitive) — no sync for cosmetic difference', async () => {
    const url = 'https://gitlab.example.com/Group/Proj.git';
    const runner = makeRunner(cmd => {
      if (cmd.includes('test -d')) return OK;
      if (cmd.includes('remote get-url origin')) {
        return { stdout: 'https://GITLAB.example.com/Group/Proj.git\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('git fetch')) return OK;
      return FAIL;
    });
    const store = new RepoStore(runner, url, 'local', undefined, cache);
    await store.ensure();
    const cmds = runner.exec.mock.calls.map(c => c[0]);
    expect(cmds.some(c => c.includes('git clone'))).toBe(false);
    expect(cmds.some(c => c.includes('config --replace-all remote.origin.url'))).toBe(false);
  });

  it('rejects an origin that differs only by path case (generic remotes are case-sensitive)', async () => {
    const url = 'https://gitlab.example.com/Group/Proj.git';
    const runner = makeRunner(cmd => {
      if (cmd.includes('test -d')) return OK;
      if (cmd.includes('remote get-url origin')) {
        return { stdout: 'https://gitlab.example.com/group/proj.git\n', stderr: '', exitCode: 0 };
      }
      return FAIL;
    });
    const store = new RepoStore(runner, url, 'local', undefined, cache);
    await expect(store.ensure()).rejects.toThrow(/does not match/i);
  });

  it('does not leak embedded credentials into the local clone path', async () => {
    const url = 'https://oauth2:TOKEN@gitlab.example.com/group/proj.git';
    const runner = makeRunner(cmd => {
      if (cmd.includes('test -d')) return FAIL;
      if (cmd.startsWith('mkdir -p ')) return OK;
      return OK;
    });
    const store = new RepoStore(runner, url, 'local', undefined, cache);
    const path = await store.ensure();
    expect(path).toBe(`${homedir()}/.baxian/repos-ext/gitlab.example.com/group/proj`);
    expect(path).not.toContain('TOKEN');
  });

  it('redacts embedded credentials from a clone failure message (repo + git stderr)', async () => {
    const url = 'https://oauth2:SECRETTOKEN@gitlab.example.com/group/proj.git';
    const runner = makeRunner(cmd => {
      if (cmd.includes('test -d')) return FAIL;
      if (cmd.startsWith('mkdir -p ')) return OK;
      if (cmd.includes('git clone')) return {
        stdout: '',
        stderr: "fatal: Authentication failed for 'https://oauth2:SECRETTOKEN@gitlab.example.com/group/proj.git/'",
        exitCode: 128,
      };
      return FAIL;
    });
    const store = new RepoStore(runner, url, 'local', undefined, cache);
    const err = await store.ensure().then(() => null, (e: Error) => e.message);
    expect(err).toBeTruthy();
    expect(err).not.toContain('SECRETTOKEN');
    expect(err).toContain('gitlab.example.com');
  });

  it('updates origin when access method changes (https→ssh)', async () => {
    const runner = makeRunner(existingOrigin('https://gitlab.example.com/group/proj.git'));
    const store = new RepoStore(runner, 'ssh://git@gitlab.example.com/group/proj.git', 'local', undefined, cache);
    await store.ensure();
    const cmds = runner.exec.mock.calls.map(c => c[0]);
    const replaceCmd = cmds.find(c => c.includes('config --replace-all remote.origin.url'));
    expect(replaceCmd).toContain('ssh://git@gitlab.example.com/group/proj.git');
    expect(cmds.some(c => c.includes('config --unset-all remote.origin.pushurl'))).toBe(true);
  });

  it('skips sync when origin already matches the configured URL', async () => {
    const url = 'https://gitlab.example.com/group/proj.git';
    const runner = makeRunner(existingOrigin(url));
    const store = new RepoStore(runner, url, 'local', undefined, cache);
    await store.ensure();
    const cmds = runner.exec.mock.calls.map(c => c[0]);
    expect(cmds.some(c => c.includes('config --replace-all remote.origin.url'))).toBe(false);
  });

  it('redacts credentials in sync failure message', async () => {
    const url = 'https://oauth2:SECRETTOKEN@gitlab.example.com/group/proj.git';
    const runner = makeRunner(cmd => {
      if (cmd.includes('test -d')) return OK;
      if (cmd.includes('remote get-url origin')) {
        return { stdout: 'https://gitlab.example.com/group/proj.git\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('config --replace-all remote.origin.url')) return {
        stdout: '', stderr: 'error: could not set url', exitCode: 1,
      };
      return FAIL;
    });
    const store = new RepoStore(runner, url, 'local', undefined, cache);
    const err = await store.ensure().then(() => null, (e: Error) => e.message);
    expect(err).toBeTruthy();
    expect(err).not.toContain('SECRETTOKEN');
  });

  it('trims a whitespace-padded repo URL before cloning', async () => {
    const url = '  https://gitlab.example.com/group/proj.git  ';
    const runner = makeRunner(cmd => {
      if (cmd.includes('test -d')) return FAIL;
      if (cmd.startsWith('mkdir -p ')) return OK;
      return OK;
    });
    const store = new RepoStore(runner, url, 'local', undefined, cache);
    const path = await store.ensure();
    expect(path).toBe(`${homedir()}/.baxian/repos-ext/gitlab.example.com/group/proj`);
    const cloneCmd = runner.exec.mock.calls.map(c => c[0]).find(c => c.includes('git clone'));
    expect(cloneCmd).toContain("git clone 'https://gitlab.example.com/group/proj.git'");
  });

  it('skips sync for cosmetic .git suffix difference (same access method)', async () => {
    const runner = makeRunner(existingOrigin('https://gitlab.example.com/group/proj.git'));
    const store = new RepoStore(runner, 'https://gitlab.example.com/group/proj', 'local', undefined, cache);
    await store.ensure();
    const cmds = runner.exec.mock.calls.map(c => c[0]);
    expect(cmds.some(c => c.includes('config --replace-all remote.origin.url'))).toBe(false);
    expect(cmds.some(c => c.includes('config --unset-all'))).toBe(false);
  });

  it('clears fetch throttle when origin URL changes so new URL is validated immediately', async () => {
    const runner = makeRunner(existingOrigin('https://gitlab.example.com/group/proj.git'));
    const absPath = `${homedir()}/.baxian/repos-ext/gitlab.example.com/group/proj`;
    const cacheKey = `local:${absPath}`;
    cache.lastFetchAt.set(cacheKey, Date.now());
    const store = new RepoStore(runner, 'ssh://git@gitlab.example.com/group/proj.git', 'local', undefined, cache);
    await store.ensure();
    expect(fetchCount(runner)).toBeGreaterThanOrEqual(1);
  });
});

describe('nonGitHubSubpath', () => {
  it('builds repos-ext/<host>/<path> with the port sanitized', () => {
    expect(nonGitHubSubpath('https://gitlab.example.com:8443/g/p.git'))
      .toBe('repos-ext/gitlab.example.com_8443/g/p');
  });

  it('refuses path-traversal / empty segments (defense-in-depth)', () => {
    expect(() => nonGitHubSubpath('https://gitlab.example.com/group/../proj.git')).toThrow(/unsafe path/i);
    expect(() => nonGitHubSubpath('https://gitlab.example.com/group//proj')).toThrow(/unsafe path/i);
  });

  it('refuses an unsafe host (traversal / shell metacharacters) — defense-in-depth', () => {
    expect(() => nonGitHubSubpath('https://../group/proj.git')).toThrow(/unsafe host/i);
    expect(() => nonGitHubSubpath('https://gitlab.example.com;touch x/g/p.git')).toThrow(/unsafe host/i);
    expect(() => nonGitHubSubpath('https://gitlab.example.com$(id)/g/p.git')).toThrow(/unsafe host/i);
  });
});

describe('accessMethodDiffers', () => {
  it.each<[string, string, string, boolean]>([
    ['detects https↔ssh scheme change', 'https://gitlab.example.com/g/p.git', 'ssh://git@gitlab.example.com/g/p.git', true],
    ['detects https↔scp scheme change', 'https://gitlab.example.com/g/p.git', 'git@gitlab.example.com:g/p.git', true],
    ['detects ssh user change', 'ssh://git@host/g/p.git', 'ssh://deploy@host/g/p.git', true],
    ['detects userinfo addition (https with token)', 'https://oauth2:token@host/g/p.git', 'https://host/g/p.git', true],
    ['returns false for .git suffix difference', 'https://host/g/p.git', 'https://host/g/p', false],
    ['returns false for host case difference', 'https://HOST.example.com/g/p.git', 'https://host.example.com/g/p.git', false],
    ['returns false for scp↔ssh URL with same user (both are SSH)', 'git@gitlab.example.com:group/proj.git', 'ssh://git@gitlab.example.com/group/proj.git', false],
    ['returns false for identical URLs', 'https://host/g/p.git', 'https://host/g/p.git', false],
  ])('%s', (_name, a, b, expected) => {
    expect(accessMethodDiffers(a, b)).toBe(expected);
  });
});

describe('syncOriginUrl — real git integration', () => {
  it('replaces origin URL including multi-URL and insteadOf scenarios', async () => {
    const { execSync } = await import('node:child_process');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    const tmp = mkdtempSync(join(tmpdir(), 'repo-store-'));
    try {
      const run = (cmd: string) => execSync(cmd, { cwd: tmp, encoding: 'utf8', stdio: 'pipe' });
      run('git init bare.git --bare');
      run(`git clone bare.git work`);
      const work = join(tmp, 'work');
      const runW = (cmd: string) => execSync(cmd, { cwd: work, encoding: 'utf8', stdio: 'pipe' });

      runW('git remote set-url --add origin https://backup.example.com/proj.git');
      runW(`git remote set-url --push origin ${join(tmp, 'bare.git')}`);
      runW('git remote set-url --push --add origin https://push-backup.example.com/proj.git');

      const newUrl = 'ssh://git@gitlab.example.com/group/proj.git';
      runW(`git config --replace-all remote.origin.url '${newUrl}'`);
      try { runW('git config --unset-all remote.origin.pushurl'); } catch { }

      const fetchUrl = runW('git remote get-url origin').trim();
      const pushUrl = runW('git remote get-url --push origin').trim();
      const allFetch = runW('git remote get-url --all origin').trim().split('\n');

      expect(fetchUrl).toBe(newUrl);
      expect(pushUrl).toBe(newUrl);
      expect(allFetch).toEqual([newUrl]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
