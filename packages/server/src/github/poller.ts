import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { BaxianConfig, PollerHealth, PollerSnapshot, ProjectConfig } from '../shared/index.js';
import { isGitHubRepo, repoSlug } from '../shared/index.js';
import type { CommandRunner } from '../agent/runner.js';
import type { MappedEvent } from './mapper.js';
import { isManagedPr, reviewVerdict, extractReviewPassToken } from './mapper.js';
import { PeriodicTaskRunner } from '../timing/periodic-task-runner.js';

export interface PollerEntry {
  projectId: string;
  repo: string;
  statePath?: string;
}

export type StatePathProvider = (project: ProjectConfig) => string | undefined;

export type KnownPrNumbersProvider = (projectId: string) => Promise<ReadonlySet<number>>;

export interface PollerOptions {
  runner: CommandRunner;
  onEvent: (projectId: string, event: MappedEvent) => void | Promise<void>;
  knownPrNumbersFor?: KnownPrNumbersProvider;
}

export function pollerStatePathFor(stateDir: string, repo: string): string {
  return join(stateDir, 'state', `poller-${encodeURIComponent(repoSlug(repo).toLowerCase())}.json`);
}

const DEGRADED_FAILURE_THRESHOLD = 1;
const FAILED_FAILURE_THRESHOLD = 3;

export function computePollerHealth(
  consecutiveFailures: number,
  lastPollEndedAt: string | undefined,
): PollerHealth {
  if (!lastPollEndedAt && consecutiveFailures === 0) return 'unknown';
  if (consecutiveFailures >= FAILED_FAILURE_THRESHOLD) return 'failed';
  if (consecutiveFailures >= DEGRADED_FAILURE_THRESHOLD) return 'degraded';
  return 'healthy';
}

interface EntryStatus {
  isPolling: boolean;
  lastPollStartedAt?: string;
  lastPollEndedAt?: string;
  lastPollDurationMs?: number;
  lastErrorAt?: string;
  lastErrorMessage?: string;
  consecutiveFailures: number;
}

function emptyStatus(): EntryStatus {
  return { isPolling: false, consecutiveFailures: 0 };
}

interface PollerCursor {
  pullsByHead: Record<string, string>;
  legacyAdoptionPending?: Record<string, string>;
  reviews: string[];
  reviewComments: number[];
  issueComments: number[];
  mergedPrs: number[];
}

interface InternalEntry extends PollerEntry {
  cursor: PollerCursor;
  loaded: boolean;
  status: EntryStatus;
}

function emptyCursor(): PollerCursor {
  return {
    pullsByHead: {},
    legacyAdoptionPending: {},
    reviews: [],
    reviewComments: [],
    issueComments: [],
    mergedPrs: [],
  };
}

const SHA_REGEX = /^[0-9a-f]{40}$/;

const POLL_EXEC_TIMEOUT_MS = 60_000;

const CURSOR_RETENTION = 5000;

function trimCursorList<T>(list: T[]): T[] {
  return list.length > CURSOR_RETENTION ? list.slice(-CURSOR_RETENTION) : list;
}

function parseSlurped<T>(stdout: string): T[] | null {
  try {
    const parsed = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return null;
    return (parsed as T[][]).flat();
  } catch {
    return null;
  }
}

