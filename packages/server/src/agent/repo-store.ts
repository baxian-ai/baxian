import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import type { CommandRunner, ExecResult } from './runner.js';
import { shellQuote, hostGroupKey, workdirHostGroupKey } from './runner.js';
import { CLONE_EXEC_TIMEOUT_MS, GIT_NET_ENV, execNetwork, execOutcomeUnknown } from './net-exec.js';
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
  '.baxian/research',
] as const;

export class BaxianRuntimeDirsError extends Error {
  constructor(
    public readonly reason: 'unsafe-runtime-path' | 'runtime-path-probe-failed',
    message: string,
  ) {
    super(message);
    this.name = 'BaxianRuntimeDirsError';
  }
}

export async function ensureBaxianRuntimeDirsSafe(
  runner: CommandRunner,
  absRepoPath: string,
): Promise<void> {
  const path = shellQuote(absRepoPath);
  let tracked: ExecResult;
  try {
    tracked = await runner.exec(`git -C ${path} ls-files -- .baxian`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new BaxianRuntimeDirsError(
      'runtime-path-probe-failed',
      `Failed to inspect tracked .baxian paths in ${absRepoPath}: ${message}`,
    );
  }
  const trackedUnknown = execOutcomeUnknown(tracked);
  if (trackedUnknown || tracked.exitCode !== 0) {
    throw new BaxianRuntimeDirsError(
      'runtime-path-probe-failed',
      `${trackedUnknown ? 'Unknown result while inspecting' : 'Failed to inspect'} tracked .baxian paths in `
      + `${absRepoPath}: ${tracked.stderr || tracked.stdout || `exit ${tracked.exitCode}`}`,
    );
  }
  if (tracked.stdout.trim()) {
    throw new BaxianRuntimeDirsError(
      'unsafe-runtime-path',
      `Workdir ${absRepoPath} tracks .baxian paths; baxian runtime files would modify project content.`,
    );
  }

  const dirs = BAXIAN_RUNTIME_DIRS.map(dir => `${absRepoPath}/${dir}`);
  const operands = dirs.map(shellQuote).join(' ');
  const q = shellQuote(absRepoPath);
  // Canonical root guard rides the same command: a rebound Workdir root never receives a mkdir.
  const command =
    `[ "$(cd -- ${q} 2>/dev/null && pwd -P)" = ${q} ] || exit 9; ` +
    `for p in ${operands}; do ` +
      `if [ -L "$p" ] || { [ -e "$p" ] && [ ! -d "$p" ]; }; then exit 9; fi; ` +
    `done && mkdir -p ${operands} && ` +
    `for p in ${operands}; do [ -d "$p" ] && [ ! -L "$p" ] || exit 9; done`;
  let result: ExecResult;
  try {
    result = await runner.exec(`sh -c ${shellQuote(command)}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new BaxianRuntimeDirsError(
      'runtime-path-probe-failed',
      `Could not verify .baxian runtime paths in ${absRepoPath}: ${message}`,
    );
  }
  const guardUnknown = execOutcomeUnknown(result);
  if (guardUnknown || result.exitCode !== 0) {
    if (result.exitCode === 9 && !guardUnknown) {
      throw new BaxianRuntimeDirsError(
        'unsafe-runtime-path',
        `Workdir ${absRepoPath} has an unsafe .baxian runtime path; `
        + 'baxian requires real directories contained in the Workdir.',
      );
    }
    throw new BaxianRuntimeDirsError(
      'runtime-path-probe-failed',
      `${guardUnknown ? 'Unknown result while verifying' : 'Failed to verify'} .baxian runtime paths in `
      + `${absRepoPath}: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`,
    );
  }
}

function normalizeRoot(root: string): string {
  // Strip trailing slashes, but keep the filesystem root as "/" — collapsing it to "" would make the
  // guard `cd -- ''` and break cloning on root-home (HOME=/) container hosts.
  const cleaned = root.replace(/\/+$/, '');
  return cleaned === '' ? '/' : cleaned;
}

// Canonical Workdir (pwd -P) is symlink-free by construction; this equality re-proves it in the SAME command as a mutation so a mid-ensure root rebind can't be written through.
export function canonicalSelfGuard(path: string): string {
  const q = shellQuote(path);
  return `[ "$(cd -- ${q} 2>/dev/null && pwd -P)" = ${q} ]`;
}

export function isUnder(root: string, path: string): boolean {
  const r = normalizeRoot(root);
  // Root "/" contributes a single leading slash, not "//".
  return r === '/' ? path.startsWith('/') && path !== '/' : path.startsWith(`${r}/`);
}

// Canonical (pwd -P) root proves the whole chain symlink-free; a bare [ ! -L root ] misses a rebound mid-path ancestor. Root MUST be canonical (state.workdir / physical home).
export function ancestorSymlinkGuard(root: string, target: string): string {
  const rootClean = normalizeRoot(root);
  if (!isUnder(root, target)) {
    throw new Error(`ancestorSymlinkGuard: ${target} is not under ${rootClean}`);
  }
  // For root "/" the separator IS the leading slash (offset 1); otherwise it is an extra "/" (offset +1).
  const sliceFrom = rootClean === '/' ? rootClean.length : rootClean.length + 1;
  const parts = target.slice(sliceFrom).split('/').filter(Boolean);
  const q = shellQuote(rootClean);
  const checks: string[] = [`[ "$(cd -- ${q} 2>/dev/null && pwd -P)" = ${q} ]`];
  let cur = rootClean;
  for (const part of parts) {
    cur = cur === '/' ? `/${part}` : `${cur}/${part}`;
    checks.push(`[ ! -L ${shellQuote(cur)} ]`);
  }
  return checks.join(' && ');
}

// The guard/op/quoting composition for destructive removes lives here once.
export function guardedRemoveClause(root: string, target: string, opts: { recursive?: boolean } = {}): string {
  const rm = opts.recursive ? 'rm -rf' : 'rm -f';
  return `${ancestorSymlinkGuard(root, target)} && ${rm} -- ${shellQuote(target)}`;
}

const SWEEP_REMOVED = 'BX_SWEEP_REMOVED';
const SWEEP_REFUSED = 'BX_SWEEP_REFUSED';

// Four audited outcomes: removed-or-absent, guard-refused (deliberate keep), rm-failed, and probe-unknown (exec reject / exit 255 — rm may have run, reply lost) which is kept and flagged, never folded into the others.
async function sweepGuardedPath(runner: CommandRunner, path: string, guardClause?: string): Promise<void> {
  const rm = `rm -f -- ${shellQuote(path)} && printf '%s' ${shellQuote(SWEEP_REMOVED)}`;
  const cmd = guardClause
    ? `if ${guardClause}; then ${rm}; else printf '%s' ${shellQuote(SWEEP_REFUSED)}; fi`
    : rm;
  let res: ExecResult;
  try {
    res = await runner.exec(cmd);
  } catch (err) {
    console.warn(`[fs] sweep ${path}: outcome UNKNOWN (exec rejected) — target kept, may linger: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (res.exitCode !== 0 || execOutcomeUnknown(res)) {
    console.warn(`[fs] sweep ${path}: outcome UNKNOWN (exit ${res.exitCode}: ${res.stderr.trim() || 'no stderr'}) — target kept, may linger`);
    return;
  }
  if (res.stdout.includes(SWEEP_REMOVED)) return;
  if (res.stdout.includes(SWEEP_REFUSED)) {
    console.warn(`[fs] sweep ${path}: guard refused — target deliberately kept (rebound ancestor; not out-reaching)`);
    return;
  }
  console.warn(`[fs] sweep ${path}: rm reported failure (no marker; exit ${res.exitCode})`);
}

export async function sweepStrayFile(runner: CommandRunner, path: string, guardClause?: string): Promise<void> {
  await sweepGuardedPath(runner, path, guardClause);
}

function nestedSweepGuard(final: string, guardRoot?: string): string {
  const finalIsRealDir = `[ -d ${shellQuote(final)} ] && [ ! -L ${shellQuote(final)} ]`;
  return guardRoot ? `${ancestorSymlinkGuard(guardRoot, final)} && ${finalIsRealDir}` : finalIsRealDir;
}

// Guard and write share one command so a rebound ancestor never receives staging bytes; mkdir -p recreates components the guard just cleared as not-yet-existing.
export async function stageFileGuarded(
  runner: CommandRunner,
  root: string,
  tmp: string,
  content: Buffer | string,
): Promise<void> {
  const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  const guard = ancestorSymlinkGuard(root, tmp);
  const dir = tmp.slice(0, tmp.lastIndexOf('/'));
  const cmd = `${guard} && mkdir -p ${shellQuote(dir)} && cat > ${shellQuote(tmp)}`;
  let res: ExecResult;
  try {
    res = await runner.execWithStdin(cmd, buf);
  } catch (err) {
    await sweepStrayFile(runner, tmp, guard);
    throw new Error(
      `staged write of ${tmp} failed (exec layer): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (res.exitCode !== 0) {
    await sweepStrayFile(runner, tmp, guard);
    throw new Error(
      `staged write of ${tmp} failed (exit ${res.exitCode}): ${res.stderr.trim() || 'symlink-free path required'}`,
    );
  }
}

// mv onto a directory target nests instead of replacing: fail closed ahead, verify after, sweep both tmp homes on failure.
export async function moveFileIntoPlace(
  runner: CommandRunner,
  tmp: string,
  final: string,
  opts: { guardRoot?: string } = {},
): Promise<void> {
  const tmpBase = tmp.slice(tmp.lastIndexOf('/') + 1);
  const clauses = [
    ...(opts.guardRoot ? [ancestorSymlinkGuard(opts.guardRoot, final)] : []),
    `[ ! -d ${shellQuote(final)} ]`,
    `mv -f -- ${shellQuote(tmp)} ${shellQuote(final)}`,
    `[ -f ${shellQuote(final)} ]`,
  ];
  const guardCovers = (p: string): boolean => opts.guardRoot !== undefined && isUnder(opts.guardRoot, p);
  const tmpGuard = guardCovers(tmp) ? ancestorSymlinkGuard(opts.guardRoot!, tmp) : undefined;
  const nestedGuard = nestedSweepGuard(final, guardCovers(final) ? opts.guardRoot : undefined);
  const nested = `${final}/${tmpBase}`;
  // Each home swept independently so a first-step failure can't be masked by a second-step no-op.
  const sweepBoth = async (): Promise<void> => {
    await sweepGuardedPath(runner, tmp, tmpGuard);
    await sweepGuardedPath(runner, nested, nestedGuard);
  };
  let res: ExecResult;
  try {
    res = await runner.exec(clauses.join(' && '));
  } catch (err) {
    await sweepBoth();
    throw new Error(
      `atomic replace of ${final} failed (exec layer): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (res.exitCode !== 0) {
    await sweepBoth();
    throw new Error(
      `atomic replace of ${final} failed (exit ${res.exitCode}): ${res.stderr.trim() || 'target must be a plain file with a symlink-free path'}`,
    );
  }
}

export class RepoStore {
  private readonly isGitHub: boolean;
  private readonly cloneWithGh: boolean;
  private readonly repo: string;

  constructor(
    private runner: CommandRunner,
    repo: string,
    private mode: AgentMode,
    private host: HostConfig | undefined,
    private cache: RepoStoreCache,
    private agentId: string,
    private configuredWorkdir?: string,
    cloneViaGh?: boolean,
  ) {
    this.repo = repo.trim();
    this.isGitHub = isGitHubRepo(this.repo);
    // clone 是 agent 执行面：github 仓库仅 resolved tool 为 gh 时走 gh repo clone，
    // 自定义 tool 走朴素 git（repo clone 是 gh 专属子命令）。
    this.cloneWithGh = cloneViaGh ?? this.isGitHub;
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
    const dirExists = await this.probeDirExists(absRepoPath);

    if (!dirExists) {
      if (this.configuredWorkdir) {
        throw new Error(
          `Configured Workdir ${absRepoPath} does not exist; ` +
          `baxian never creates a user-specified Workdir implicitly.`,
        );
      }
      // Auto mode only (configured Workdir threw above), so physical home is the provable root; mkdir and clone carry the same chain guard, leaving only the in-command race during the long clone.
      const guardRoot = await this.resolveHome();
      const parent = absRepoPath.replace(/\/[^/]+$/, '');
      const staging = `${absRepoPath}.claim-${randomUUID()}`;
      const stagingGuard = ancestorSymlinkGuard(guardRoot, staging);
      const mk = await this.runner.exec(`${stagingGuard} && mkdir -p ${shellQuote(parent)}`);
      if (mk.exitCode !== 0) throw new Error(`Failed to mkdir ${parent} (symlink-safe): ${mk.stderr}`);
      const cloneCmd = this.cloneWithGh
        ? `${stagingGuard} && ${GIT_NET_ENV} gh repo clone ${shellQuote(repoSlug(this.repo))} ${shellQuote(staging)} --no-upstream`
        : `${stagingGuard} && ${GIT_NET_ENV} git clone ${shellQuote(this.repo)} ${shellQuote(staging)}`;
      let clone: ExecResult;
      try {
        clone = await execNetwork(this.runner, cloneCmd, {
          timeout: CLONE_EXEC_TIMEOUT_MS,
          retries: 0,
        });
      } catch (err) {
        await this.discardStaging(staging, err instanceof Error ? err.message : String(err), ancestorSymlinkGuard(guardRoot, staging));
        throw err;
      }
      if (clone.exitCode !== 0) {
        await this.discardStaging(staging, `clone exit ${clone.exitCode}`, ancestorSymlinkGuard(guardRoot, staging));
        const cmd = this.cloneWithGh ? 'gh repo clone' : 'git clone';
        throw new Error(redactGitCredentials(`${cmd} ${this.repo} failed: ${clone.stderr || clone.stdout}`));
      }
      await this.promoteStaging(staging, absRepoPath, guardRoot);
      if (this.isGitHub && parseGitRemote(this.repo) !== null) {
        return this.syncMatchingOriginUrl(absRepoPath);
      }
      return false;
    }

    const gitDir = await this.probe(
      `git rev-parse --resolve-git-dir ${shellQuote(`${absRepoPath}/.git`)}`,
      `git dir at ${absRepoPath}`,
    );
    const isRepo = gitDir.exitCode === 0;
    if (!isRepo) {
      const discovered = await this.probe(
        `git -C ${shellQuote(absRepoPath)} rev-parse --show-toplevel`,
        `repo layout at ${absRepoPath}`,
      );
      if (discovered.exitCode === 0) {
        throw new Error(
          `Workdir ${absRepoPath} must be the repository's exact top-level directory, not a subdirectory.`,
        );
      }
      const bare = await this.probe(
        `git rev-parse --resolve-git-dir ${shellQuote(absRepoPath)}`,
        `repo layout at ${absRepoPath}`,
      );
      if (bare.exitCode === 0) {
        throw new Error(`Workdir ${absRepoPath} must be a non-bare Git clone.`);
      }
      if (await this.recoverEmptyLeftoverDir(absRepoPath)) {
        return this.cloneIfNeeded(absRepoPath);
      }
      throw new Error(
        `${absRepoPath} exists but is not a git repository. Remove it manually or change project.repo.`,
      );
    }

    return this.syncMatchingOriginUrl(absRepoPath);
  }

  // Runs a remote probe; an uncertain transport outcome throws instead of masquerading as "no".
  private async probe(cmd: string, what: string): Promise<ExecResult> {
    const result = await this.runner.exec(cmd);
    if (result.exitCode !== 0 && execOutcomeUnknown(result)) {
      throw new Error(
        `Cannot probe ${what} (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim() || 'exec layer failure'}`,
      );
    }
    return result;
  }

  private async validateClone(absRepoPath: string): Promise<void> {
    const path = shellQuote(absRepoPath);
    const probe = (cmd: string, what: string): Promise<ExecResult> =>
      this.probe(cmd, `${what} at ${absRepoPath}`);
    const top = await probe(`git -C ${path} rev-parse --show-toplevel`, 'worktree top');
    if (top.exitCode !== 0 || top.stdout.trim() === '') {
      throw new Error(`${absRepoPath} is not a working-tree Git repository.`);
    }
    const canonicalTop = await probe(`cd ${shellQuote(top.stdout.trim())} && pwd -P`, 'canonical top');
    if (canonicalTop.exitCode !== 0 || canonicalTop.stdout.trim() !== absRepoPath) {
      throw new Error(
        `Workdir ${absRepoPath} must be the repository's exact top-level directory, not a subdirectory.`,
      );
    }
    const bare = await probe(`git -C ${path} rev-parse --is-bare-repository`, 'bare flag');
    if (bare.exitCode !== 0 || bare.stdout.trim() !== 'false') {
      throw new Error(`Workdir ${absRepoPath} must be a non-bare Git clone.`);
    }
    const independent = await probe(
      `test -d ${shellQuote(`${absRepoPath}/.git`)} && ` +
      `test "$(git -C ${path} rev-parse --git-common-dir)" = .git && ` +
      `test ! -s ${shellQuote(`${absRepoPath}/.git/objects/info/alternates`)}`,
      'clone independence',
    );
    if (independent.exitCode !== 0) {
      throw new Error(
        `Workdir ${absRepoPath} must be an independent ordinary clone, not a linked worktree or alternates-based clone.`,
      );
    }
    // A promisor/partial clone lazy-fetches missing objects on read, so an unguarded object query
    // could write packs into an externally-rebound .git; reject it as non-independent up front.
    const partial = await probe(
      `git -C ${path} config --get-regexp ${shellQuote('^(remote\\..*\\.(promisor|partialclonefilter)|extensions\\.partialclone)$')}`,
      'partial-clone markers',
    );
    if (partial.exitCode === 0 && partial.stdout.trim() !== '') {
      throw new Error(
        `Workdir ${absRepoPath} is a partial/promisor clone (${partial.stdout.trim().split('\n')[0]}); ` +
        `baxian requires an independent ordinary clone. Re-clone without --filter.`,
      );
    }
    const writable = await probe(`test -r ${path} -a -w ${path} -a -x ${path}`, 'permissions');
    if (writable.exitCode !== 0) {
      throw new Error(`Workdir ${absRepoPath} is not readable and writable by the agent host user.`);
    }
    const metadata = await probe(`git -C ${path} rev-parse --git-dir HEAD >/dev/null`, 'git metadata');
    if (metadata.exitCode !== 0) {
      throw new Error(`Workdir ${absRepoPath} has unreadable Git metadata or HEAD.`);
    }
    const remoteRefs = await probe(
      `git -C ${path} for-each-ref --format=${shellQuote('%(refname)')} --count=1 refs/remotes/`,
      'remote-tracking refs',
    );
    if (remoteRefs.exitCode !== 0 || remoteRefs.stdout.trim() === '') {
      throw new Error(`Workdir ${absRepoPath} has no readable remote-tracking refs.`);
    }
  }

  private async ensureBaxianExcluded(absRepoPath: string): Promise<void> {
    const path = shellQuote(absRepoPath);
    const command =
      `${canonicalSelfGuard(absRepoPath)} && cd ${path} && p="$(git rev-parse --git-path info/exclude)" && ` +
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

  // pushurl is cleared BEFORE the URL flips, so a failure keeps the diff visible and the next ensure() retries.
  private async syncOriginUrl(absRepoPath: string, originUrl: string): Promise<boolean> {
    if (parseGitRemote(this.repo) === null) return false;
    if (!accessMethodDiffers(this.repo, originUrl)) return false;
    // These config writes precede validateClone, so a rebound-to-external Workdir would be mutated first; each carries the canonical self-guard in its own command.
    const guard = canonicalSelfGuard(absRepoPath);
    const unset = await this.probe(
      `${guard} && git -C ${shellQuote(absRepoPath)} config --unset-all remote.origin.pushurl`,
      `remote.origin.pushurl removal at ${absRepoPath}`,
    );
    // git config exit 5 = key absent, the normal case here.
    if (unset.exitCode !== 0 && unset.exitCode !== 5) {
      throw new Error(redactGitCredentials(
        `Failed to clear remote.origin.pushurl at ${absRepoPath} (exit ${unset.exitCode}): ${unset.stderr.trim()}`,
      ));
    }
    const result = await this.runner.exec(
      `${guard} && git -C ${shellQuote(absRepoPath)} config --replace-all remote.origin.url ${shellQuote(this.repo)}`,
    );
    if (result.exitCode !== 0) {
      throw new Error(redactGitCredentials(
        `Failed to update origin URL at ${absRepoPath}: ${result.stderr}`,
      ));
    }
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

  // exit 1 is test(1) saying "no" — unless transport noise rode along, proving nothing.
  private async probeDirExists(absRepoPath: string): Promise<boolean> {
    const probe = await this.probe(`test -d ${shellQuote(absRepoPath)}`, `workdir ${absRepoPath}`);
    if (probe.exitCode === 0) return true;
    if (probe.exitCode === 1) return false;
    throw new Error(
      `Cannot probe workdir ${absRepoPath} (exit ${probe.exitCode}): ${probe.stderr.trim() || 'exec layer failure'}`,
    );
  }

  // The staging name embeds a UUID, so deleting by name cannot hit anyone else's work.
  private async discardStaging(staging: string, reason: string, guardClause?: string): Promise<void> {
    console.warn(`[repo-store] removing staged clone ${staging}: ${redactGitCredentials(reason)}`);
    // Emit a marker so a guard-refused sweep is not masked by the `if`'s exit 0 (destructive cleanup must not fail silently).
    const rmCmd = guardClause
      ? `if ${guardClause}; then rm -rf ${shellQuote(staging)} && echo BX_STAGING_REMOVED; else echo BX_STAGING_REFUSED; fi`
      : `rm -rf ${shellQuote(staging)} && echo BX_STAGING_REMOVED`;
    try {
      const rm = await this.runner.exec(rmCmd);
      if (rm.exitCode !== 0) {
        console.warn(`[repo-store] failed to remove staged clone ${staging}: ${rm.stderr.trim() || `exit ${rm.exitCode}`}`);
      } else if (rm.stdout.includes('BX_STAGING_REFUSED')) {
        console.warn(`[repo-store] staged clone ${staging} NOT removed: ancestor guard refused (rebound path); debris may remain`);
      } else if (!rm.stdout.includes('BX_STAGING_REMOVED')) {
        console.warn(`[repo-store] staged clone ${staging} removal outcome unknown (no marker); debris may remain`);
      }
    } catch (err) {
      console.warn(`[repo-store] failed to remove staged clone ${staging}:`, err);
    }
  }

  // mv has three homes (unmoved staging / moved final / nested-on-race); a nonce in staging/.git survives the move so an unknown outcome is reconciled by which home holds our bytes, never guessed.
  private async promoteStaging(staging: string, absRepoPath: string, guardRoot: string): Promise<void> {
    const base = staging.slice(staging.lastIndexOf('/') + 1);
    const nestedPath = `${absRepoPath}/${base}`;
    // Sweeps carry the FULL ancestor chain from the managed root: a leaf-only [ ! -L ] would still fire inside an external dir if `.baxian/agents/<id>` rebinds.
    const stagingGuard = ancestorSymlinkGuard(guardRoot, staging);
    const nestedGuard = ancestorSymlinkGuard(guardRoot, nestedPath);
    const discardBoth = async (reason: string): Promise<void> => {
      await this.discardStaging(staging, reason, stagingGuard);
      await this.discardStaging(nestedPath, reason, nestedGuard);
    };
    const nonce = randomUUID();
    const claimRel = '.git/baxian-promote-claim';
    const stagingClaim = `${staging}/${claimRel}`;
    const finalClaim = `${absRepoPath}/${claimRel}`;
    const markGuard = ancestorSymlinkGuard(guardRoot, staging);
    const mark = await this.runner.exec(
      `${markGuard} && printf %s ${shellQuote(nonce)} > ${shellQuote(stagingClaim)}`,
    );
    if (mark.exitCode !== 0) {
      await this.discardStaging(staging, `promote-claim write failed: ${mark.stderr.trim() || `exit ${mark.exitCode}`}`, markGuard);
      throw new Error(`Cannot stamp staged clone ${staging}: ${mark.stderr.trim() || `exit ${mark.exitCode}`}`);
    }
    // Guard + free-and-not-symlink + mv share one command: a rebound ancestor never receives the move.
    const promoteCmd =
      `${ancestorSymlinkGuard(guardRoot, absRepoPath)} && ` +
      `[ ! -e ${shellQuote(absRepoPath)} ] && [ ! -L ${shellQuote(absRepoPath)} ] && ` +
      `mv ${shellQuote(staging)} ${shellQuote(absRepoPath)}`;
    let promote: ExecResult;
    try {
      promote = await this.runner.exec(promoteCmd);
    } catch (err) {
      await this.reconcilePromote(staging, absRepoPath, nestedPath, finalClaim, nonce, guardRoot,
        `mv exec rejected: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (promote.exitCode === 0) {
      // Confirm the landing site BEFORE touching any marker: an exit-0 mv can nest staging into a raced-in target, making `final` foreign — clearing its baxian-promote-claim would delete someone else's file.
      const nested = await this.runner.exec(`test -e ${shellQuote(nestedPath)}`);
      if (execOutcomeUnknown(nested) || (nested.exitCode !== 0 && nested.exitCode !== 1)) {
        const reason = `promote verification failed (exit ${nested.exitCode}): ${nested.stderr.trim() || 'exec layer failure'}`;
        await discardBoth(reason);
        throw new Error(`Cannot verify promoted clone at ${absRepoPath}; ${reason}`);
      }
      if (nested.exitCode === 1) {
        // No nested copy: our mv landed at `final`. Its marker must still hold our nonce to adopt it — a
        // refused clear means `final` was replaced after the mv (foreign clone), so promote is inconclusive.
        const cleared = await this.clearPromoteClaim(finalClaim, ancestorSymlinkGuard(guardRoot, finalClaim), nonce);
        if (cleared !== 'removed') {
          throw new Error(
            `Promote to ${absRepoPath} landed but its ownership marker was ${cleared} (replaced/foreign or unverifiable); refusing to adopt. Retry DELETE/clone.`,
          );
        }
        return;
      }
      await this.discardStaging(nestedPath, `final path ${absRepoPath} was recreated concurrently`, nestedGuard);
      throw new Error(`Final path ${absRepoPath} was recreated while promoting; staged clone withdrawn.`);
    }
    if (execOutcomeUnknown(promote)) {
      await this.reconcilePromote(staging, absRepoPath, nestedPath, finalClaim, nonce, guardRoot,
        `mv outcome unknown (exit ${promote.exitCode}): ${promote.stderr.trim()}`);
      return;
    }
    await discardBoth(`promote failed: ${promote.stderr.trim() || `exit ${promote.exitCode}`}`);
    throw new Error(
      `Cannot promote staged clone into ${absRepoPath}: ${promote.stderr.trim() || `exit ${promote.exitCode}`}`,
    );
  }

  // Three-home reconciliation of an unknown mv: staging present → not executed (discard); final holds our nonce → done; nested → target race (discard); else inconclusive (keep).
  private async reconcilePromote(
    staging: string,
    absRepoPath: string,
    nestedPath: string,
    finalClaim: string,
    nonce: string,
    guardRoot: string,
    cause: string,
  ): Promise<void> {
    const stagingExists = await this.runner.exec(`test -e ${shellQuote(staging)}`);
    if (stagingExists.exitCode === 0) {
      await this.discardStaging(staging, `mv not executed (${cause})`, ancestorSymlinkGuard(guardRoot, staging));
      throw new Error(`Promote to ${absRepoPath} not executed; staged clone withdrawn. ${cause}`);
    }
    if (stagingExists.exitCode === 1) {
      const marker = await this.runner.exec(`cat ${shellQuote(finalClaim)} 2>/dev/null`);
      if (marker.exitCode === 0 && marker.stdout.trim() === nonce) {
        // The separate cat above can race a replacement of `final`; the atomic clear is authoritative —
        // only treat the promote as completed-and-ours if the marker was actually removed under nonce.
        const cleared = await this.clearPromoteClaim(finalClaim, ancestorSymlinkGuard(guardRoot, finalClaim), nonce);
        if (cleared !== 'removed') {
          throw new Error(
            `Promote to ${absRepoPath} reconciliation: ownership marker was ${cleared} (final replaced after the nonce read); refusing to adopt. ${cause}`,
          );
        }
        console.warn(`[repo-store] promote to ${absRepoPath} reconciled as already-completed (${cause})`);
        return;
      }
      const nested = await this.runner.exec(`test -e ${shellQuote(nestedPath)}`);
      if (nested.exitCode === 0) {
        await this.discardStaging(nestedPath, `mv nested on target race (${cause})`, ancestorSymlinkGuard(guardRoot, nestedPath));
        throw new Error(`Promote to ${absRepoPath} nested on a target race; staged clone withdrawn. ${cause}`);
      }
    }
    console.warn(`[repo-store] promote to ${absRepoPath} outcome UNKNOWN — staging/final/nested all inconclusive, nothing removed (${cause})`);
    throw new Error(`Cannot reconcile promote to ${absRepoPath}; all locations inconclusive. ${cause}`);
  }

  private async clearPromoteClaim(finalClaim: string, guard: string, nonce: string): Promise<'removed' | 'refused' | 'failed'> {
    try {
      // Nonce re-check and rm in ONE command (a separate cat→rm could delete a replaced foreign marker); the echoed marker surfaces a guard/nonce-refused clear that the `if`'s exit 0 would otherwise mask.
      const rm = await this.runner.exec(
        `if ${guard} && [ "$(cat ${shellQuote(finalClaim)} 2>/dev/null)" = ${shellQuote(nonce)} ]; ` +
          `then rm -f ${shellQuote(finalClaim)} && echo BX_MARKER_REMOVED; else echo BX_MARKER_REFUSED; fi`,
      );
      if (rm.exitCode !== 0) {
        console.warn(`[repo-store] failed to clear promote-claim marker ${finalClaim}: ${rm.stderr.trim() || `exit ${rm.exitCode}`}`);
        return 'failed';
      }
      if (rm.stdout.includes('BX_MARKER_REFUSED')) {
        console.warn(`[repo-store] promote-claim marker ${finalClaim} NOT cleared: guard/nonce mismatch (foreign or rebound); left in place`);
        return 'refused';
      }
      return 'removed';
    } catch (err) {
      console.warn(`[repo-store] failed to clear promote-claim marker ${finalClaim}:`, err);
      return 'failed';
    }
  }

  // rmdir can't touch anything non-empty and the chain guard binds it to the physical managed root, so a rebound parent can't be hit.
  private async recoverEmptyLeftoverDir(absRepoPath: string): Promise<boolean> {
    if (this.configuredWorkdir) return false;
    const guardRoot = await this.resolveHome();
    const undo = await this.probe(
      `${ancestorSymlinkGuard(guardRoot, absRepoPath)} && rmdir ${shellQuote(absRepoPath)}`,
      `leftover dir ${absRepoPath}`,
    );
    if (undo.exitCode === 0) {
      console.warn(`[repo-store] removed leftover empty dir ${absRepoPath}; retrying clone`);
      return true;
    }
    return false;
  }

  private async fetchIfStale(cacheKey: string, absRepoPath: string): Promise<void> {
    const last = this.cache.lastFetchAt.get(cacheKey) ?? 0;
    if (Date.now() - last < FETCH_THROTTLE_MS) return;
    // fetch/set-head write refs and FETCH_HEAD; the canonical self-guard rides the same command so a
    // rebind after validateClone can't redirect the writes into an external repo.
    const result = await execNetwork(
      this.runner,
      `${canonicalSelfGuard(absRepoPath)} && cd ${shellQuote(absRepoPath)} && ${GIT_NET_ENV} git fetch --all --prune && git remote set-head origin --auto`,
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
