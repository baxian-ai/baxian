import { shellQuote, type ExecResult } from './runner.js';

export interface LineageCandidate {
  taskId: string;
  branch: string;
}

export interface LineageViolation {
  taskId: string;
  branch: string;
  sha: string;
}

type Exec = (cmd: string) => Promise<ExecResult>;

export async function findForeignTaskTip(
  exec: Exec,
  worktree: string,
  baseSha: string,
  candidates: LineageCandidate[],
): Promise<LineageViolation | null> {
  const revs = await exec(
    `git -C ${shellQuote(worktree)} rev-list ${shellQuote(`${baseSha}..HEAD`)}`,
  );
  if (revs.exitCode !== 0) {
    throw new Error(`lineage rev-list failed in ${worktree}: ${revs.stderr.trim()}`);
  }
  const exclusive = new Set(revs.stdout.split('\n').filter(Boolean));
  if (exclusive.size === 0) return null;

  for (const candidate of candidates) {
    // Compare against the candidate's whole base..tip chain, not just its tip:
    // after contaminating us the foreign branch may advance further, moving its
    // tip out of our history while the shared commits remain embedded.
    // Both refs are probed independently: the local branch may hold unpushed
    // work the remote lacks, while a bare clone's local heads are frozen
    // snapshots that fetch never updates — only refs/remotes/origin/* is fresh.
    const refs = [
      `refs/heads/${candidate.branch}`,
      `refs/remotes/origin/${candidate.branch}`,
    ];
    for (const ref of refs) {
      const foreign = await exec(
        `git -C ${shellQuote(worktree)} rev-list ${shellQuote(`${baseSha}..${ref}`)}`,
      );
      if (foreign.exitCode !== 0) continue;
      const sha = foreign.stdout
        .split('\n')
        .map(line => line.trim())
        .find(line => line !== '' && exclusive.has(line));
      if (!sha) continue;
      // Shared commits with a candidate that forked FROM this branch are this
      // branch's own work carried downstream, not foreign work embedded here —
      // the contamination victim must stay publishable. Diverged shapes
      // (neither contains the other) stay flagged: ownership is undecidable.
      const downstream = await exec(
        `git -C ${shellQuote(worktree)} merge-base --is-ancestor HEAD ${shellQuote(ref)}`,
      );
      if (downstream.exitCode === 0) continue;
      return { taskId: candidate.taskId, branch: candidate.branch, sha };
    }
  }
  return null;
}