function trimStderr(stderr: string, maxLen = 500): string {
  const trimmed = stderr.trim();
  return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen)}…(truncated)` : trimmed;
}

export class GitHubPoller {
  private runner: CommandRunner;
  private onEvent: (projectId: string, event: MappedEvent) => void | Promise<void>;
  private knownPrNumbersFor?: KnownPrNumbersProvider;
  private entries: InternalEntry[] = [];
  private periodicRunner?: PeriodicTaskRunner;
  private intervalMs?: number;
  private isPolling = false;
  private lifecycleHook?: () => void;

  constructor(options: PollerOptions) {
    this.runner = options.runner;
    this.onEvent = options.onEvent;
    this.knownPrNumbersFor = options.knownPrNumbersFor;
  }

  add(entry: PollerEntry): InternalEntry {
    const internal: InternalEntry = {
      ...entry,
      repo: repoSlug(entry.repo),
      cursor: emptyCursor(),
      loaded: false,
      status: emptyStatus(),
    };
    this.entries.push(internal);
    return internal;
  }

  remove(projectId: string): boolean {
    const idx = this.entries.findIndex(e => e.projectId === projectId);
    if (idx < 0) return false;
    this.entries.splice(idx, 1);
    return true;
  }

  replaceConfig(
    config: BaxianConfig,
    options: { statePathFor?: StatePathProvider } = {},
  ): void {
    const wantedByRepo = new Map<string, ProjectConfig>();
    for (const project of config.project) {
      if (!isGitHubRepo(project.repo)) continue;
      const key = repoSlug(project.repo).toLowerCase();
      if (!wantedByRepo.has(key)) wantedByRepo.set(key, project);
    }

    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (!wantedByRepo.has(this.entries[i].repo.toLowerCase())) {
        this.entries.splice(i, 1);
      }
    }

    const existingByRepo = new Map<string, InternalEntry>();
    for (const e of this.entries) existingByRepo.set(e.repo.toLowerCase(), e);

    for (const [key, project] of wantedByRepo) {
      const existing = existingByRepo.get(key);
      if (existing) {
        existing.projectId = project.id;
        existing.repo = repoSlug(project.repo);
      } else {
        this.add({
          projectId: project.id,
          repo: project.repo,
          statePath: options.statePathFor?.(project),
        });
      }
    }

    const nextIntervalMs = config.server.githubPollIntervalMs;
    this.intervalMs = nextIntervalMs;
    this.periodicRunner?.reschedule(nextIntervalMs);
  }

  setLifecycleHook(fn: () => void): void {
    this.lifecycleHook = fn;
  }

  private fireLifecycle(): void {
    if (!this.lifecycleHook) return;
    try {
      this.lifecycleHook();
    } catch (err) {
      console.error('[GitHubPoller] lifecycle hook threw:', err);
    }
  }

  snapshots(): PollerSnapshot[] {
    return this.entries.map(e => {
      const snap: PollerSnapshot = {
        repo: e.repo,
        projectId: e.projectId,
        intervalMs: this.intervalMs ?? 0,
        isPolling: e.status.isPolling,
        consecutiveFailures: e.status.consecutiveFailures,
        health: computePollerHealth(e.status.consecutiveFailures, e.status.lastPollEndedAt),
      };
      if (e.status.lastPollStartedAt) snap.lastPollStartedAt = e.status.lastPollStartedAt;
      if (e.status.lastPollEndedAt) snap.lastPollEndedAt = e.status.lastPollEndedAt;
      if (e.status.lastPollDurationMs !== undefined) snap.lastPollDurationMs = e.status.lastPollDurationMs;
      if (e.status.lastErrorAt) snap.lastErrorAt = e.status.lastErrorAt;
      if (e.status.lastErrorMessage) snap.lastErrorMessage = e.status.lastErrorMessage;
      return snap;
    });
  }

  private async loadEntry(entry: InternalEntry): Promise<void> {
    if (entry.loaded) return;
    if (!entry.statePath) {
      entry.loaded = true;
      return;
    }
    try {
      const raw = await readFile(entry.statePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<PollerCursor>;
      entry.cursor = { ...emptyCursor(), ...parsed };
      entry.loaded = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        entry.loaded = true;
        return;
      }
      throw err;
    }
  }

  private async saveEntry(entry: InternalEntry): Promise<void> {
    if (!entry.statePath) return;
    entry.cursor.reviews = trimCursorList(entry.cursor.reviews);
    entry.cursor.reviewComments = trimCursorList(entry.cursor.reviewComments);
    entry.cursor.issueComments = trimCursorList(entry.cursor.issueComments);
    entry.cursor.mergedPrs = trimCursorList(entry.cursor.mergedPrs);
    await mkdir(dirname(entry.statePath), { recursive: true });
    const tmp = `${entry.statePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(entry.cursor, null, 2));
    await rename(tmp, entry.statePath);
  }

  start(intervalMs: number): void {
    if (this.periodicRunner !== undefined) return;
    this.intervalMs = intervalMs;
    this.periodicRunner = new PeriodicTaskRunner({
      name: 'GitHubPoller',
      intervalMs,
      run: () => this.pollGuarded(),
      onOverlap: () => this.warnOverlappingCycle(),
      onError: err => console.error('[GitHubPoller] cycle failed:', err),
    });
    this.periodicRunner.start();
  }

  stop(): void {
    if (this.periodicRunner === undefined) return;
    this.periodicRunner.stop();
    this.periodicRunner = undefined;
  }

  async poll(): Promise<void> {
    for (const entry of this.entries) {
      try {
        await this.pollOne(entry);
      } catch (err) {
        console.warn(
          `[GitHubPoller:${entry.repo}] cycle failed; will retry next interval:`,
          err,
        );
      }
    }
  }

  private async pollGuarded(): Promise<void> {
    if (this.isPolling) {
      this.warnOverlappingCycle();
      return;
    }
    this.isPolling = true;
    try {
      await this.poll();
    } finally {
      this.isPolling = false;
    }
  }

  private warnOverlappingCycle(): void {
    console.warn('[GitHubPoller] previous cycle still running; skipping this tick');
  }

  private async runSubPolls(
    entry: InternalEntry,
    pr: { number: number; head: { ref: string; sha: string }; html_url: string },
    cycleErrors: string[],
  ): Promise<void> {
    try {
      await this.pollReviewsForPr(entry, pr.number, pr.head.ref, pr.html_url, pr.head.sha);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      cycleErrors.push(msg);
      console.error(
        `[GitHubPoller:${entry.repo}] pollReviewsForPr for #${pr.number} failed; will retry next cycle:`,
        err,
      );
    }
    try {
      await this.pollReviewCommentsForPr(entry, pr.number, pr.head.ref, pr.html_url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      cycleErrors.push(msg);
      console.error(
        `[GitHubPoller:${entry.repo}] pollReviewCommentsForPr for #${pr.number} failed; will retry next cycle:`,
        err,
      );
    }
    try {
      await this.pollIssueCommentsForPr(entry, pr.number, pr.head.ref, pr.html_url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      cycleErrors.push(msg);
      console.error(
        `[GitHubPoller:${entry.repo}] pollIssueCommentsForPr for #${pr.number} failed; will retry next cycle:`,
        err,
      );
    }
  }

  async pollOne(entry: InternalEntry): Promise<void> {
    entry.status.isPolling = true;
    entry.status.lastPollStartedAt = new Date().toISOString();
    const startedMs = Date.now();
    this.fireLifecycle();
    try {
      await this.loadEntry(entry);
      await this.pollPullRequests(entry);
      await this.saveEntry(entry);
      entry.status.consecutiveFailures = 0;
    } catch (err) {
      entry.status.consecutiveFailures += 1;
      entry.status.lastErrorAt = new Date().toISOString();
      entry.status.lastErrorMessage = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      entry.status.lastPollEndedAt = new Date().toISOString();
      entry.status.lastPollDurationMs = Date.now() - startedMs;
      entry.status.isPolling = false;
      this.fireLifecycle();
    }
  }

  async pollPullRequests(entry: InternalEntry): Promise<void> {
    const url = `repos/${entry.repo}/pulls?state=all&sort=updated&direction=desc&per_page=100`;
    const cmd = `gh api '${url}'`;
    const result = await this.runner.exec(cmd, { timeout: POLL_EXEC_TIMEOUT_MS });
    if (result.exitCode !== 0) {
      throw new Error(
        `pollPullRequests failed (exit=${result.exitCode}): ${trimStderr(result.stderr)}`,
      );
    }

    let prs: Array<{
      number: number;
      html_url: string;
      head: { ref: string; sha: string; repo?: { full_name?: string } | null };
      base: { repo?: { full_name?: string } };
      state: 'open' | 'closed';
      merged_at: string | null;
      updated_at: string;
    }>;
    try {
      prs = JSON.parse(result.stdout);
    } catch (err) {
      throw new Error(
        `pollPullRequests JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!Array.isArray(prs)) {
      throw new Error(`pollPullRequests: expected array, got ${typeof prs}`);
    }

    const knownPrNumbers = await this.knownPrNumbersFor?.(entry.projectId)
      ?? new Set<number>();

    const seenMerged = new Set(entry.cursor.mergedPrs);
    const cycleErrors: string[] = [];

    for (const pr of prs) {
      if (!isManagedPr(pr.head.ref, pr.number, knownPrNumbers)) continue;
      // baxian only ever opens PRs from its own repo; a head repo that differs from — or is missing
      // (a deleted/invisible fork) — the base repo means an external PR that merely reused a bx/ or
      // known branch name. Fail closed: only a confirmed same-repo PR is ours.
      const headRepo = pr.head.repo?.full_name;
      const baseRepo = pr.base?.repo?.full_name;
      if (!headRepo || headRepo !== baseRepo) continue;

      if (pr.state === 'closed' && pr.merged_at && !seenMerged.has(pr.number)) {
        try {
          await this.onEvent(entry.projectId, {
            type: 'pr.merged',
            repo: entry.repo,
            data: { prNumber: pr.number, prUrl: pr.html_url, branch: pr.head.ref },
          });
          seenMerged.add(pr.number);
          entry.cursor.mergedPrs.push(pr.number);
        } catch (err) {
          cycleErrors.push(err instanceof Error ? err.message : String(err));
          console.error(
            `[GitHubPoller:${entry.repo}] emit pr.merged for #${pr.number} failed; will retry next cycle:`,
            err,
          );
        }
        continue;
      }

      if (pr.state === 'open') {
        const lastSha = entry.cursor.pullsByHead[pr.head.ref];
        let emitOk = true;
        if (!lastSha) {
          try {
            await this.onEvent(entry.projectId, {
              type: 'pr.created',
              repo: entry.repo,
              data: { prNumber: pr.number, prUrl: pr.html_url, branch: pr.head.ref, headSha: pr.head.sha },
            });
          } catch (err) {
            cycleErrors.push(err instanceof Error ? err.message : String(err));
            console.error(
              `[GitHubPoller:${entry.repo}] emit pr.created for #${pr.number} failed; will retry next cycle:`,
              err,
            );
            emitOk = false;
          }
        } else if (!SHA_REGEX.test(lastSha)) {
          const pending = entry.cursor.legacyAdoptionPending ?? {};
          entry.cursor.legacyAdoptionPending = pending;
          const tentative = pending[pr.head.ref];
          if (!tentative) {
            pending[pr.head.ref] = pr.head.sha;
            console.warn(
              `[GitHubPoller:${entry.repo}] tentative legacy adoption for ${pr.head.ref}: ` +
              `observed sha=${pr.head.sha} (will confirm next cycle)`,
            );
            continue;
          }
          if (tentative === pr.head.sha) {
            delete pending[pr.head.ref];
            entry.cursor.pullsByHead[pr.head.ref] = pr.head.sha;
            console.warn(
              `[GitHubPoller:${entry.repo}] confirmed legacy adoption for ${pr.head.ref}: ` +
              `sha=${pr.head.sha} (no event emitted)`,
            );
            await this.runSubPolls(entry, pr, cycleErrors);
            continue;
          }
          delete pending[pr.head.ref];
          try {
            await this.onEvent(entry.projectId, {
              type: 'pr.updated',
              repo: entry.repo,
              data: { prNumber: pr.number, prUrl: pr.html_url, branch: pr.head.ref, kind: 'push', headSha: pr.head.sha },
            });
          } catch (err) {
            cycleErrors.push(err instanceof Error ? err.message : String(err));
            console.error(
              `[GitHubPoller:${entry.repo}] emit pr.updated (post-adoption) for #${pr.number} failed; will retry next cycle:`,
              err,
            );
            emitOk = false;
          }
        } else if (lastSha !== pr.head.sha) {
          try {
            await this.onEvent(entry.projectId, {
              type: 'pr.updated',
              repo: entry.repo,
              data: { prNumber: pr.number, prUrl: pr.html_url, branch: pr.head.ref, kind: 'push', headSha: pr.head.sha },
            });
          } catch (err) {
            cycleErrors.push(err instanceof Error ? err.message : String(err));
            console.error(
              `[GitHubPoller:${entry.repo}] emit pr.updated for #${pr.number} failed; will retry next cycle:`,
              err,
            );
            emitOk = false;
          }
        }
        if (!emitOk) continue;
        entry.cursor.pullsByHead[pr.head.ref] = pr.head.sha;
        await this.runSubPolls(entry, pr, cycleErrors);
      }
    }

    if (cycleErrors.length > 0) {
      try {
        await this.saveEntry(entry);
      } catch (saveErr) {
        console.error(
          `[GitHubPoller:${entry.repo}] saveEntry during cycle-fail recovery failed:`,
          saveErr,
        );
      }
      throw new Error(
        `pollPullRequests: ${cycleErrors.length} failure(s); first: ${cycleErrors[0]}`,
      );
    }
  }

  async pollReviewsForPr(
    entry: InternalEntry,
    prNumber: number,
    branch: string,
    prUrl: string,
    currentHeadSha?: string,
  ): Promise<void> {
    const cmd = `gh api repos/${entry.repo}/pulls/${prNumber}/reviews --paginate --slurp`;
    const result = await this.runner.exec(cmd, { timeout: POLL_EXEC_TIMEOUT_MS });
    if (result.exitCode !== 0) {
      throw new Error(
        `pollReviewsForPr #${prNumber} failed (exit=${result.exitCode}): ${trimStderr(result.stderr)}`,
      );
    }

    const reviews = parseSlurped<{
      id: number;
      state: string;
      body?: string | null;
      commit_id?: string | null;
      submitted_at?: string | null;
    }>(result.stdout);
    if (!reviews) {
      throw new Error(
        `pollReviewsForPr #${prNumber}: failed to parse slurped response`,
      );
    }

    const seen = new Set(entry.cursor.reviews);
    const newlyEmitted: string[] = [];
    let emitFailures = 0;
    let firstEmitError: string | undefined;
    for (const review of reviews) {
      const key = `${prNumber}-${review.id}`;
      if (seen.has(key)) continue;
      const verdict = reviewVerdict({ state: review.state });
      if (!verdict) continue;
      const reviewedHeadSha = review.commit_id ?? undefined;
      const submittedAt = review.submitted_at ?? undefined;
      const reviewPassToken = extractReviewPassToken(review.body);
      try {
        await this.onEvent(entry.projectId, {
          type: 'review.submitted',
          repo: entry.repo,
          data: {
            action: verdict.action,
            prNumber,
            prUrl,
            branch,
            ...(reviewedHeadSha ? { headSha: reviewedHeadSha } : {}),
            ...(currentHeadSha ? { currentHeadSha } : {}),
            ...(submittedAt ? { submittedAt } : {}),
            ...(reviewPassToken ? { reviewPassToken } : {}),
          },
        });
        seen.add(key);
        newlyEmitted.push(key);
      } catch (err) {
        emitFailures += 1;
        if (!firstEmitError) firstEmitError = err instanceof Error ? err.message : String(err);
        console.error(`[poller] emit review.submitted for review ${review.id} failed; will retry next cycle:`, err);
      }
    }
    if (newlyEmitted.length > 0) {
      entry.cursor.reviews.push(...newlyEmitted);
      await this.saveEntry(entry);
    }
    if (emitFailures > 0) {
      throw new Error(
        `pollReviewsForPr #${prNumber}: ${emitFailures} review event emit(s) failed; first: ${firstEmitError}`,
      );
    }
  }

  async pollReviewCommentsForPr(
    entry: InternalEntry,
    prNumber: number,
    branch: string,
    prUrl: string,
  ): Promise<void> {
    const cmd = `gh api repos/${entry.repo}/pulls/${prNumber}/comments --paginate --slurp`;
    const result = await this.runner.exec(cmd, { timeout: POLL_EXEC_TIMEOUT_MS });
    if (result.exitCode !== 0) {
      throw new Error(
        `pollReviewCommentsForPr #${prNumber} failed (exit=${result.exitCode}): ${trimStderr(result.stderr)}`,
      );
    }

    const comments = parseSlurped<{
      id: number;
      body?: string | null;
      in_reply_to_id?: number | null;
    }>(result.stdout);
    if (!comments) {
      throw new Error(
        `pollReviewCommentsForPr #${prNumber}: failed to parse slurped response`,
      );
    }

    const seen = new Set(entry.cursor.reviewComments);
    const newlyEmitted: number[] = [];
    let emitFailures = 0;
    let firstEmitError: string | undefined;
    for (const c of comments) {
      if (seen.has(c.id)) continue;
      try {
        await this.onEvent(entry.projectId, {
          type: 'pr.updated',
          repo: entry.repo,
          data: {
            prNumber,
            prUrl,
            branch,
            commentId: c.id,
            kind: 'review-comment',
            ...(c.in_reply_to_id !== undefined && c.in_reply_to_id !== null
              ? { reviewCommentReply: true }
              : {}),
          },
        });
        seen.add(c.id);
        newlyEmitted.push(c.id);
      } catch (err) {
        emitFailures += 1;
        if (!firstEmitError) firstEmitError = err instanceof Error ? err.message : String(err);
        console.error(`[poller] emit pr.updated for review-comment ${c.id} failed; will retry next cycle:`, err);
      }
    }
    if (newlyEmitted.length > 0) {
      entry.cursor.reviewComments.push(...newlyEmitted);
      await this.saveEntry(entry);
    }
    if (emitFailures > 0) {
      throw new Error(
        `pollReviewCommentsForPr #${prNumber}: ${emitFailures} review-comment event emit(s) failed; first: ${firstEmitError}`,
      );
    }
  }

  async pollIssueCommentsForPr(
    entry: InternalEntry,
    prNumber: number,
    branch: string,
    prUrl: string,
  ): Promise<void> {
    const cmd = `gh api repos/${entry.repo}/issues/${prNumber}/comments --paginate --slurp`;
    const result = await this.runner.exec(cmd, { timeout: POLL_EXEC_TIMEOUT_MS });
    if (result.exitCode !== 0) {
      throw new Error(
        `pollIssueCommentsForPr #${prNumber} failed (exit=${result.exitCode}): ${trimStderr(result.stderr)}`,
      );
    }

    const comments = parseSlurped<{ id: number; body?: string | null }>(result.stdout);
    if (!comments) {
      throw new Error(
        `pollIssueCommentsForPr #${prNumber}: failed to parse slurped response`,
      );
    }

    const seen = new Set(entry.cursor.issueComments);
    const newlyEmitted: number[] = [];
    let emitFailures = 0;
    let firstEmitError: string | undefined;
    for (const c of comments) {
      if (seen.has(c.id)) continue;
      try {
        await this.onEvent(entry.projectId, {
          type: 'pr.updated',
          repo: entry.repo,
          data: {
            prNumber,
            prUrl,
            branch,
            commentId: c.id,
            kind: 'comment',
          },
        });
        newlyEmitted.push(c.id);
      } catch (err) {
        emitFailures += 1;
        if (!firstEmitError) firstEmitError = err instanceof Error ? err.message : String(err);
        console.error(
          `[poller] emit pr.updated for comment ${c.id} failed; will retry next cycle:`,
          err,
        );
      }
    }
    if (newlyEmitted.length > 0) {
      entry.cursor.issueComments.push(...newlyEmitted);
      await this.saveEntry(entry);
    }
    if (emitFailures > 0) {
      throw new Error(
        `pollIssueCommentsForPr #${prNumber}: ${emitFailures} issue-comment event emit(s) failed; first: ${firstEmitError}`,
      );
    }
  }
}
