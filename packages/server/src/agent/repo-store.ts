import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import type { CommandRunner, ExecResult } from './runner.js';
import { shellQuote, hostGroupKey, workdirHostGroupKey } from './runner.js';
import {
  CLONE_EXEC_TIMEOUT_MS,
  ExecOutcomeUnknownError,
  GIT_NET_ENV,
  execNetwork,
  execOutcomeUnknown,
} from './net-exec.js';
import type { AgentMode, HostConfig } from '../shared/index.js';
import { normalizeRepoUrl, redactGitCredentials } from '../shared/index.js';

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
] as const;

class BaxianRuntimeDirsError extends Error {
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
  let result: ExecResult;
  try {
    result = await runner.exec(`mkdir -p ${operands}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new BaxianRuntimeDirsError(
      'runtime-path-probe-failed',
      `Could not prepare .baxian runtime paths in ${absRepoPath}: ${message}`,
    );
  }
  if (execOutcomeUnknown(result) || result.exitCode !== 0) {
    throw new BaxianRuntimeDirsError(
      'runtime-path-probe-failed',
      `${execOutcomeUnknown(result) ? 'Unknown result while preparing' : 'Failed to prepare'} .baxian runtime paths in `
      + `${absRepoPath}: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`,
    );
  }
}

function trashBatchDirUnder(trashRoot: string, reason: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${trashRoot}/${stamp}-${reason}-${randomUUID().slice(0, 8)}`;
}

// The batch sits beside its sources inside the agent tree, so mv never crosses filesystems.
export function trashBatchDir(home: string, agentId: string, reason: string): string {
  return trashBatchDirUnder(`${home}/.baxian/agents/${agentId}/.baxian-trash`, reason);
}

const TRASHED = 'BX_TRASHED';
const TRASH_ABSENT = 'BX_TRASH_ABSENT';
const MV_PRECHECK = 'BX_MV_PRECHECK';

// Absent counts as success (force-remove semantics); mkdir/mv failures must surface as a non-zero exit.
function trashMoveCommand(path: string, batchDir: string): string {
  const p = shellQuote(path);
  const b = shellQuote(batchDir);
  return (
    `if [ ! -e ${p} ] && [ ! -L ${p} ]; then printf '%s' ${TRASH_ABSENT}; ` +
    `elif mkdir -p ${b}; then ` +
    `base=$(basename -- ${p}); t=${b}/"$base"; n=0; ` +
    `while [ -e "$t" ] || [ -L "$t" ]; do n=$((n+1)); t=${b}/"$base.$n"; done; ` +
    `mv -- ${p} "$t" && printf '%s' ${TRASHED}; ` +
    `else false; ` +
    `fi`
  );
}

async function sweepToTrash(runner: CommandRunner, path: string, batchDir: string): Promise<void> {
  let res: ExecResult;
  try {
    res = await runner.exec(trashMoveCommand(path, batchDir));
  } catch (err) {
    console.warn(`[fs] trash ${path}: outcome UNKNOWN (exec rejected) — target kept, may linger: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (execOutcomeUnknown(res)) {
    console.warn(`[fs] trash ${path}: outcome UNKNOWN (exit ${res.exitCode}: ${res.stderr.trim() || 'no stderr'}) — target kept, may linger`);
    return;
  }
  if (res.exitCode !== 0) {
    console.warn(`[fs] trash ${path}: move failed (exit ${res.exitCode}: ${res.stderr.trim() || 'no stderr'}) — target kept in place`);
    return;
  }
  if (res.stdout.includes(TRASH_ABSENT) || res.stdout.includes(TRASHED)) return;
  console.warn(`[fs] trash ${path}: move reported failure (no marker; exit ${res.exitCode}) — target kept in place`);
}

export async function sweepStrayFile(runner: CommandRunner, path: string, batchDir: string): Promise<void> {
  await sweepToTrash(runner, path, batchDir);
}

export async function stageFile(
  runner: CommandRunner,
  tmp: string,
  content: Buffer | string,
  opts: { mode?: number; trashDir: string },
): Promise<void> {
  const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  const dir = tmp.slice(0, tmp.lastIndexOf('/'));
  const privateCreate = opts.mode === undefined ? '' : 'umask 077 && ';
  const enforceMode = opts.mode === undefined
    ? ''
    : ` && chmod ${opts.mode.toString(8)} ${shellQuote(tmp)}`;
  const cmd = `mkdir -p ${shellQuote(dir)} && ${privateCreate}cat > ${shellQuote(tmp)}${enforceMode}`;
  let res: ExecResult;
  try {
    res = await runner.execWithStdin(cmd, buf);
  } catch (err) {
    await sweepStrayFile(runner, tmp, opts.trashDir);
    throw new ExecOutcomeUnknownError(
      `staged write of ${tmp} failed (exec layer): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (execOutcomeUnknown(res)) {
    await sweepStrayFile(runner, tmp, opts.trashDir);
    throw new ExecOutcomeUnknownError(
      `staged write of ${tmp} outcome unknown (exit ${res.exitCode}): ${res.stderr.trim() || 'no stderr'}`,
    );
  }
  if (res.exitCode !== 0) {
    await sweepStrayFile(runner, tmp, opts.trashDir);
    throw new Error(
      `staged write of ${tmp} failed (exit ${res.exitCode}): ${res.stderr.trim() || 'no stderr'}`,
    );
  }
}

export async function moveFileIntoPlace(
  runner: CommandRunner,
  tmp: string,
  final: string,
  opts: { trashDir: string },
): Promise<void> {
  const tmpBase = tmp.slice(tmp.lastIndexOf('/') + 1);
  // mv -f onto a directory target nests instead of replacing: fail closed ahead, verify a plain file landed after.
  const clauses = [
    `[ -f ${shellQuote(tmp)} ]`,
    `[ ! -L ${shellQuote(tmp)} ]`,
    `[ ! -d ${shellQuote(final)} ]`,
    `printf '%s' ${MV_PRECHECK}`,
    `mv -f -- ${shellQuote(tmp)} ${shellQuote(final)}`,
    `[ -f ${shellQuote(final)} ]`,
    `[ ! -L ${shellQuote(final)} ]`,
  ];
  const nested = `${final}/${tmpBase}`;
  // The nested path resolves THROUGH a symlink final; sweep it only when the precheck marker proves mv actually ran, else an unrelated same-named file behind the link would be dragged into trash.
  const sweepFailure = async (mvMayHaveRun: boolean): Promise<void> => {
    await sweepToTrash(runner, tmp, opts.trashDir);
    if (mvMayHaveRun) await sweepToTrash(runner, nested, opts.trashDir);
  };
  let res: ExecResult;
  try {
    res = await runner.exec(clauses.join(' && '));
  } catch (err) {
    await sweepFailure(false);
    throw new ExecOutcomeUnknownError(
      `atomic replace of ${final} failed (exec layer): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const mvMayHaveRun = res.stdout.includes(MV_PRECHECK);
  if (execOutcomeUnknown(res)) {
    await sweepFailure(mvMayHaveRun);
    throw new ExecOutcomeUnknownError(
      `atomic replace of ${final} outcome unknown (exit ${res.exitCode}): ${res.stderr.trim() || 'no stderr'}`,
    );
  }
  if (res.exitCode !== 0) {
    await sweepFailure(mvMayHaveRun);
    throw new Error(
      `atomic replace of ${final} failed (exit ${res.exitCode}): ${res.stderr.trim() || 'target must be a plain file'}`,
    );
  }
}

export class RepoStore {
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
      const parent = absRepoPath.replace(/\/[^/]+$/, '');
      const staging = `${absRepoPath}.claim-${randomUUID()}`;
      const mk = await this.runner.exec(`mkdir -p ${shellQuote(parent)}`);
      if (mk.exitCode !== 0) throw new Error(`Failed to mkdir ${parent}: ${mk.stderr}`);
      const cloneCmd = `${GIT_NET_ENV} git clone ${shellQuote(this.repo)} ${shellQuote(staging)}`;
      let clone: ExecResult;
      try {
        clone = await execNetwork(this.runner, cloneCmd, {
          timeout: CLONE_EXEC_TIMEOUT_MS,
          retries: 0,
        });
      } catch (err) {
        await this.trashStaging(staging, err instanceof Error ? err.message : String(err));
        throw err;
      }
      if (clone.exitCode !== 0) {
        await this.trashStaging(staging, `clone exit ${clone.exitCode}`);
        throw new Error(redactGitCredentials(`git clone ${this.repo} failed: ${clone.stderr || clone.stdout}`));
      }
      await this.promoteStaging(staging, absRepoPath);
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
    // Physical-to-physical: the auto Workdir path may route through symlinks (e.g. a relocated ~/.baxian/agents), so the logical path itself never matches the toplevel.
    const canonicalWorkdir = await probe(`cd ${path} && pwd -P`, 'canonical workdir');
    if (
      canonicalTop.exitCode !== 0 || canonicalWorkdir.exitCode !== 0
      || canonicalTop.stdout.trim() === ''
      || canonicalTop.stdout.trim() !== canonicalWorkdir.stdout.trim()
    ) {
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
    // Leading slash anchors to the repo root (an unanchored `.baxian` would hide sub/.baxian anywhere); no trailing slash so a user-planted symlink .baxian is still covered.
    const command =
      `cd ${path} && p="$(git rev-parse --git-path info/exclude)" && ` +
      `mkdir -p "$(dirname "$p")" && ` +
      `{ grep -qxF '/.baxian' "$p" 2>/dev/null || printf '%s\\n' '/.baxian' >> "$p"; } && ` +
      `git check-ignore -q -- .baxian`;
    const excluded = await this.runner.exec(`sh -c ${shellQuote(command)}`);
    if (execOutcomeUnknown(excluded)) {
      throw new ExecOutcomeUnknownError(
        `.baxian exclude probe in ${absRepoPath} outcome unknown (exit ${excluded.exitCode}): ${excluded.stderr.trim() || 'no stderr'}`,
      );
    }
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
    if (!accessMethodDiffers(this.repo, originUrl)) return false;
    const unset = await this.probe(
      `git -C ${shellQuote(absRepoPath)} config --unset-all remote.origin.pushurl`,
      `remote.origin.pushurl removal at ${absRepoPath}`,
    );
    if (unset.exitCode !== 0 && unset.exitCode !== 5) {
      throw new Error(redactGitCredentials(
        `Failed to clear remote.origin.pushurl at ${absRepoPath} (exit ${unset.exitCode}): ${unset.stderr.trim()}`,
      ));
    }
    const result = await this.runner.exec(
      `git -C ${shellQuote(absRepoPath)} config --replace-all remote.origin.url ${shellQuote(this.repo)}`,
    );
    if (result.exitCode !== 0) {
      throw new Error(redactGitCredentials(
        `Failed to update origin URL at ${absRepoPath}: ${result.stderr}`,
      ));
    }
    return true;
  }

  private originMatches(originUrl: string): boolean {
    const expected = normalizeRepoUrl(this.repo);
    const actual = normalizeRepoUrl(originUrl);
    return expected !== null && actual !== null && expected.toLowerCase() === actual.toLowerCase();
  }

  private async probeDirExists(absRepoPath: string): Promise<boolean> {
    const probe = await this.probe(`test -d ${shellQuote(absRepoPath)}`, `workdir ${absRepoPath}`);
    if (probe.exitCode === 0) return true;
    if (probe.exitCode === 1) return false;
    throw new Error(
      `Cannot probe workdir ${absRepoPath} (exit ${probe.exitCode}): ${probe.stderr.trim() || 'exec layer failure'}`,
    );
  }

  private async trashDir(reason: string): Promise<string> {
    return trashBatchDir(await this.resolveHome(), this.agentId, reason);
  }

  private async trashStaging(staging: string, reason: string): Promise<void> {
    console.warn(`[repo-store] trashing staged clone ${staging}: ${redactGitCredentials(reason)}`);
    let batchDir: string;
    try {
      batchDir = await this.trashDir('staging');
    } catch (err) {
      console.warn(`[repo-store] cannot resolve trash dir for staged clone ${staging}; kept in place:`, err);
      return;
    }
    try {
      const moved = await this.runner.exec(trashMoveCommand(staging, batchDir));
      if (execOutcomeUnknown(moved)) {
        console.warn(`[repo-store] staged clone ${staging} trash outcome UNKNOWN (exit ${moved.exitCode}: ${moved.stderr.trim() || 'no stderr'}); debris may remain`);
      } else if (moved.exitCode !== 0) {
        console.warn(`[repo-store] failed to trash staged clone ${staging}: ${moved.stderr.trim() || `exit ${moved.exitCode}`}`);
      } else if (!moved.stdout.includes(TRASHED) && !moved.stdout.includes(TRASH_ABSENT)) {
        console.warn(`[repo-store] staged clone ${staging} trash outcome unknown (no marker); debris may remain`);
      }
    } catch (err) {
      console.warn(`[repo-store] failed to trash staged clone ${staging}:`, err);
    }
  }

  private async promoteStaging(staging: string, absRepoPath: string): Promise<void> {
    const base = staging.slice(staging.lastIndexOf('/') + 1);
    const nestedPath = `${absRepoPath}/${base}`;
    const trashBoth = async (reason: string): Promise<void> => {
      await this.trashStaging(staging, reason);
      await this.trashStaging(nestedPath, reason);
    };
    const nonce = randomUUID();
    const claimRel = '.git/baxian-promote-claim';
    const stagingClaim = `${staging}/${claimRel}`;
    const finalClaim = `${absRepoPath}/${claimRel}`;
    const mark = await this.runner.exec(
      `printf %s ${shellQuote(nonce)} > ${shellQuote(stagingClaim)}`,
    );
    if (execOutcomeUnknown(mark)) {
      await this.trashStaging(staging, `promote-claim write outcome unknown: ${mark.stderr.trim() || `exit ${mark.exitCode}`}`);
      throw new ExecOutcomeUnknownError(
        `Promote-claim write for ${staging} outcome unknown (exit ${mark.exitCode}): ${mark.stderr.trim() || 'no stderr'}`,
      );
    }
    if (mark.exitCode !== 0) {
      await this.trashStaging(staging, `promote-claim write failed: ${mark.stderr.trim() || `exit ${mark.exitCode}`}`);
      throw new Error(`Cannot stamp staged clone ${staging}: ${mark.stderr.trim() || `exit ${mark.exitCode}`}`);
    }
    const promoteCmd =
      `[ ! -e ${shellQuote(absRepoPath)} ] && [ ! -L ${shellQuote(absRepoPath)} ] && ` +
      `printf '%s' ${MV_PRECHECK} && mv ${shellQuote(staging)} ${shellQuote(absRepoPath)}`;
    let promote: ExecResult;
    try {
      promote = await this.runner.exec(promoteCmd);
    } catch (err) {
      await this.reconcilePromote(staging, absRepoPath, nestedPath, finalClaim, nonce,
        `mv exec rejected: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    // Unknown outrank exit 0: a transient-tainted reply proves nothing about whether mv ran.
    if (execOutcomeUnknown(promote)) {
      await this.reconcilePromote(staging, absRepoPath, nestedPath, finalClaim, nonce,
        `mv outcome unknown (exit ${promote.exitCode}): ${promote.stderr.trim()}`);
      return;
    }
    if (promote.exitCode === 0) {
      const nested = await this.runner.exec(`test -e ${shellQuote(nestedPath)}`);
      if (execOutcomeUnknown(nested)) {
        throw new Error(
          `Cannot verify promoted clone at ${absRepoPath}: nested probe outcome unknown (exit ${nested.exitCode}): ${nested.stderr.trim() || 'no stderr'}; nothing moved.`,
        );
      }
      if (nested.exitCode !== 0 && nested.exitCode !== 1) {
        const reason = `promote verification failed (exit ${nested.exitCode}): ${nested.stderr.trim() || 'exec layer failure'}`;
        await trashBoth(reason);
        throw new Error(`Cannot verify promoted clone at ${absRepoPath}; ${reason}`);
      }
      if (nested.exitCode === 1) {
        const cleared = await this.clearPromoteClaim(finalClaim, nonce);
        if (cleared !== 'removed') {
          throw new Error(
            `Promote to ${absRepoPath} landed but its ownership marker was ${cleared} (replaced/foreign or unverifiable); refusing to adopt. Retry DELETE/clone.`,
          );
        }
        return;
      }
      await this.trashStaging(nestedPath, `final path ${absRepoPath} was recreated concurrently`);
      throw new Error(`Final path ${absRepoPath} was recreated while promoting; staged clone withdrawn.`);
    }
    // Without the precheck marker mv never started, so final/<base> cannot be ours — only the staging we provably own is withdrawn.
    if (promote.stdout.includes(MV_PRECHECK)) {
      await trashBoth(`promote failed: ${promote.stderr.trim() || `exit ${promote.exitCode}`}`);
    } else {
      await this.trashStaging(staging, `promote failed before mv: ${promote.stderr.trim() || `exit ${promote.exitCode}`}`);
    }
    throw new Error(
      `Cannot promote staged clone into ${absRepoPath}: ${promote.stderr.trim() || `exit ${promote.exitCode}`}`,
    );
  }

  private async reconcilePromote(
    staging: string,
    absRepoPath: string,
    nestedPath: string,
    finalClaim: string,
    nonce: string,
    cause: string,
  ): Promise<void> {
    // Reconciliation probes are remote execs too: an unknown probe must never drive a move.
    const stagingExists = await this.runner.exec(`test -e ${shellQuote(staging)}`);
    if (execOutcomeUnknown(stagingExists)) {
      throw new Error(
        `Cannot reconcile promote to ${absRepoPath}: staging probe outcome unknown (exit ${stagingExists.exitCode}): ${stagingExists.stderr.trim() || 'no stderr'}; nothing moved. ${cause}`,
      );
    }
    if (stagingExists.exitCode === 0) {
      await this.trashStaging(staging, `mv not executed (${cause})`);
      throw new Error(`Promote to ${absRepoPath} not executed; staged clone withdrawn. ${cause}`);
    }
    if (stagingExists.exitCode === 1) {
      const marker = await this.runner.exec(`cat ${shellQuote(finalClaim)} 2>/dev/null`);
      if (marker.exitCode === 0 && marker.stdout.trim() === nonce) {
        const cleared = await this.clearPromoteClaim(finalClaim, nonce);
        if (cleared !== 'removed') {
          throw new Error(
            `Promote to ${absRepoPath} reconciliation: ownership marker was ${cleared} (final replaced after the nonce read); refusing to adopt. ${cause}`,
          );
        }
        console.warn(`[repo-store] promote to ${absRepoPath} reconciled as already-completed (${cause})`);
        return;
      }
      const nested = await this.runner.exec(`test -e ${shellQuote(nestedPath)}`);
      if (execOutcomeUnknown(nested)) {
        throw new Error(
          `Cannot reconcile promote to ${absRepoPath}: nested probe outcome unknown (exit ${nested.exitCode}): ${nested.stderr.trim() || 'no stderr'}; nothing moved. ${cause}`,
        );
      }
      if (nested.exitCode === 0) {
        await this.trashStaging(nestedPath, `mv nested on target race (${cause})`);
        throw new Error(`Promote to ${absRepoPath} nested on a target race; staged clone withdrawn. ${cause}`);
      }
    }
    console.warn(`[repo-store] promote to ${absRepoPath} outcome UNKNOWN — staging/final/nested all inconclusive, nothing removed (${cause})`);
    throw new Error(`Cannot reconcile promote to ${absRepoPath}; all locations inconclusive. ${cause}`);
  }

  private async clearPromoteClaim(finalClaim: string, nonce: string): Promise<'removed' | 'refused' | 'failed'> {
    try {
      const batchDir = await this.trashDir('claim');
      // Nonce re-check and mv in ONE command (a separate cat→mv could displace a replaced foreign marker); the echoed marker surfaces a nonce-refused clear that the `if`'s exit 0 would otherwise mask.
      const moved = await this.runner.exec(
        `if [ "$(cat ${shellQuote(finalClaim)} 2>/dev/null)" = ${shellQuote(nonce)} ]; ` +
          `then mkdir -p ${shellQuote(batchDir)} && mv -- ${shellQuote(finalClaim)} ${shellQuote(batchDir)}/ && echo BX_MARKER_TRASHED; else echo BX_MARKER_REFUSED; fi`,
      );
      if (moved.exitCode !== 0 || execOutcomeUnknown(moved)) {
        console.warn(`[repo-store] failed to clear promote-claim marker ${finalClaim}: ${moved.stderr.trim() || `exit ${moved.exitCode}`}`);
        return 'failed';
      }
      if (moved.stdout.includes('BX_MARKER_REFUSED')) {
        console.warn(`[repo-store] promote-claim marker ${finalClaim} NOT cleared: nonce mismatch (foreign clone); left in place`);
        return 'refused';
      }
      // Only an explicit TRASHED marker proves the move; a bare exit 0 (empty or truncated stdout) is not a positive outcome under the three-state discipline.
      if (moved.stdout.includes('BX_MARKER_TRASHED')) return 'removed';
      console.warn(`[repo-store] promote-claim marker ${finalClaim} clear reported no outcome marker; treating as failed`);
      return 'failed';
    } catch (err) {
      console.warn(`[repo-store] failed to clear promote-claim marker ${finalClaim}:`, err);
      return 'failed';
    }
  }

  private async recoverEmptyLeftoverDir(absRepoPath: string): Promise<boolean> {
    if (this.configuredWorkdir) return false;
    const undo = await this.probe(
      `rmdir ${shellQuote(absRepoPath)}`,
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
