import { randomBytes } from 'node:crypto';
import type { CommandRunner } from './runner.js';
import { shellQuote } from './runner.js';
import { GIT_NET_ENV, execNetwork } from './net-exec.js';
import { BRANCH_PREFIX, REVIEW_INBOX_DIR, WORKTREE_DIR } from '../shared/index.js';

function uniqueSuffix(): string {
  return randomBytes(8).toString('hex');
}

export interface ReviewHeadWorktreeOpts {
  baseSha?: string;
  headSha?: string;
  headTree?: string;
  patch: string;
}

export interface ReviewHeadWorktreeResult {
  path: string;
  mode: 'head' | 'base';
  fallbackReason?: string;
}

export class WorktreeManager {
  constructor(private runner: CommandRunner) {}

  async create(repoDir: string, taskId: string, baseRef?: string, branchName?: string): Promise<string> {
    const worktreePath = `${repoDir}/${WORKTREE_DIR}/${taskId}_${uniqueSuffix()}`;
    const branch = branchName ?? `${BRANCH_PREFIX}${taskId}`;
    const repo = shellQuote(repoDir);
    const wt = shellQuote(worktreePath);
    const baseClause = baseRef ? ` ${shellQuote(baseRef)}` : '';

    if (branchName) {
      const refCheck = await this.runner.exec(
        `cd ${repo} && git rev-parse --verify ${shellQuote('refs/heads/' + branch)} 2>/dev/null`,
      );
      if (refCheck.exitCode === 0) {
        throw new Error(`Branch ${branch} already exists locally; use adopt to bind an existing branch`);
      }
      const remoteCheck = await execNetwork(
        this.runner,
        `cd ${repo} && ${GIT_NET_ENV} git ls-remote --heads origin -- ${shellQuote('refs/heads/' + branch)}`,
      );
      if (remoteCheck.exitCode !== 0) {
        throw new Error(
          `Failed to check remote branch existence: ${remoteCheck.stderr || 'ls-remote exited ' + remoteCheck.exitCode}`,
        );
      }
      if (remoteCheck.stdout.trim()) {
        throw new Error(`Branch ${branch} already exists on remote; use adopt to bind an existing branch`);
      }
      // --no-track: branching off origin/HEAD would otherwise set the upstream to
      // origin/<default>, which breaks a plain `git push` under push.default=simple.
      const result = await this.runner.exec(
        `cd ${repo} && git worktree add --no-track ${wt} -b ${shellQuote(branch)}${baseClause}`,
      );
      if (result.exitCode !== 0) throw new Error(`Failed to create worktree: ${result.stderr}`);
    } else {
      const result = await this.runner.exec(
        `cd ${repo} && git worktree add --no-track ${wt} -B ${shellQuote(branch)}${baseClause}`,
      );
      if (result.exitCode !== 0) throw new Error(`Failed to create worktree: ${result.stderr}`);
    }

    try {
      await this.excludeBaxianDir(repoDir, worktreePath);
    } catch (err) {
      if (branchName) {
        await this.runner.exec(
          `cd ${repo} && git branch -D ${shellQuote(branch)}`,
        ).catch(() => {});
      }
      throw err;
    }
    return worktreePath;
  }

  async adopt(repoDir: string, taskId: string, remoteBranch: string): Promise<string> {
    const worktreePath = `${repoDir}/${WORKTREE_DIR}/${taskId}_${uniqueSuffix()}`;
    const repo = shellQuote(repoDir);
    const wt = shellQuote(worktreePath);

    const fetchedSha = await this.fetchBranchTip(repoDir, remoteBranch, 'Failed to adopt branch');
    const result = await this.runner.exec(
      `cd ${repo} && git worktree add -b ${shellQuote(remoteBranch)} ${wt} ${shellQuote(fetchedSha)}`,
    );

    if (result.exitCode !== 0) {
      if (result.stderr.includes('already exists')) {
        await this.adoptExistingLocal(repoDir, worktreePath, remoteBranch, fetchedSha);
      } else {
        throw new Error(`Failed to adopt branch: ${result.stderr}`);
      }
    }

    const trackResult = await this.runner.exec(
      `cd ${wt} && git branch ${shellQuote('--set-upstream-to=origin/' + remoteBranch)}`,
    );
    if (trackResult.exitCode !== 0) {
      await this.remove(repoDir, worktreePath).catch(() => {});
      throw new Error(`Failed to set upstream tracking: ${trackResult.stderr}`);
    }

    await this.excludeBaxianDir(repoDir, worktreePath);
    return worktreePath;
  }

