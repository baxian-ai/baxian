import { randomBytes } from 'node:crypto';
import { BRANCH_PREFIX, isValidBranchName } from '../shared/index.js';
import { execNetwork, GIT_NET_ENV } from './net-exec.js';
import type { CommandRunner } from './runner.js';
import { shellQuote } from './runner.js';
import { ensureBaxianRuntimeDirsSafe } from './repo-store.js';

export interface AutoDeleteIdentity {
  taskId?: string;
  taskBranch?: string;
  branchCreatedByBaxian?: boolean;
  actualRef?: string;
}

export function isAutoDeletableTaskBranch(identity: AutoDeleteIdentity): boolean {
  if (!identity.taskId || !identity.branchCreatedByBaxian) return false;
  const branch = `${BRANCH_PREFIX}${identity.taskId}`;
  return identity.taskBranch === branch && identity.actualRef === `refs/heads/${branch}`;
}

export class DirtyWorkdirError extends Error {
  constructor(workdir: string) {
    super(`Workdir ${workdir} has staged, tracked, untracked, conflicted, or dirty submodule changes`);
    this.name = 'DirtyWorkdirError';
  }
}

export class ReviewHeadMismatchError extends Error {
  constructor(
    public readonly branch: string,
    public readonly expectedHeadSha: string,
    public readonly actualHeadSha: string,
  ) {
    super(`Fetched review head mismatch for ${branch}: expected ${expectedHeadSha}, got ${actualHeadSha}`);
    this.name = 'ReviewHeadMismatchError';
  }
}

export interface ReviewHeadOpts {
  baseSha?: string;
  headSha?: string;
  headTree?: string;
  patch: string;
}

export interface ReviewCheckoutResult {
  mode: 'head' | 'base';
  fallbackReason?: string;
}

export type BranchCleanupResult =
  | { status: 'deleted'; remoteTipSha?: string }
  | { status: 'skipped'; reason: string }
  | { status: 'pending'; reason: string };

export class BranchManager {
  constructor(private runner: CommandRunner) {}

