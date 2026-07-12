import { homedir } from 'node:os';
import type { CommandRunner, ExecResult } from './runner.js';
import { shellQuote, hostGroupKey, workdirHostGroupKey } from './runner.js';
import { CLONE_EXEC_TIMEOUT_MS, GIT_NET_ENV, execNetwork } from './net-exec.js';
import type { AgentMode, HostConfig } from '../shared/index.js';
import { isGitHubRepo, normalizeRepoUrl, parseGitRemote, redactGitCredentials, repoSlug } from '../shared/index.js';

export interface RepoStoreCache {
  homes: Map<string, string>;
  mutex: Map<string, Promise<unknown>>;
  lastFetchAt: Map<string, number>;
  owners: Map<string, string>;
}

export function createRepoStoreCache(): RepoStoreCache {
  return { homes: new Map(), mutex: new Map(), lastFetchAt: new Map(), owners: new Map() };
}

const FETCH_THROTTLE_MS = 30_000;
const BAXIAN_RUNTIME_DIRS = [
  '.baxian',
  '.baxian/review',
  '.baxian/review/inbox',
  '.baxian/review-inbox',
] as const;

export async function ensureBaxianRuntimeDirsSafe(
  runner: CommandRunner,
  absRepoPath: string,
): Promise<void> {
  const path = shellQuote(absRepoPath);
  const tracked = await runner.exec(`git -C ${path} ls-files -- .baxian`);
  if (tracked.exitCode !== 0) {
    throw new Error(`Failed to inspect tracked .baxian paths in ${absRepoPath}: ${tracked.stderr}`);
  }
  if (tracked.stdout.trim()) {
    throw new Error(
      `Workdir ${absRepoPath} tracks .baxian paths; baxian runtime files would modify project content.`,
    );
  }

  const dirs = BAXIAN_RUNTIME_DIRS.map(dir => `${absRepoPath}/${dir}`);
  const operands = dirs.map(shellQuote).join(' ');
  const command =
    `for p in ${operands}; do ` +
      `if [ -L "$p" ] || { [ -e "$p" ] && [ ! -d "$p" ]; }; then exit 9; fi; ` +
    `done && mkdir -p ${operands} && ` +
    `for p in ${operands}; do [ -d "$p" ] && [ ! -L "$p" ] || exit 9; done`;
  const result = await runner.exec(`sh -c ${shellQuote(command)}`);
  if (result.exitCode !== 0) {
    throw new Error(
      `Workdir ${absRepoPath} has an unsafe .baxian runtime path; ` +
      `baxian requires real directories contained in the Workdir.`,
    );
  }
}

export class RepoStore {
  private readonly isGitHub: boolean;
  private readonly repo: string;

  constructor(
    private runner: CommandRunner,
    repo: string,
    private mode: AgentMode,
    private host: HostConfig | undefined,
    private cache: RepoStoreCache,
    private agentId: string,
    private configuredWorkdir?: string,
  ) {
    this.repo = repo.trim();
    this.isGitHub = isGitHubRepo(this.repo);
  }

  async ensure(): Promise<string> {
    const absRepoPath = await this.resolveAbsPath();
    const ownerKey = `${this.workdirHostKey()}:${absRepoPath}`;
    const cacheKey = `${this.hostKey()}:${absRepoPath}:${this.agentId}`;
    const owner = this.cache.owners.get(ownerKey);
    if (owner && owner !== this.agentId) {
      throw new Error(
        `Workdir ${absRepoPath} on ${this.hostKey()} is already owned by agent "${owner}"; ` +
        `different agents must not share a directory.`,
      );
    }
    this.cache.owners.set(ownerKey, this.agentId);
    return this.runUnderMutex(cacheKey, async () => {
      const originChanged = await this.cloneIfNeeded(absRepoPath);
      await this.validateClone(absRepoPath);
      await ensureBaxianRuntimeDirsSafe(this.runner, absRepoPath);
      await this.ensureBaxianExcluded(absRepoPath);
      if (originChanged) this.cache.lastFetchAt.delete(cacheKey);
      await this.fetchIfStale(cacheKey, absRepoPath);
      return absRepoPath;
    });
  }

