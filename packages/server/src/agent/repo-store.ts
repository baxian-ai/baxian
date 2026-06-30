import { homedir } from 'node:os';
import type { CommandRunner } from './runner.js';
import { shellQuote, hostGroupKey } from './runner.js';
import type { AgentMode, HostConfig } from '../shared/index.js';
import { isGitHubRepo, isSafeGitHost, normalizeRepoUrl, parseGitRemote, redactGitCredentials, repoSlug } from '../shared/index.js';

export interface RepoStoreCache {
  homes: Map<string, string>;
  mutex: Map<string, Promise<unknown>>;
  lastFetchAt: Map<string, number>;
}

export function createRepoStoreCache(): RepoStoreCache {
  return { homes: new Map(), mutex: new Map(), lastFetchAt: new Map() };
}

const FETCH_THROTTLE_MS = 30_000;

export class RepoStore {
  private readonly isGitHub: boolean;
  private readonly repo: string;

  constructor(
    private runner: CommandRunner,
    repo: string,
    private mode: AgentMode,
    private host: HostConfig | undefined,
    private cache: RepoStoreCache,
  ) {
    this.repo = repo.trim();
    this.isGitHub = isGitHubRepo(this.repo);
  }

  async ensure(): Promise<string> {
    const absRepoPath = await this.resolveAbsPath();
    const cacheKey = `${this.hostKey()}:${absRepoPath}`;
    return this.runUnderMutex(cacheKey, async () => {
      const originChanged = await this.cloneIfNeeded(absRepoPath);
      if (originChanged) this.cache.lastFetchAt.delete(cacheKey);
      await this.fetchIfStale(cacheKey, absRepoPath);
      return absRepoPath;
    });
  }

  async refresh(absRepoPath: string): Promise<void> {
    const cacheKey = `${this.hostKey()}:${absRepoPath}`;
    await this.runUnderMutex(cacheKey, () => this.fetchIfStale(cacheKey, absRepoPath));
  }

  private hostKey(): string {
    if (this.mode === 'local') return 'local';
    if (!this.host) throw new Error('Remote mode requires host config');
    return hostGroupKey(this.mode, this.host);
  }

  private async resolveAbsPath(): Promise<string> {
    const home = await this.resolveHome();
    if (this.isGitHub) {
      return `${home}/.baxian/repos/${repoSlug(this.repo).toLowerCase()}`;
    }
    return `${home}/.baxian/${nonGitHubSubpath(this.repo)}`;
  }

  private async resolveHome(): Promise<string> {
    const key = this.hostKey();
    if (this.mode === 'local') {
      const cached = this.cache.homes.get(key);
      if (cached) return cached;
      const home = homedir();
      this.cache.homes.set(key, home);
      return home;
    }
    const cached = this.cache.homes.get(key);
    if (cached) return cached;
    const result = await this.runner.exec('printf %s "$HOME"');
    if (result.exitCode !== 0 || !result.stdout) {
      throw new Error(`Failed to resolve $HOME on ${key}: ${result.stderr}`);
    }
    const home = result.stdout.trim();
    this.cache.homes.set(key, home);
    return home;
  }

  private async cloneIfNeeded(absRepoPath: string): Promise<boolean> {
    const dirExists = (await this.runner.exec(`test -d ${shellQuote(absRepoPath)}`)).exitCode === 0;
    const gitExists = (await this.runner.exec(`test -d ${shellQuote(`${absRepoPath}/.git`)}`)).exitCode === 0;

    if (dirExists && !gitExists) {
      throw new Error(
        `${absRepoPath} exists but is not a git repository. Remove it manually or change project.repo.`,
      );
    }

    if (!dirExists) {
      const parent = absRepoPath.replace(/\/[^/]+$/, '');
      const mk = await this.runner.exec(`mkdir -p ${shellQuote(parent)}`);
      if (mk.exitCode !== 0) throw new Error(`Failed to mkdir ${parent}: ${mk.stderr}`);
      const clone = this.isGitHub
        ? await this.runner.exec(
            `gh repo clone ${shellQuote(repoSlug(this.repo))} ${shellQuote(absRepoPath)} --no-upstream`,
          )
        : await this.runner.exec(
            `git clone ${shellQuote(this.repo)} ${shellQuote(absRepoPath)}`,
          );
      if (clone.exitCode !== 0) {
        const cmd = this.isGitHub ? 'gh repo clone' : 'git clone';
        throw new Error(redactGitCredentials(`${cmd} ${this.repo} failed: ${clone.stderr || clone.stdout}`));
      }
      if (this.isGitHub && parseGitRemote(this.repo) !== null) {
        return this.syncMatchingOriginUrl(absRepoPath);
      }
      return false;
    }

    return this.syncMatchingOriginUrl(absRepoPath);
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

  private async fetchIfStale(cacheKey: string, absRepoPath: string): Promise<void> {
    const last = this.cache.lastFetchAt.get(cacheKey) ?? 0;
    if (Date.now() - last < FETCH_THROTTLE_MS) return;
    const result = await this.runner.exec(
      `cd ${shellQuote(absRepoPath)} && git fetch --all --prune && (git remote set-head origin --auto || true)`,
    );
    if (result.exitCode !== 0) {
      throw new Error(`git fetch failed at ${absRepoPath}: ${result.stderr}`);
    }
    this.cache.lastFetchAt.set(cacheKey, Date.now());
  }

  private async runUnderMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.cache.mutex.get(key) ?? Promise.resolve();
    const cur = prev.then(fn, fn);
    this.cache.mutex.set(key, cur.then(() => undefined, () => undefined));
    return cur;
  }
}

export function nonGitHubSubpath(repo: string): string {
  const parsed = parseGitRemote(repo);
  if (!parsed) throw new Error(`cannot derive local path for non-GitHub repo "${repo}"`);
  if (!isSafeGitHost(parsed.host)) {
    throw new Error(`refusing unsafe host in repo "${repo}"`);
  }
  const segments = parsed.path.split('/');
  if (segments.some(s => s === '' || s === '.' || s === '..')) {
    throw new Error(`refusing unsafe path segment in repo "${repo}"`);
  }
  return `repos-ext/${parsed.host.replace(/:/g, '_')}/${segments.join('/')}`;
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