  private async adoptExistingLocal(
    repoDir: string, worktreePath: string, remoteBranch: string, fetchedSha: string,
  ): Promise<void> {
    const repo = shellQuote(repoDir);
    const wt = shellQuote(worktreePath);

    const listResult = await this.runner.exec(
      `cd ${repo} && git worktree list --porcelain`,
    );
    if (listResult.stdout.includes(`branch refs/heads/${remoteBranch}`)) {
      throw new Error(
        `Branch ${remoteBranch} is checked out in another worktree; ` +
        `remove that worktree first or use a different branch`,
      );
    }

    const localSha = await this.runner.exec(
      `cd ${repo} && git rev-parse ${shellQuote('refs/heads/' + remoteBranch)}`,
    );
    if (localSha.exitCode !== 0) {
      throw new Error('Failed to resolve branch SHAs for consistency check');
    }
    const local = localSha.stdout.trim();

    if (local !== fetchedSha) {
      const mergeBase = await this.runner.exec(
        `cd ${repo} && git merge-base --is-ancestor ${shellQuote('refs/heads/' + remoteBranch)} ${shellQuote(fetchedSha)}`,
      );
      if (mergeBase.exitCode === 0) {
        const ff = await this.runner.exec(
          `cd ${repo} && git update-ref ${shellQuote('refs/heads/' + remoteBranch)} ${shellQuote(fetchedSha)}`,
        );
        if (ff.exitCode !== 0) throw new Error(`Fast-forward failed: ${ff.stderr}`);
      } else {
        throw new Error(
          `Local branch ${remoteBranch} (${local.slice(0, 8)}) diverges from ` +
          `remote (${fetchedSha.slice(0, 8)}); resolve manually before adopting`,
        );
      }
    }

    const retry = await this.runner.exec(
      `cd ${repo} && git worktree add ${wt} ${shellQuote(remoteBranch)}`,
    );
    if (retry.exitCode !== 0) throw new Error(`Failed to adopt branch: ${retry.stderr}`);
  }

  async createDetached(repoDir: string, taskId: string, remoteBranch: string): Promise<string> {
    const worktreePath = `${repoDir}/${WORKTREE_DIR}/${taskId}-review_${uniqueSuffix()}`;
    const fetchedSha = await this.fetchBranchTip(
      repoDir, remoteBranch, 'Failed to create detached worktree',
    );
    const result = await this.runner.exec(
      `cd ${shellQuote(repoDir)} && git worktree add --detach ${shellQuote(worktreePath)} ${shellQuote(fetchedSha)}`,
    );
    if (result.exitCode !== 0) throw new Error(`Failed to create detached worktree: ${result.stderr}`);
    await this.excludeBaxianDir(repoDir, worktreePath);
    return worktreePath;
  }

