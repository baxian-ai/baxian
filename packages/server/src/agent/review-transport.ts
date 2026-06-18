import {
  isRecord,
  MAX_READ_FILE_BYTES,
  REVIEW_EXCHANGE_DIR,
  SPEC_DOC_RELPATH,
  type AgentConfig,
  type Finding,
  type ReviewFindings,
  type ReviewResponse,
  type TaskPhase,
  type TaskState,
} from '../shared/index.js';
import type { CommandRunner } from './runner.js';

// Runner-based review I/O for server mode (spec §4): the server actively reads
// diffs/spec docs from the dev machine and findings/response files from agent
// worktrees. Reads and deletes are separate so the caller can persist to
// ReviewStore between them (read → validate → store → delete, spec §4 ordering).

export class ReviewExchangeError extends Error {
  constructor(
    public readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'ReviewExchangeError';
  }
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface ReadContentResult {
  content: string;
  diffstat?: string;
  /** Merge-base SHA the diff was computed against (audit only, spec §4). */
  baseSha?: string;
  defaultBranch?: string;
}

export interface ReviewTransportDeps {
  createRunnerFor(agent: AgentConfig): CommandRunner;
  resolveWorktree(agentId: string): string | undefined;
}


const SEVERITIES = new Set(['critical', 'major', 'minor']);
const VERDICTS = new Set(['approve', 'request-changes']);
const ACTIONS = new Set(['fix', 'reject', 'out-of-scope']);

export function validateReviewFindings(raw: unknown): ReviewFindings {
  if (!isRecord(raw)) throw new ReviewExchangeError('schema', 'findings: not an object');
  if (typeof raw.round !== 'number' || !Number.isInteger(raw.round) || raw.round < 1) {
    throw new ReviewExchangeError('schema', 'findings.round must be a positive integer');
  }
  if (typeof raw.verdict !== 'string' || !VERDICTS.has(raw.verdict)) {
    throw new ReviewExchangeError('schema', `findings.verdict invalid: ${String(raw.verdict)}`);
  }
  if (!Array.isArray(raw.findings)) {
    throw new ReviewExchangeError('schema', 'findings.findings must be an array');
  }
  const ids = new Set<string>();
  for (const f of raw.findings) {
    if (!isRecord(f)) throw new ReviewExchangeError('schema', 'finding: not an object');
    if (typeof f.id !== 'string' || f.id.trim() === '') {
      throw new ReviewExchangeError('schema', 'finding.id must be a non-empty string');
    }
    if (ids.has(f.id)) throw new ReviewExchangeError('schema', `duplicate finding id: ${f.id}`);
    ids.add(f.id);
    if (typeof f.severity !== 'string' || !SEVERITIES.has(f.severity)) {
      throw new ReviewExchangeError('schema', `finding.severity invalid: ${String(f.severity)}`);
    }
    if (typeof f.message !== 'string' || f.message.trim() === '') {
      throw new ReviewExchangeError('schema', `finding.message missing for ${f.id}`);
    }
  }
  // Verdict/finding consistency: approve may only carry minor suggestions, and a
  // change request without findings gives dev nothing to act on.
  const verdict = raw.verdict as ReviewFindings['verdict'];
  if (verdict === 'approve') {
    const blocking = (raw.findings as Finding[]).find(f => f.severity !== 'minor');
    if (blocking) {
      throw new ReviewExchangeError(
        'verdict-conflict',
        `approve with ${blocking.severity} finding ${blocking.id}`,
      );
    }
  } else if ((raw.findings as Finding[]).length === 0) {
    throw new ReviewExchangeError('verdict-conflict', 'request-changes with no findings');
  }
  return raw as unknown as ReviewFindings;
}

export function validateReviewResponse(raw: unknown): ReviewResponse {
  if (!isRecord(raw)) throw new ReviewExchangeError('schema', 'response: not an object');
  if (typeof raw.round !== 'number' || !Number.isInteger(raw.round) || raw.round < 1) {
    throw new ReviewExchangeError('schema', 'response.round must be a positive integer');
  }
  if (!Array.isArray(raw.responses)) {
    throw new ReviewExchangeError('schema', 'response.responses must be an array');
  }
  const responseIds = new Set<string>();
  for (const r of raw.responses) {
    if (!isRecord(r)) throw new ReviewExchangeError('schema', 'response item: not an object');
    if (typeof r.findingId !== 'string' || r.findingId.trim() === '') {
      throw new ReviewExchangeError('schema', 'response.findingId must be a non-empty string');
    }
    // Coverage uses a Set — a duplicate would let conflicting fix/reject evidence
    // for the same finding sail through to QA recheck.
    if (responseIds.has(r.findingId)) {
      throw new ReviewExchangeError('schema', `duplicate response findingId: ${r.findingId}`);
    }
    responseIds.add(r.findingId);
    if (typeof r.action !== 'string' || !ACTIONS.has(r.action)) {
      throw new ReviewExchangeError('schema', `response.action invalid: ${String(r.action)}`);
    }
    if (typeof r.rationale !== 'string' || r.rationale.trim() === '') {
      throw new ReviewExchangeError('schema', `response.rationale missing for ${r.findingId}`);
    }
  }
  return raw as unknown as ReviewResponse;
}

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= maxBytes) return { text, truncated: false };
  let cut = maxBytes;
  while (cut > 0 && (buf[cut]! & 0xc0) === 0x80) cut--;
  return { text: buf.subarray(0, cut).toString('utf8'), truncated: true };
}