  async refresh(absRepoPath: string): Promise<void> {
    const cacheKey = `${this.hostKey()}:${absRepoPath}:${this.agentId}`;
    await this.runUnderMutex(cacheKey, () => this.fetchIfStale(cacheKey, absRepoPath));
  }

  private hostKey(): string {
    if (this.mode === 'local') return 'local';
    if (!this.host) throw new Error('Remote mode requires host config');
    return hostGroupKey(this.mode, this.host);
  }

  private workdirHostKey(): string {
    if (this.mode === 'local') return 'local';
    if (!this.host) throw new Error('Remote mode requires host config');
    return workdirHostGroupKey(this.mode, this.host);
  }

  private async resolveAbsPath(): Promise<string> {
    if (this.configuredWorkdir) {
      if (!this.configuredWorkdir.startsWith('/')) {
        throw new Error(`Workdir must be an absolute path: ${this.configuredWorkdir}`);
      }
      const result = await this.runner.exec(
        `cd ${shellQuote(this.configuredWorkdir)} 2>/dev/null && pwd -P`,
      );
      if (result.exitCode !== 0 || result.stdout.trim() === '') {
        throw new Error(
          `Configured Workdir ${this.configuredWorkdir} does not exist or is not accessible; ` +
          `baxian never creates a user-specified Workdir implicitly.`,
        );
      }
      return result.stdout.trim();
    }
    const home = await this.resolveHome();
    return `${home}/.baxian/agents/${this.agentId}/repo`;
  }

  private async resolveHome(): Promise<string> {
    const key = this.hostKey();
    if (this.mode === 'local') {
      const cached = this.cache.homes.get(key);
      if (cached) return cached;
      const result = await this.runner.exec(`cd ${shellQuote(homedir())} && pwd -P`);
      if (result.exitCode !== 0 || !result.stdout.trim()) {
        throw new Error(`Failed to canonicalize local home ${homedir()}: ${result.stderr}`);
      }
      const home = result.stdout.trim();
      this.cache.homes.set(key, home);
      return home;
    }
    const cached = this.cache.homes.get(key);
    if (cached) return cached;
    const result = await this.runner.exec('printf %s "$HOME"');
    if (result.exitCode !== 0 || !result.stdout) {
      throw new Error(`Failed to resolve $HOME on ${key}: ${result.stderr}`);
    }
    const canonical = await this.runner.exec(`cd ${shellQuote(result.stdout.trim())} && pwd -P`);
    if (canonical.exitCode !== 0 || !canonical.stdout.trim()) {
      throw new Error(`Failed to canonicalize $HOME on ${key}: ${canonical.stderr}`);
    }
    const home = canonical.stdout.trim();
    this.cache.homes.set(key, home);
    return home;
  }

  private async cloneIfNeeded(absRepoPath: string): Promise<boolean> {
    const dirExists = (await this.runner.exec(`test -d ${shellQuote(absRepoPath)}`)).exitCode === 0;

    if (!dirExists) {
      if (this.configuredWorkdir) {
        throw new Error(
          `Configured Workdir ${absRepoPath} does not exist; ` +
          `baxian never creates a user-specified Workdir implicitly.`,
        );
      }
      const parent = absRepoPath.replace(/\/[^/]+$/, '');
      const mk = await this.runner.exec(`mkdir -p ${shellQuote(parent)}`);
      if (mk.exitCode !== 0) throw new Error(`Failed to mkdir ${parent}: ${mk.stderr}`);
      const cloneCmd = this.isGitHub
        ? `${GIT_NET_ENV} gh repo clone ${shellQuote(repoSlug(this.repo))} ${shellQuote(absRepoPath)} --no-upstream`
        : `${GIT_NET_ENV} git clone ${shellQuote(this.repo)} ${shellQuote(absRepoPath)}`;
      let clone: ExecResult;
      try {
        clone = await execNetwork(this.runner, cloneCmd, {
          timeout: CLONE_EXEC_TIMEOUT_MS,
          retries: 0,
        });
      } catch (err) {
        await this.removeCloneRemnant(absRepoPath);
        throw err;
      }
      if (clone.exitCode !== 0) {
        await this.removeCloneRemnant(absRepoPath);
        const cmd = this.isGitHub ? 'gh repo clone' : 'git clone';
        throw new Error(redactGitCredentials(`${cmd} ${this.repo} failed: ${clone.stderr || clone.stdout}`));
      }
      if (this.isGitHub && parseGitRemote(this.repo) !== null) {
        return this.syncMatchingOriginUrl(absRepoPath);
      }
      return false;
    }

    const isRepo = (await this.runner.exec(
      `git rev-parse --resolve-git-dir ${shellQuote(`${absRepoPath}/.git`)}`,
    )).exitCode === 0;
    if (!isRepo) {
      const discovered = await this.runner.exec(
        `git -C ${shellQuote(absRepoPath)} rev-parse --show-toplevel`,
      );
      if (discovered.exitCode === 0) {
        throw new Error(
          `Workdir ${absRepoPath} must be the repository's exact top-level directory, not a subdirectory.`,
        );
      }
      const bare = await this.runner.exec(
        `git rev-parse --resolve-git-dir ${shellQuote(absRepoPath)}`,
      );
      if (bare.exitCode === 0) {
        throw new Error(`Workdir ${absRepoPath} must be a non-bare Git clone.`);
      }
      throw new Error(
        `${absRepoPath} exists but is not a git repository. Remove it manually or change project.repo.`,
      );
    }

    return this.syncMatchingOriginUrl(absRepoPath);
  }

