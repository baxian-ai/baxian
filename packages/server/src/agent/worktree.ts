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

  async create(repoDir: string, taskId: string, baseRef?: string): Promise<string> {
    const worktreePath = `${repoDir}/${WORKTREE_DIR}/${taskId}_${uniqueSuffix()}`;
    const branchName = `${BRANCH_PREFIX}${taskId}`;
    const baseClause = baseRef ? ` ${shellQuote(baseRef)}` : '';
    // -B keeps partial-failure retries idempotent.
    const result = await this.runner.exec(
      `cd ${shellQuote(repoDir)} && git worktree add ${shellQuote(worktreePath)} -B ${shellQuote(branchName)}${baseClause}`,
    );
    if (result.exitCode !== 0) throw new Error(`Failed to create worktree: ${result.stderr}`);
    await this.excludeBaxianDir(repoDir, worktreePath);
    return worktreePath;
  }

  async createDetached(repoDir: string, taskId: string, remoteBranch: string): Promise<string> {
    const worktreePath = `${repoDir}/${WORKTREE_DIR}/${taskId}-review_${uniqueSuffix()}`;
    // FETCH_HEAD works regardless of whether the remote refspec updates refs/remotes/origin/*.
    const result = await this.runner.exec(
      `cd ${shellQuote(repoDir)} ` +
        `&& git fetch origin ${shellQuote(remoteBranch)} ` +
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