export class ReviewTransport {
  constructor(private readonly deps: ReviewTransportDeps) {}

  async readContent(task: TaskState, devAgent: AgentConfig, phase: TaskPhase): Promise<ReadContentResult> {
    const wt = this.requireWorktree(devAgent.id);
    const runner = this.deps.createRunnerFor(devAgent);
    if (phase === 'spec') {
      const r = await runner.exec(`cat ${shellQuote(`${wt}/${SPEC_DOC_RELPATH}`)}`);
      if (r.exitCode !== 0) {
        throw new ReviewExchangeError('spec-missing', `spec doc unreadable: ${r.stderr.trim()}`);
      }
      return { content: r.stdout };
    }
    const cd = `cd ${shellQuote(wt)} && `;
    // Every step is load-bearing: a stale fetch silently reviews against an old
    // base; a failed merge-base/stat poisons the audit fields. Fail loud on each.
    const fetch = await runner.exec(`${cd}git fetch origin --quiet`);
    if (fetch.exitCode !== 0) {
      throw new ReviewExchangeError('fetch-failed', `git fetch failed: ${fetch.stderr.trim()}`);
    }
    const db = await runner.exec(`${cd}git symbolic-ref --short refs/remotes/origin/HEAD`);
    if (db.exitCode !== 0) {
      throw new ReviewExchangeError('default-branch-failed', `origin/HEAD unresolved: ${db.stderr.trim()}`);
    }
    const defaultBranch = db.stdout.trim().replace(/^origin\//, '') || 'main';
    const base = `origin/${defaultBranch}`;
    const sha = await runner.exec(`${cd}git merge-base ${shellQuote(base)} HEAD`);
    if (sha.exitCode !== 0) {
      throw new ReviewExchangeError('merge-base-failed', `git merge-base failed: ${sha.stderr.trim()}`);
    }
    const stat = await runner.exec(`${cd}git diff --stat ${shellQuote(base)}...HEAD`);
    if (stat.exitCode !== 0) {
      throw new ReviewExchangeError('diffstat-failed', `git diff --stat failed: ${stat.stderr.trim()}`);
    }
    const diff = await runner.exec(`${cd}git diff ${shellQuote(base)}...HEAD`);
    if (diff.exitCode !== 0) {
      throw new ReviewExchangeError('diff-failed', `git diff failed: ${diff.stderr.trim()}`);
    }
    return {
      content: diff.stdout,
      diffstat: stat.stdout,
      baseSha: sha.stdout.trim(),
      defaultBranch,
    };
  }

  async readFindings(task: TaskState, qaAgent: AgentConfig): Promise<ReviewFindings | null> {
    const raw = await this.readExchangeFile(qaAgent, 'findings.json');
    if (raw === null) return null;
    return validateReviewFindings(this.parseJson(raw, 'findings.json'));
  }

  async readResponse(task: TaskState, devAgent: AgentConfig): Promise<ReviewResponse | null> {
    const raw = await this.readExchangeFile(devAgent, 'response.json');
    if (raw === null) return null;
    return validateReviewResponse(this.parseJson(raw, 'response.json'));
  }

  async deleteFindings(qaAgent: AgentConfig): Promise<void> {
    await this.deleteExchangeFile(qaAgent, 'findings.json');
  }

  async deleteResponse(devAgent: AgentConfig): Promise<void> {
    await this.deleteExchangeFile(devAgent, 'response.json');
  }

  // Reviewed-head capture at publish time; confirm passes it as mergePr's
  // --match-head-commit guard so a post-gate push can never be merged blind.
  async readHeadSha(devAgent: AgentConfig): Promise<string> {
    const wt = this.requireWorktree(devAgent.id);
    const runner = this.deps.createRunnerFor(devAgent);
    const r = await runner.exec(`cd ${shellQuote(wt)} && git rev-parse HEAD`);
    if (r.exitCode !== 0 || r.stdout.trim() === '') {
      throw new ReviewExchangeError('head-failed', `git rev-parse HEAD failed: ${r.stderr.trim()}`);
    }
    return r.stdout.trim();
  }

  async readFileRange(
    devAgent: AgentConfig,
    file: string,
    startLine: number,
    endLine: number,
  ): Promise<string> {
    if (file.startsWith('/')) throw new ReviewExchangeError('abs-path', file);
    if (file.split('/').includes('..')) throw new ReviewExchangeError('traversal', file);
    if (/[\x00-\x1f]/.test(file)) throw new ReviewExchangeError('ctrl-char', JSON.stringify(file));
    if (file.startsWith('-')) throw new ReviewExchangeError('leading-dash', file);
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine)
      || startLine < 1 || endLine < startLine || endLine - startLine > 200) {
      throw new ReviewExchangeError('range', `${startLine}-${endLine}`);
    }
    const wt = this.requireWorktree(devAgent.id);
    const runner = this.deps.createRunnerFor(devAgent);
    // Symlink containment without `realpath -m` (absent on stock macOS/BSD):
    // walk every path component up to the worktree root and reject any symlink.
    // Stricter than resolve-and-compare — a worktree-internal symlink is also
    // refused — but POSIX-portable and QA targets are regular files anyway.
    const symlinkWalk =
      `p=${shellQuote(`${wt}/${file}`)}; ` +
      `while [ "$p" != ${shellQuote(wt)} ] && [ "$p" != "/" ] && [ -n "$p" ]; do ` +
      `if [ -L "$p" ]; then exit 9; fi; p=$(dirname "$p"); done`;
    const walk = await runner.exec(symlinkWalk);
    if (walk.exitCode !== 0) {
      throw new ReviewExchangeError('escape', file);
    }
    const r = await runner.exec(
      `sed -n ${shellQuote(`${startLine},${endLine}p`)} -- ${shellQuote(`${wt}/${file}`)}`,
    );
    if (r.exitCode !== 0) {
      throw new ReviewExchangeError('read-failed', r.stderr.trim());
    }
    const { text, truncated } = truncateUtf8(r.stdout, MAX_READ_FILE_BYTES);
    return truncated ? `${text}\n[truncated]` : text;
  }

  private async readExchangeFile(agent: AgentConfig, name: string): Promise<string | null> {
    const wt = this.requireWorktree(agent.id);
    const runner = this.deps.createRunnerFor(agent);
    const r = await runner.exec(`cat ${shellQuote(`${wt}/${REVIEW_EXCHANGE_DIR}/${name}`)}`);
    if (r.exitCode !== 0) {
      if (/no such file/i.test(r.stderr)) return null;
      throw new ReviewExchangeError('read-failed', `${name}: ${r.stderr.trim()}`);
    }
    return r.stdout;
  }

  private async deleteExchangeFile(agent: AgentConfig, name: string): Promise<void> {
    const wt = this.requireWorktree(agent.id);
    const runner = this.deps.createRunnerFor(agent);
    await runner.exec(`rm -f ${shellQuote(`${wt}/${REVIEW_EXCHANGE_DIR}/${name}`)}`);
  }

  private parseJson(raw: string, label: string): unknown {
    try {
      return JSON.parse(raw);
    } catch {
      throw new ReviewExchangeError('parse', `${label}: invalid JSON`);
    }
  }

  private requireWorktree(agentId: string): string {
    const wt = this.deps.resolveWorktree(agentId);
    if (!wt) throw new ReviewExchangeError('no-worktree', `agent ${agentId} has no worktree`);
    return wt.endsWith('/') ? wt.slice(0, -1) : wt;
  }
}