  private async validateClone(absRepoPath: string): Promise<void> {
    const path = shellQuote(absRepoPath);
    const top = await this.runner.exec(`git -C ${path} rev-parse --show-toplevel`);
    if (top.exitCode !== 0 || top.stdout.trim() === '') {
      throw new Error(`${absRepoPath} is not a working-tree Git repository.`);
    }
    const canonicalTop = await this.runner.exec(`cd ${shellQuote(top.stdout.trim())} && pwd -P`);
    if (canonicalTop.exitCode !== 0 || canonicalTop.stdout.trim() !== absRepoPath) {
      throw new Error(
        `Workdir ${absRepoPath} must be the repository's exact top-level directory, not a subdirectory.`,
      );
    }
    const bare = await this.runner.exec(`git -C ${path} rev-parse --is-bare-repository`);
    if (bare.exitCode !== 0 || bare.stdout.trim() !== 'false') {
      throw new Error(`Workdir ${absRepoPath} must be a non-bare Git clone.`);
    }
    const independent = await this.runner.exec(
      `test -d ${shellQuote(`${absRepoPath}/.git`)} && ` +
      `test "$(git -C ${path} rev-parse --git-common-dir)" = .git && ` +
      `test ! -s ${shellQuote(`${absRepoPath}/.git/objects/info/alternates`)}`,
    );
    if (independent.exitCode !== 0) {
      throw new Error(
        `Workdir ${absRepoPath} must be an independent ordinary clone, not a linked worktree or alternates-based clone.`,
      );
    }
    const writable = await this.runner.exec(`test -r ${path} -a -w ${path} -a -x ${path}`);
    if (writable.exitCode !== 0) {
      throw new Error(`Workdir ${absRepoPath} is not readable and writable by the agent host user.`);
    }
    const metadata = await this.runner.exec(`git -C ${path} rev-parse --git-dir HEAD >/dev/null`);
    if (metadata.exitCode !== 0) {
      throw new Error(`Workdir ${absRepoPath} has unreadable Git metadata or HEAD.`);
    }
    const remoteRefs = await this.runner.exec(
      `git -C ${path} for-each-ref --format=${shellQuote('%(refname)')} --count=1 refs/remotes/`,
    );
    if (remoteRefs.exitCode !== 0 || remoteRefs.stdout.trim() === '') {
      throw new Error(`Workdir ${absRepoPath} has no readable remote-tracking refs.`);
    }
  }

  private async ensureBaxianExcluded(absRepoPath: string): Promise<void> {
    const path = shellQuote(absRepoPath);
    const command =
      `cd ${path} && p="$(git rev-parse --git-path info/exclude)" && ` +
      `mkdir -p "$(dirname "$p")" && ` +
      `{ grep -qxF '.baxian/' "$p" 2>/dev/null || printf '%s\\n' '.baxian/' >> "$p"; } && ` +
      `git check-ignore -q -- .baxian/__probe__`;
    const excluded = await this.runner.exec(`sh -c ${shellQuote(command)}`);
    if (excluded.exitCode !== 0) {
      throw new Error(`Failed to make .baxian runtime files invisible to Git in ${absRepoPath}.`);
    }
  }

