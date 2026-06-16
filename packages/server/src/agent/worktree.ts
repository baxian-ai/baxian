import { randomBytes } from 'node:crypto';
import type { CommandRunner } from './runner.js';
import { shellQuote } from './runner.js';
import { BRANCH_PREFIX, WORKTREE_DIR } from '../shared/index.js';

function uniqueSuffix(): string {
  // 64 bits keeps retry collisions negligible.
  return randomBytes(8).toString('hex');
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
      const remoteCheck = await this.runner.exec(
        `cd ${repo} && git ls-remote --heads origin -- ${shellQuote('refs/heads/' + branch)}`,
      );
      if (remoteCheck.exitCode !== 0) {
        throw new Error(
          `Failed to check remote branch existence: ${remoteCheck.stderr || 'ls-remote exited ' + remoteCheck.exitCode}`,
        );
      }
      if (remoteCheck.stdout.trim()) {
        throw new Error(`Branch ${branch} already exists on remote; use adopt to bind an existing branch`);
      }
      const result = await this.runner.exec(
        `cd ${repo} && git worktree add ${wt} -b ${shellQuote(branch)}${baseClause}`,
      );
      if (result.exitCode !== 0) throw new Error(`Failed to create worktree: ${result.stderr}`);
    } else {
      // -B keeps partial-failure retries idempotent for baxian-controlled branches.
      const result = await this.runner.exec(
        `cd ${repo} && git worktree add ${wt} -B ${shellQuote(branch)}${baseClause}`,
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

    const result = await this.runner.exec(
      `cd ${repo} && git fetch origin -- ${shellQuote(remoteBranch)} && git worktree add -b ${shellQuote(remoteBranch)} ${wt} FETCH_HEAD`,
    );

    if (result.exitCode !== 0) {
      if (result.stderr.includes('already exists')) {
        await this.adoptExistingLocal(repoDir, worktreePath, remoteBranch);
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
    repoDir: string, worktreePath: string, remoteBranch: string,
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
    const remoteSha = await this.runner.exec(
      `cd ${repo} && git rev-parse FETCH_HEAD`,
    );
    if (localSha.exitCode !== 0 || remoteSha.exitCode !== 0) {
      throw new Error('Failed to resolve branch SHAs for consistency check');
    }
    const local = localSha.stdout.trim();
    const remote = remoteSha.stdout.trim();

    if (local !== remote) {
      const mergeBase = await this.runner.exec(
        `cd ${repo} && git merge-base --is-ancestor ${shellQuote('refs/heads/' + remoteBranch)} FETCH_HEAD`,
      );
      if (mergeBase.exitCode === 0) {
        const ff = await this.runner.exec(
          `cd ${repo} && git update-ref ${shellQuote('refs/heads/' + remoteBranch)} FETCH_HEAD`,
        );
        if (ff.exitCode !== 0) throw new Error(`Fast-forward failed: ${ff.stderr}`);
      } else {
        throw new Error(
          `Local branch ${remoteBranch} (${local.slice(0, 8)}) diverges from ` +
          `remote (${remote.slice(0, 8)}); resolve manually before adopting`,
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
    // FETCH_HEAD works regardless of whether the remote refspec updates refs/remotes/origin/*.
    const result = await this.runner.exec(
      `cd ${shellQuote(repoDir)} ` +
        `&& git fetch origin -- ${shellQuote(remoteBranch)} ` +
        `&& git worktree add --detach ${shellQuote(worktreePath)} FETCH_HEAD`,
    );
    if (result.exitCode !== 0) throw new Error(`Failed to create detached worktree: ${result.stderr}`);
    await this.excludeBaxianDir(repoDir, worktreePath);
    return worktreePath;
  }

  // Server-mode QA workspace: detached at the remote default branch — never
  // fetches or checks out the dev's bx/<taskId> branch (review input is injected).
  async createDetachedAtBase(repoDir: string, taskId: string): Promise<string> {
    const worktreePath = `${repoDir}/${WORKTREE_DIR}/${taskId}-review_${uniqueSuffix()}`;
    const result = await this.runner.exec(
      `cd ${shellQuote(repoDir)} ` +
        `&& git fetch origin --quiet ` +
        `&& git worktree add --detach ${shellQuote(worktreePath)} "$(git symbolic-ref --short refs/remotes/origin/HEAD)"`,
    );
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create base-detached worktree: ${result.stderr}`);
    }
    await this.excludeBaxianDir(repoDir, worktreePath);
    return worktreePath;
  }

  // 过程产物（spec.md/review JSON）不得随 agent 的 git add -A 进入用户 PR；info/exclude 是不触碰 tracked 文件的单点防护。
  private async excludeBaxianDir(repoDir: string, worktreePath: string): Promise<void> {
    const wt = shellQuote(worktreePath);
    const result = await this.runner.exec(
      `cd ${wt} && p="$(git rev-parse --git-path info/exclude)" && mkdir -p "$(dirname "$p")" ` +
        `&& grep -qxF '.baxian/' "$p" 2>/dev/null || printf '%s\\n' '.baxian/' >> "$p"`,
    );
    if (result.exitCode !== 0) {
      // 失败必须回收刚建的 worktree：caller 此刻还没拿到 path，泄漏的 checkout 会让同 task 重试的 add -B 永远撞 busy branch。
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
    // Surface failures instead of swallowing them — a silently-failed remove leaves the branch checked
    // out, so the next `git worktree add -B bx/<taskId>` hits a busy branch. Callers wrap in try/catch.
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