  async assertClean(workdir: string): Promise<void> {
    const result = await this.runner.exec(
      `git -C ${shellQuote(workdir)} status --porcelain=v1 -z ` +
        `--untracked-files=all --ignore-submodules=none`,
    );
    if (result.exitCode !== 0) {
      throw new Error(`git status failed in ${workdir}: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
    }
    if (result.stdout.length > 0) throw new DirtyWorkdirError(workdir);
  }

  async switchToTaskBranch(
    workdir: string,
    taskId: string,
    branch: string,
    branchCreatedByBaxian: boolean,
    opts: { restorableRemoteTip?: string; requireExistingWork?: boolean } = {},
  ): Promise<void> {
    if (!isValidBranchName(branch)) throw new Error(`Invalid task branch: ${branch}`);
    if (branchCreatedByBaxian && branch !== `${BRANCH_PREFIX}${taskId}`) {
      throw new Error(`baxian task ${taskId} must use exact branch ${BRANCH_PREFIX}${taskId}`);
    }
    await this.assertClean(workdir);
    await this.fetch(workdir);
    const localRef = `refs/heads/${branch}`;
    const local = await this.runner.exec(
      `git -C ${shellQuote(workdir)} show-ref --verify --quiet ${shellQuote(localRef)}`,
    );
    if (local.exitCode === 0) {
      await this.verifyTaskBranchMarker(workdir, branch, taskId);
      await this.ensureTaskBranchUpstream(workdir, branch);
      await this.switch(workdir, `--no-guess ${shellQuote(branch)}`);
    } else if (local.exitCode === 1) {
      if (opts.restorableRemoteTip) {
        // 凭据存在说明本地 ref 是 release 时主动清理的、工作在远端；远端也消失时绝不能
        // 从 origin/HEAD 重建同名空分支顶替，否则已推送的上一轮成果被静默丢弃
        if (!await this.remoteBranchExists(workdir, branch)) {
          throw new Error(
            `Remote ${branch} vanished after its local ref was cleaned up `
            + `(expected tip ${opts.restorableRemoteTip}); refusing to recreate the task branch from scratch`,
          );
        }
        await this.restoreTaskBranchFromRemote(workdir, taskId, branch, opts.restorableRemoteTip);
      } else if (opts.requireExistingWork) {
        // continuation 场景本地分支必须在（或持有清理凭据）：都没有说明上一轮工作已不可
        // 证明，新建空分支会把丢失伪装成可继续
        throw new Error(
          `Local branch ${branch} is missing with no cleanup credential; refusing to recreate it mid-task`,
        );
      } else {
        await this.assertRemoteBranchAbsent(workdir, branch);
        const baseSha = await this.resolveCommit(workdir, 'origin/HEAD');
        await this.switch(
          workdir,
          `--no-track -c ${shellQuote(branch)} ${shellQuote(baseSha)}`,
        );
        await this.markTaskBranch(workdir, branch, taskId);
        const head = await this.resolveCommit(workdir, 'HEAD');
        if (head !== baseSha) {
          throw new Error(`New branch ${branch} started at ${head}, expected base ${baseSha}`);
        }
      }
    } else {
      throw new Error(`Failed to probe local branch ${branch}: ${local.stderr.trim()}`);
    }
    await this.verifyRef(workdir, localRef);
  }

  // 只信删除时刻持久化的 remoteTipSha 凭据：远端 tip 必须仍包含它，防同名陌生分支或 force-push 重写被采纳
  private async restoreTaskBranchFromRemote(
    workdir: string,
    taskId: string,
    branch: string,
    cleanedRemoteTipSha: string,
  ): Promise<void> {
    const remoteRef = `refs/remotes/origin/${branch}`;
    const fetched = await execNetwork(
      this.runner,
      `${GIT_NET_ENV} git -C ${shellQuote(workdir)} fetch origin -- ` +
        `${shellQuote(`+refs/heads/${branch}:${remoteRef}`)}`,
    );
    if (fetched.exitCode !== 0) {
      throw new Error(`Failed to fetch ${branch} for checkout restore: ${fetched.stderr.trim()}`);
    }
    const remoteTip = await this.resolveCommit(workdir, remoteRef);
    const contained = await this.runner.exec(
      `git -C ${shellQuote(workdir)} merge-base --is-ancestor ` +
        `${shellQuote(cleanedRemoteTipSha)} ${shellQuote(remoteTip)}`,
    );
    if (contained.exitCode === 1) {
      throw new Error(
        `Remote ${branch} no longer contains the cleaned-up local tip ${cleanedRemoteTipSha}; refusing to restore`,
      );
    }
    if (contained.exitCode !== 0) {
      throw new Error(`Remote ancestry probe failed for ${branch}: ${contained.stderr.trim()}`);
    }
    await this.switch(workdir, `--no-guess -c ${shellQuote(branch)} --track ${shellQuote(remoteRef)}`);
    await this.markTaskBranch(workdir, branch, taskId);
  }

  async switchToRemoteBranchDetached(
    workdir: string,
    branch: string,
    expectedHeadSha: string,
  ): Promise<void> {
    if (!isValidBranchName(branch)) throw new Error(`Invalid remote branch: ${branch}`);
    if (!/^[0-9a-f]{40,64}$/i.test(expectedHeadSha)) {
      throw new Error(`Review branch ${branch} is missing a valid expected head SHA`);
    }
    await this.assertClean(workdir);
    const remoteRef = `refs/remotes/origin/${branch}`;
    const fetch = await execNetwork(
      this.runner,
      `${GIT_NET_ENV} git -C ${shellQuote(workdir)} fetch origin -- ` +
        `${shellQuote(`+refs/heads/${branch}:${remoteRef}`)}`,
    );
    if (fetch.exitCode !== 0) throw new Error(`Failed to fetch branch ${branch}: ${fetch.stderr.trim()}`);
    const headSha = await this.resolveCommit(workdir, remoteRef);
    if (headSha !== expectedHeadSha) {
      throw new ReviewHeadMismatchError(branch, expectedHeadSha, headSha);
    }
    await this.switchDetached(workdir, headSha);
  }

  async switchToDefaultDetached(workdir: string): Promise<void> {
    await this.assertClean(workdir);
    await this.fetch(workdir);
    await this.switchDetached(workdir, await this.resolveCommit(workdir, 'origin/HEAD'));
  }

  async parkOnDefaultDetached(workdir: string): Promise<void> {
    await this.assertClean(workdir);
    await this.switchDetached(workdir, await this.resolveCommit(workdir, 'origin/HEAD'));
  }

  async materializeReviewHead(workdir: string, opts: ReviewHeadOpts): Promise<ReviewCheckoutResult> {
    await this.assertClean(workdir);
    if (!opts.baseSha || !opts.headSha || !opts.headTree) {
      throw new Error('Server review head metadata is incomplete; refusing an unverified checkout');
    }
    const head = await this.runner.exec(
      `git -C ${shellQuote(workdir)} cat-file -e ${shellQuote(`${opts.headSha}^{commit}`)}`,
    );
    if (head.exitCode === 0) {
      await this.switchDetached(workdir, opts.headSha);
      await this.verifyTree(workdir, opts.headTree);
      return { mode: 'head' };
    }

    await this.fetch(workdir);
    await this.resolveCommit(workdir, opts.baseSha);
    await this.switchDetached(workdir, opts.baseSha);
    await ensureBaxianRuntimeDirsSafe(this.runner, workdir);
    const patchFile = `${workdir}/.baxian/review-inbox/.materialize-${randomBytes(8).toString('hex')}.patch`;
    await this.runner.writeFile(patchFile, opts.patch);
    let operationError: unknown;
    try {
      if (opts.patch.trim() !== '') {
        const apply = await this.runner.exec(
          `git -C ${shellQuote(workdir)} apply --index --binary ${shellQuote(patchFile)}`,
        );
        if (apply.exitCode !== 0) {
          throw new Error(`Review patch apply failed: ${apply.stderr.trim()}`);
        }
      }
      const staged = await this.runner.exec(
        `git -C ${shellQuote(workdir)} diff --cached --quiet`,
      );
      if (staged.exitCode === 1) await this.commitReviewHead(workdir, opts.headSha);
      else if (staged.exitCode !== 0) throw new Error(`Review index probe failed: ${staged.stderr.trim()}`);
      await this.verifyTree(workdir, opts.headTree);
      return { mode: 'head' };
    } catch (err) {
      operationError = err;
      throw err;
    } finally {
      const removed = await this.runner.exec(`rm -f ${shellQuote(patchFile)}`);
      if (removed.exitCode !== 0) {
        const cleanupError = new Error(`Review patch cleanup failed: ${removed.stderr.trim()}`);
        if (operationError !== undefined) {
          throw new AggregateError(
            [operationError, cleanupError],
            'Review head materialization and patch cleanup both failed',
          );
        }
        throw cleanupError;
      }
    }
  }

  async cleanupTaskBranch(
    workdir: string,
    identity: Omit<AutoDeleteIdentity, 'actualRef'>,
    assertOwner: () => Promise<void>,
  ): Promise<BranchCleanupResult> {
    if (!identity.taskId || !identity.taskBranch) {
      return { status: 'skipped', reason: 'missing task branch identity' };
    }
    const actualRef = `refs/heads/${identity.taskBranch}`;
    if (!isAutoDeletableTaskBranch({ ...identity, actualRef })) {
      return { status: 'skipped', reason: 'branch is not provably baxian-owned' };
    }
    await this.assertClean(workdir);
    const exists = await this.runner.exec(
      `git -C ${shellQuote(workdir)} show-ref --verify --quiet ${shellQuote(actualRef)}`,
    );
    if (exists.exitCode === 1) return { status: 'deleted' };
    if (exists.exitCode !== 0) {
      return { status: 'pending', reason: `local ref probe failed: ${exists.stderr.trim()}` };
    }
    const marker = await this.runner.exec(
      `git -C ${shellQuote(workdir)} config --local --get ` +
        `${shellQuote(`branch.${identity.taskBranch}.baxian-task-id`)}`,
    );
    if (marker.exitCode === 1) {
      return { status: 'skipped', reason: 'local branch lacks the exact baxian ownership marker' };
    }
    if (marker.exitCode !== 0) {
      return {
        status: 'pending',
        reason: `baxian ownership marker probe failed: ${marker.stderr.trim()}`,
      };
    }
    if (marker.stdout.trim() !== identity.taskId) {
      return { status: 'skipped', reason: 'local branch lacks the exact baxian ownership marker' };
    }

    const localTip = await this.resolveCommit(workdir, actualRef);
    const remoteRef = `refs/remotes/origin/${identity.taskBranch}`;
    try {
      if (!await this.remoteBranchExists(workdir, identity.taskBranch)) {
        return {
          status: 'skipped',
          reason: 'remote branch is absent; preserving the local branch without retry',
        };
      }
    } catch (err) {
      return {
        status: 'pending',
        reason: `remote branch probe failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    let fetched;
    try {
      fetched = await execNetwork(
        this.runner,
        `${GIT_NET_ENV} git -C ${shellQuote(workdir)} fetch origin -- ` +
          `${shellQuote(`+refs/heads/${identity.taskBranch}:${remoteRef}`)}`,
      );
    } catch (err) {
      return {
        status: 'pending',
        reason: `remote fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (fetched.exitCode !== 0) {
      try {
        if (!await this.remoteBranchExists(workdir, identity.taskBranch)) {
          return {
            status: 'skipped',
            reason: 'remote branch disappeared during cleanup; preserving the local branch without retry',
          };
        }
      } catch (err) {
        return {
          status: 'pending',
          reason: `remote branch re-probe failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      return { status: 'pending', reason: `remote branch fetch failed: ${fetched.stderr.trim()}` };
    }
    const upstream = await this.runner.exec(
      `git -C ${shellQuote(workdir)} rev-parse --symbolic-full-name ` +
        `${shellQuote(`${identity.taskBranch}@{upstream}`)}`,
    );
    if (upstream.exitCode !== 0 || upstream.stdout.trim() !== remoteRef) {
      return { status: 'pending', reason: `upstream is not exact ${remoteRef}` };
    }
    const remoteTip = await this.resolveCommit(workdir, remoteRef);
    const contained = await this.runner.exec(
      `git -C ${shellQuote(workdir)} merge-base --is-ancestor ` +
        `${shellQuote(localTip)} ${shellQuote(remoteTip)}`,
    );
    if (contained.exitCode === 1) {
      return { status: 'pending', reason: 'remote branch does not contain the local tip' };
    }
    if (contained.exitCode !== 0) {
      return {
        status: 'pending',
        reason: `remote ancestry probe failed: ${contained.stderr.trim()}`,
      };
    }
    await assertOwner();
    await this.assertClean(workdir);
    await this.switchDetached(workdir, await this.resolveCommit(workdir, 'origin/HEAD'));
    await assertOwner();
    const deleted = await this.runner.exec(
      `git -C ${shellQuote(workdir)} branch -d -- ${shellQuote(identity.taskBranch)}`,
    );
    if (deleted.exitCode !== 0) {
      return {
        status: 'pending',
        reason: `git branch -d refused: ${deleted.stderr.trim()}`,
      };
    }
    const remaining = await this.runner.exec(
      `git -C ${shellQuote(workdir)} show-ref --verify --quiet ${shellQuote(actualRef)}`,
    );
    if (remaining.exitCode === 0) {
      return { status: 'pending', reason: 'local ref still exists after deletion' };
    }
    if (remaining.exitCode === 1) return { status: 'deleted', remoteTipSha: remoteTip };
    return {
      status: 'pending',
      reason: `local ref deletion verification failed: ${remaining.stderr.trim()}`,
    };
  }

  async currentRef(workdir: string): Promise<string | null> {
    const result = await this.runner.exec(`git -C ${shellQuote(workdir)} symbolic-ref -q HEAD`);
    if (result.exitCode === 1) return null;
    if (result.exitCode !== 0) throw new Error(`Failed to resolve current ref: ${result.stderr.trim()}`);
    return result.stdout.trim();
  }

  async listLocalTaskRefs(workdir: string): Promise<string[]> {
    const result = await this.runner.exec(
      `git -C ${shellQuote(workdir)} for-each-ref --format=${shellQuote('%(refname)')} ` +
        `${shellQuote(`refs/heads/${BRANCH_PREFIX}`)}`,
    );
    if (result.exitCode !== 0) {
      throw new Error(`Failed to list local baxian branch candidates: ${result.stderr.trim()}`);
    }
    return result.stdout
      .split('\n')
      .map(ref => ref.trim())
      .filter(ref => ref.startsWith(`refs/heads/${BRANCH_PREFIX}`));
  }

  private async assertRemoteBranchAbsent(workdir: string, branch: string): Promise<void> {
    if (await this.remoteBranchExists(workdir, branch)) {
      throw new Error(`Branch ${branch} already exists on origin; refusing to create it`);
    }
  }

  private async remoteBranchExists(workdir: string, branch: string): Promise<boolean> {
    const result = await execNetwork(
      this.runner,
      `${GIT_NET_ENV} git -C ${shellQuote(workdir)} ls-remote --heads origin -- ` +
        `${shellQuote(`refs/heads/${branch}`)}`,
    );
    if (result.exitCode !== 0) {
      throw new Error(`Failed to probe remote branch ${branch}: ${result.stderr.trim()}`);
    }
    return result.stdout.trim() !== '';
  }

  private async verifyUpstreamIfPresent(workdir: string, branch: string): Promise<void> {
    const expected = `refs/remotes/origin/${branch}`;
    const upstream = await this.readUpstream(workdir, branch);
    if (upstream && upstream !== expected) {
      throw new Error(`Branch ${branch} tracks ${upstream}, expected ${expected}`);
    }
  }

  private async ensureTaskBranchUpstream(workdir: string, branch: string): Promise<void> {
    await this.verifyUpstreamIfPresent(workdir, branch);
    if (await this.readUpstream(workdir, branch)) return;
    const configured = await this.runner.exec(
      `git -C ${shellQuote(workdir)} config --local ${shellQuote(`branch.${branch}.remote`)} origin && ` +
        `git -C ${shellQuote(workdir)} config --local ${shellQuote(`branch.${branch}.merge`)} ` +
        `${shellQuote(`refs/heads/${branch}`)}`,
    );
    if (configured.exitCode !== 0) {
      throw new Error(`Failed to configure exact upstream for ${branch}: ${configured.stderr.trim()}`);
    }
  }

  private async readUpstream(workdir: string, branch: string): Promise<string> {
    const localRef = `refs/heads/${branch}`;
    const result = await this.runner.exec(
      `git -C ${shellQuote(workdir)} for-each-ref --format=${shellQuote('%(upstream)')} ` +
        `${shellQuote(localRef)}`,
    );
    if (result.exitCode !== 0) {
      throw new Error(`Failed to inspect upstream for ${branch}: ${result.stderr.trim()}`);
    }
    return result.stdout.trim();
  }

  private async markTaskBranch(workdir: string, branch: string, taskId: string): Promise<void> {
    const marker = shellQuote(`branch.${branch}.baxian-task-id`);
    const configured = await this.runner.exec(
      `git -C ${shellQuote(workdir)} config --local ${marker} ${shellQuote(taskId)} && ` +
        `git -C ${shellQuote(workdir)} config --local ${shellQuote(`branch.${branch}.remote`)} origin && ` +
        `git -C ${shellQuote(workdir)} config --local ${shellQuote(`branch.${branch}.merge`)} ` +
        `${shellQuote(`refs/heads/${branch}`)}`,
    );
    if (configured.exitCode !== 0) {
      throw new Error(`Failed to record baxian task binding for ${branch}: ${configured.stderr.trim()}`);
    }
  }

  private async verifyTaskBranchMarker(workdir: string, branch: string, taskId: string): Promise<void> {
    const result = await this.runner.exec(
      `git -C ${shellQuote(workdir)} config --local --get ` +
        `${shellQuote(`branch.${branch}.baxian-task-id`)}`,
    );
    if (result.exitCode !== 0 || result.stdout.trim() !== taskId) {
      throw new Error(
        `Local branch ${branch} already exists without baxian task binding proof for task ${taskId}`,
      );
    }
  }

  private async fetch(workdir: string): Promise<void> {
    const result = await execNetwork(
      this.runner,
      `${GIT_NET_ENV} git -C ${shellQuote(workdir)} fetch origin --prune`,
    );
    if (result.exitCode !== 0) throw new Error(`git fetch failed in ${workdir}: ${result.stderr.trim()}`);
  }

  private async switch(workdir: string, args: string): Promise<void> {
    const result = await this.runner.exec(`git -C ${shellQuote(workdir)} switch ${args}`);
    if (result.exitCode !== 0) throw new Error(`git switch failed in ${workdir}: ${result.stderr.trim()}`);
  }

  private async switchDetached(workdir: string, commit: string): Promise<void> {
    await this.switch(workdir, `--detach ${shellQuote(commit)}`);
    const head = await this.resolveCommit(workdir, 'HEAD');
    if (head !== commit) throw new Error(`Detached checkout mismatch: expected ${commit}, got ${head}`);
  }

  private async resolveCommit(workdir: string, ref: string): Promise<string> {
    const result = await this.runner.exec(
      `git -C ${shellQuote(workdir)} rev-parse --verify ${shellQuote(`${ref}^{commit}`)}`,
    );
    const sha = result.stdout.trim();
    if (result.exitCode !== 0 || !/^[0-9a-f]{40,64}$/i.test(sha)) {
      throw new Error(`Cannot resolve commit ${ref} in ${workdir}: ${result.stderr.trim()}`);
    }
    return sha;
  }

  private async verifyRef(workdir: string, expected: string): Promise<void> {
    const actual = await this.currentRef(workdir);
    if (actual !== expected) throw new Error(`Checkout mismatch: expected ${expected}, got ${actual ?? 'detached HEAD'}`);
  }

  private async verifyTree(workdir: string, expected: string): Promise<void> {
    const result = await this.runner.exec(
      `git -C ${shellQuote(workdir)} rev-parse --verify ${shellQuote('HEAD^{tree}')}`,
    );
    if (result.exitCode !== 0 || result.stdout.trim() !== expected) {
      throw new Error(`Review head tree mismatch: expected ${expected}, got ${result.stdout.trim() || '<unresolved>'}`);
    }
  }

  private async commitReviewHead(workdir: string, headSha: string): Promise<void> {
    const identity = [
      `GIT_AUTHOR_NAME=${shellQuote('baxian review')}`,
      'GIT_AUTHOR_EMAIL=baxian-review@localhost',
      `GIT_COMMITTER_NAME=${shellQuote('baxian review')}`,
      'GIT_COMMITTER_EMAIL=baxian-review@localhost',
    ].join(' ');
    const result = await this.runner.exec(
      `${identity} git -C ${shellQuote(workdir)} -c user.email=baxian-review@localhost ` +
        `-c user.name=${shellQuote('baxian review')} commit --no-gpg-sign --no-verify -q ` +
        `-m ${shellQuote(`baxian review head ${headSha}`)}`,
    );
    if (result.exitCode !== 0) throw new Error(`Review patch commit failed: ${result.stderr.trim()}`);
  }
}
