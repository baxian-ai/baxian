import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findForeignTaskTip } from '../../src/agent/lineage.js';
import type { ExecResult } from '../../src/agent/runner.js';

const exec = async (cmd: string): Promise<ExecResult> => {
  try {
    const stdout = execSync(cmd, { encoding: 'utf8', stdio: 'pipe' });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', exitCode: e.status ?? 1 };
  }
};

let tmp: string;
let repo: string;
let baseSha: string;
let commitA: string;
let commitA2: string;

function git(cmd: string): string {
  return execSync(`git -C '${repo}' ${cmd}`, { encoding: 'utf8', stdio: 'pipe' }).trim();
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'lineage-'));
  repo = join(tmp, 'repo');
  execSync(`git init -b main '${repo}'`, { stdio: 'pipe' });
  git('config user.email t@example.com');
  git('config user.name t');
  git('commit --allow-empty -m base');
  baseSha = git('rev-parse HEAD');

  git('checkout -b bx/task-1');
  git('commit --allow-empty -m "commit a"');
  commitA = git('rev-parse HEAD');

  git('checkout main');
  git('checkout -b bx/task-2-clean');
  git('commit --allow-empty -m "commit b"');

  git('checkout bx/task-1');
  git('checkout -b bx/task-2-tainted');
  git('commit --allow-empty -m "commit b on top of a"');

  git('checkout bx/task-1');
  git('checkout -b bx/task-1-advanced');
  git('commit --allow-empty -m "commit a2 after contamination"');
  commitA2 = git('rev-parse HEAD');

  git(`update-ref refs/remotes/origin/bx/task-remote ${commitA}`);

  git(`branch bx/task-stale ${baseSha}`);
  git(`update-ref refs/remotes/origin/bx/task-stale ${commitA}`);
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('findForeignTaskTip', () => {
  it('reports the foreign task whose branch tip is embedded in this branch history', async () => {
    git('checkout bx/task-2-tainted');
    const violation = await findForeignTaskTip(exec, repo, baseSha, [
      { taskId: 'task-1', branch: 'bx/task-1' },
    ]);
    expect(violation).toEqual({ taskId: 'task-1', branch: 'bx/task-1', sha: commitA });
  });

  it('still reports the foreign task after its branch advances past the shared commit', async () => {
    git('checkout bx/task-2-tainted');
    const violation = await findForeignTaskTip(exec, repo, baseSha, [
      { taskId: 'task-1-adv', branch: 'bx/task-1-advanced' },
    ]);
    expect(commitA2).not.toBe(commitA);
    expect(violation).toEqual({ taskId: 'task-1-adv', branch: 'bx/task-1-advanced', sha: commitA });
  });

  it('checks the remote-tracking ref even when a stale local branch parked at base exists', async () => {
    git('checkout bx/task-2-tainted');
    const violation = await findForeignTaskTip(exec, repo, baseSha, [
      { taskId: 'task-stale', branch: 'bx/task-stale' },
    ]);
    expect(violation).toEqual({ taskId: 'task-stale', branch: 'bx/task-stale', sha: commitA });
  });

  it('falls back to the remote-tracking ref when the candidate has no local branch', async () => {
    git('checkout bx/task-2-tainted');
    const violation = await findForeignTaskTip(exec, repo, baseSha, [
      { taskId: 'task-remote', branch: 'bx/task-remote' },
    ]);
    expect(violation).toEqual({ taskId: 'task-remote', branch: 'bx/task-remote', sha: commitA });
  });

  it('does not flag a downstream task that forked from this branch (victim stays publishable)', async () => {
    git('checkout bx/task-1');
    const violation = await findForeignTaskTip(exec, repo, baseSha, [
      { taskId: 'task-2', branch: 'bx/task-2-tainted' },
    ]);
    expect(violation).toBeNull();
  });

  it('returns null when the branch only contains its own commits', async () => {
    git('checkout bx/task-2-clean');
    const violation = await findForeignTaskTip(exec, repo, baseSha, [
      { taskId: 'task-1', branch: 'bx/task-1' },
    ]);
    expect(violation).toBeNull();
  });

  it('ignores a candidate whose tip is already part of the base history', async () => {
    git('checkout bx/task-2-tainted');
    const violation = await findForeignTaskTip(exec, repo, baseSha, [
      { taskId: 'task-main', branch: 'main' },
    ]);
    expect(violation).toBeNull();
  });

  it('skips candidates whose branch does not exist locally', async () => {
    git('checkout bx/task-2-clean');
    const violation = await findForeignTaskTip(exec, repo, baseSha, [
      { taskId: 'task-9', branch: 'bx/task-9' },
    ]);
    expect(violation).toBeNull();
  });

  it('returns the first hit when multiple candidates are embedded', async () => {
    git('checkout bx/task-2-tainted');
    const violation = await findForeignTaskTip(exec, repo, baseSha, [
      { taskId: 'task-9', branch: 'bx/task-9' },
      { taskId: 'task-1', branch: 'bx/task-1' },
    ]);
    expect(violation).toEqual({ taskId: 'task-1', branch: 'bx/task-1', sha: commitA });
  });

  it('throws when the base revision cannot be resolved', async () => {
    git('checkout bx/task-2-clean');
    await expect(
      findForeignTaskTip(exec, repo, 'deadbeef'.repeat(5), [
        { taskId: 'task-1', branch: 'bx/task-1' },
      ]),
    ).rejects.toThrow(/rev-list/i);
  });

  it('returns null without probing candidates when the branch has no exclusive commits', async () => {
    git('checkout main');
    const violation = await findForeignTaskTip(exec, repo, baseSha, [
      { taskId: 'task-1', branch: 'bx/task-1' },
    ]);
    expect(violation).toBeNull();
  });
});