  async createDetachedAtBase(repoDir: string, taskId: string): Promise<string> {
    const worktreePath = `${repoDir}/${WORKTREE_DIR}/${taskId}-review_${uniqueSuffix()}`;
    const fetch = await execNetwork(
      this.runner,
      `cd ${shellQuote(repoDir)} && ${GIT_NET_ENV} git fetch origin --quiet`,
    );
    if (fetch.exitCode !== 0) {
      throw new Error(`Failed to create base-detached worktree: ${fetch.stderr}`);
    }
    const result = await this.runner.exec(
      `cd ${shellQuote(repoDir)} ` +
        `&& git worktree add --detach ${shellQuote(worktreePath)} "$(git symbolic-ref --short refs/remotes/origin/HEAD)"`,
    );
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create base-detached worktree: ${result.stderr}`);
    }
    await this.excludeBaxianDir(repoDir, worktreePath);
    return worktreePath;
  }

  async createDetachedForReviewHead(
    repoDir: string,
    taskId: string,
    opts: ReviewHeadWorktreeOpts,
  ): Promise<ReviewHeadWorktreeResult> {
    if (!opts.baseSha || !opts.headSha || !opts.headTree) {
      return {
        path: await this.createDetachedAtBase(repoDir, taskId),
        mode: 'base',
        fallbackReason: 'missing-review-head-metadata',
      };
    }
    const worktreePath = `${repoDir}/${WORKTREE_DIR}/${taskId}-review_${uniqueSuffix()}`;
    const repo = shellQuote(repoDir);
    const headRef = `${opts.headSha}^{commit}`;
    const headProbe = await this.runner.exec(
      `cd ${repo} && git cat-file -e ${shellQuote(headRef)}`,
    );
    if (headProbe.exitCode === 0) {
      const added = await this.addDetachedRef(repoDir, worktreePath, opts.headSha, 'Failed to create review-head worktree');
      if (!added) return this.createDetachedFallback(repoDir, taskId, worktreePath, 'review-head-checkout-failed', opts.baseSha);
      try {
        await this.excludeBaxianDir(repoDir, worktreePath);
      } catch {
        return this.createDetachedFallback(repoDir, taskId, worktreePath, 'review-head-exclude-failed', opts.baseSha);
      }
      if (await this.verifyTree(worktreePath, opts.headTree)) {
        return { path: worktreePath, mode: 'head' };
      }
      return this.createDetachedFallback(repoDir, taskId, worktreePath, 'review-head-tree-mismatch', opts.baseSha);
    }

    const fetch = await execNetwork(
      this.runner,
      `cd ${repo} && ${GIT_NET_ENV} git fetch origin --quiet`,
    );
    const baseProbe = await this.runner.exec(
      `cd ${repo} && git cat-file -e ${shellQuote(`${opts.baseSha}^{commit}`)}`,
    );
    if (baseProbe.exitCode !== 0) {
      return this.createDetachedFallback(
        repoDir,
        taskId,
        worktreePath,
        fetch.exitCode !== 0 ? 'review-base-fetch-failed' : 'review-base-unreachable',
        opts.baseSha,
      );
    }
    const added = await this.addDetachedRef(repoDir, worktreePath, opts.baseSha, 'Failed to create review-base worktree');
    if (!added) return this.createDetachedFallback(repoDir, taskId, worktreePath, 'review-base-checkout-failed', opts.baseSha);
    try {
      await this.excludeBaxianDir(repoDir, worktreePath);
      const patchFile = `${worktreePath}/${REVIEW_INBOX_DIR}/.materialize-${uniqueSuffix()}.patch`;
      await this.runner.writeFile(patchFile, opts.patch);
      if (opts.patch.trim() !== '') {
        const apply = await this.runner.exec(
          `cd ${shellQuote(worktreePath)} && git apply --index --binary ${shellQuote(patchFile)}`,
        );
        if (apply.exitCode !== 0) {
          await this.runner.exec(`cd ${shellQuote(worktreePath)} && git reset --hard HEAD && git clean -fd`).catch(() => {});
          const threeWay = await this.runner.exec(
            `cd ${shellQuote(worktreePath)} && git apply --index --3way --binary ${shellQuote(patchFile)}`,
          );
          if (threeWay.exitCode !== 0) {
            return this.createDetachedFallback(repoDir, taskId, worktreePath, 'review-patch-apply-failed', opts.baseSha);
          }
        }
      }
      const staged = await this.runner.exec(`cd ${shellQuote(worktreePath)} && git diff --cached --quiet`);
      if (staged.exitCode === 1) {
        const commitIdentity = [
          `GIT_AUTHOR_NAME=${shellQuote('baxian review')}`,
          'GIT_AUTHOR_EMAIL=baxian-review@localhost',
          `GIT_COMMITTER_NAME=${shellQuote('baxian review')}`,
          'GIT_COMMITTER_EMAIL=baxian-review@localhost',
        ].join(' ');
        const commit = await this.runner.exec(
          `cd ${shellQuote(worktreePath)} && ${commitIdentity} ` +
            `git -c user.email=baxian-review@localhost -c user.name=${shellQuote('baxian review')} ` +
            `commit --no-gpg-sign --no-verify -q -m ${shellQuote(`baxian review head ${opts.headSha}`)}`,
        );
        if (commit.exitCode !== 0) {
          return this.createDetachedFallback(repoDir, taskId, worktreePath, 'review-patch-commit-failed', opts.baseSha);
        }
      } else if (staged.exitCode !== 0) {
        return this.createDetachedFallback(repoDir, taskId, worktreePath, 'review-patch-index-check-failed', opts.baseSha);
      }
      await this.runner.exec(`rm -f ${shellQuote(patchFile)}`).catch(() => {});
      if (await this.verifyTree(worktreePath, opts.headTree)) {
        return { path: worktreePath, mode: 'head' };
      }
      return this.createDetachedFallback(repoDir, taskId, worktreePath, 'review-patch-tree-mismatch', opts.baseSha);
    } catch {
      return this.createDetachedFallback(repoDir, taskId, worktreePath, 'review-patch-materialize-failed', opts.baseSha);
    }
  }

  private async addDetachedRef(
    repoDir: string,
    worktreePath: string,
    ref: string,
    errorPrefix: string,
  ): Promise<boolean> {
    const result = await this.runner.exec(
      `cd ${shellQuote(repoDir)} && git worktree add --detach ${shellQuote(worktreePath)} ${shellQuote(ref)}`,
    );
    if (result.exitCode === 0) return true;
    console.warn(`${errorPrefix}: ${result.stderr}`);
    return false;
  }

  private async createDetachedFallback(
    repoDir: string,
    taskId: string,
    failedWorktreePath: string,
    fallbackReason: string,
    baseSha?: string,
  ): Promise<ReviewHeadWorktreeResult> {
    await this.remove(repoDir, failedWorktreePath).catch(() => {});
    if (baseSha) {
      const atBase = await this.tryDetachAtBaseSha(repoDir, taskId, baseSha);
      if (atBase) return { path: atBase, mode: 'base', fallbackReason };
    }
    return {
      path: await this.createDetachedAtBase(repoDir, taskId),
      mode: 'base',
      fallbackReason,
    };
  }

  private async tryDetachAtBaseSha(
    repoDir: string,
    taskId: string,
    baseSha: string,
  ): Promise<string | null> {
    const reachable = await this.runner.exec(
      `cd ${shellQuote(repoDir)} && git cat-file -e ${shellQuote(`${baseSha}^{commit}`)}`,
    );
    if (reachable.exitCode !== 0) return null;
    const worktreePath = `${repoDir}/${WORKTREE_DIR}/${taskId}-review_${uniqueSuffix()}`;
    if (!(await this.addDetachedRef(repoDir, worktreePath, baseSha, 'Failed to create review-base fallback worktree'))) {
      return null;
    }
    try {
      await this.excludeBaxianDir(repoDir, worktreePath);
      return worktreePath;
    } catch {
      await this.remove(repoDir, worktreePath).catch(() => {});
      return null;
    }
  }

  private async verifyTree(worktreePath: string, expectedTree: string): Promise<boolean> {
    const tree = await this.runner.exec(
      `cd ${shellQuote(worktreePath)} && git rev-parse HEAD^{tree}`,
    );
    return tree.exitCode === 0 && tree.stdout.trim() === expectedTree;
  }

  // Fetch and worktree-add run as separate commands: the network half may be
  // retried by execNetwork, and a retried compound would re-run the add and
  // trip over the branch it created on the first pass. The fetch writes an
  // explicit refspec into the branch's own remote-tracking ref — FETCH_HEAD is
  // repo-global, so a concurrent fetch for another task could overwrite it
  // between the two commands and redirect this worktree to the wrong branch.
  private async fetchBranchTip(
    repoDir: string, remoteBranch: string, errorPrefix: string,
  ): Promise<string> {
    const repo = shellQuote(repoDir);
    const remoteRef = `refs/remotes/origin/${remoteBranch}`;
    const fetch = await execNetwork(
      this.runner,
      `cd ${repo} && ${GIT_NET_ENV} git fetch origin -- ${shellQuote(`+refs/heads/${remoteBranch}:${remoteRef}`)}`,
    );
    if (fetch.exitCode !== 0) {
      throw new Error(`${errorPrefix}: ${fetch.stderr}`);
    }
    const fetched = await this.runner.exec(
      `cd ${repo} && git rev-parse --verify ${shellQuote(remoteRef)}`,
    );
    const sha = fetched.stdout.trim();
    if (fetched.exitCode !== 0 || !sha) {
      throw new Error(`${errorPrefix}: cannot resolve ${remoteRef}: ${fetched.stderr}`);
    }
    return sha;
  }

  private async excludeBaxianDir(repoDir: string, worktreePath: string): Promise<void> {
    const wt = shellQuote(worktreePath);
    const result = await this.runner.exec(
      `cd ${wt} && p="$(git rev-parse --git-path info/exclude)" && mkdir -p "$(dirname "$p")" ` +
        `&& grep -qxF '.baxian/' "$p" 2>/dev/null || printf '%s\\n' '.baxian/' >> "$p"`,
    );
    if (result.exitCode !== 0) {
      await this.remove(repoDir, worktreePath).catch(() => {});
      throw new Error(`Failed to exclude .baxian/ in worktree ${worktreePath}: ${result.stderr}`);
    }
  }

  async removeWithBranch(repoDir: string, worktreePath: string, branchName?: string): Promise<void> {
    await this.remove(repoDir, worktreePath);
    if (branchName) {
      await this.runner.exec(
        `cd ${shellQuote(repoDir)} && git branch -D ${shellQuote(branchName)}`,
      ).catch(() => {});
    }
  }

  async remove(repoDir: string, worktreePath: string): Promise<void> {
    const result = await this.runner.exec(
      `cd ${shellQuote(repoDir)} && git worktree remove ${shellQuote(worktreePath)} --force`,
    );
    if (result.exitCode !== 0) {
      throw new Error(`Failed to remove worktree ${worktreePath}: ${result.stderr}`);
    }
  }

  async list(repoDir: string): Promise<string[]> {
    const result = await this.runner.exec(
      `cd ${shellQuote(repoDir)} && git worktree list --porcelain`,
    );
    return result.stdout.split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice('worktree '.length));
  }
}