  private async syncMatchingOriginUrl(absRepoPath: string): Promise<boolean> {
    const originResult = await this.runner.exec(
      `git -C ${shellQuote(absRepoPath)} remote get-url origin`,
    );
    if (originResult.exitCode !== 0) {
      throw new Error(`Failed to read origin URL at ${absRepoPath}: ${originResult.stderr}`);
    }
    const originUrl = originResult.stdout.trim();
    if (!this.originMatches(originUrl)) {
      throw new Error(redactGitCredentials(
        `Existing repo at ${absRepoPath} has origin "${originUrl}" which does not match project.repo "${this.repo}". Remove the directory or change project.repo.`,
      ));
    }
    if (this.configuredWorkdir) return false;
    return this.syncOriginUrl(absRepoPath, originUrl);
  }

  private async syncOriginUrl(absRepoPath: string, originUrl: string): Promise<boolean> {
    if (parseGitRemote(this.repo) === null) return false;
    if (!accessMethodDiffers(this.repo, originUrl)) return false;
    const result = await this.runner.exec(
      `git -C ${shellQuote(absRepoPath)} config --replace-all remote.origin.url ${shellQuote(this.repo)}`,
    );
    if (result.exitCode !== 0) {
      throw new Error(redactGitCredentials(
        `Failed to update origin URL at ${absRepoPath}: ${result.stderr}`,
      ));
    }
    await this.runner.exec(
      `git -C ${shellQuote(absRepoPath)} config --unset-all remote.origin.pushurl`,
    );
    return true;
  }

  private originMatches(originUrl: string): boolean {
    if (this.isGitHub) {
      return normalizeRepoUrl(originUrl)?.toLowerCase() === repoSlug(this.repo).toLowerCase();
    }
    const want = parseGitRemote(this.repo);
    const got = parseGitRemote(originUrl);
    return want !== null && got !== null && want.host === got.host && want.path === got.path;
  }

  // A clone killed by the exec timeout dies mid-transfer and leaves a partial
  // directory that the next ensure() would reject as "not a git repository".
  private async removeCloneRemnant(absRepoPath: string): Promise<void> {
    await this.runner.exec(`rm -rf ${shellQuote(absRepoPath)}`).catch(() => undefined);
  }

  private async fetchIfStale(cacheKey: string, absRepoPath: string): Promise<void> {
    const last = this.cache.lastFetchAt.get(cacheKey) ?? 0;
    if (Date.now() - last < FETCH_THROTTLE_MS) return;
    const result = await execNetwork(
      this.runner,
      `cd ${shellQuote(absRepoPath)} && ${GIT_NET_ENV} git fetch --all --prune && git remote set-head origin --auto`,
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `git fetch failed or origin/HEAD could not be refreshed at ${absRepoPath}: ${result.stderr}`,
      );
    }
    this.cache.lastFetchAt.set(cacheKey, Date.now());
  }

  private async runUnderMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.cache.mutex.get(key) ?? Promise.resolve();
    const cur = prev.then(fn, fn);
    const settled = cur.then(() => undefined, () => undefined);
    this.cache.mutex.set(key, settled);
    void settled.finally(() => {
      if (this.cache.mutex.get(key) === settled) this.cache.mutex.delete(key);
    });
    return cur;
  }
}

function urlScheme(url: string): string {
  if (/^https:\/\//i.test(url)) return 'https';
  if (/^http:\/\//i.test(url)) return 'http';
  if (/^ssh:\/\//i.test(url)) return 'ssh';
  if (/^[^@/\s]+@[^:/\s]+:/.test(url)) return 'ssh';
  return '';
}

function urlUser(url: string): string {
  const proto = url.match(/^(?:ssh|https?):\/\/([^@/]+)@/);
  if (proto) return proto[1];
  const scp = url.match(/^([^@/\s]+)@[^:/\s]+:/);
  if (scp) return scp[1];
  return '';
}

export function accessMethodDiffers(a: string, b: string): boolean {
  return urlScheme(a) !== urlScheme(b) || urlUser(a) !== urlUser(b);
}
