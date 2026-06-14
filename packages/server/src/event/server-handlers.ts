import {
  DIFF_LARGE_THRESHOLD,
  MAX_INLINE_CONTENT_BYTES,
} from '../shared/index.js';
import type {
  BaxianEvent,
  Finding,
  ReviewFindings,
  ReviewRound,
  TaskState,
} from '../shared/index.js';
import type { EventBus } from './bus.js';
import type { AgentManager } from '../agent/manager.js';
import { buildBatches, countLines, splitDiffByFile, type DiffFile } from '../agent/diff-split.js';
import { ReviewExchangeError } from '../agent/review-transport.js';
import type { PhaseSignalKind } from '../agent/phase-signal.js';

// Server review mode event handlers (spec §6). Fully independent from the
// github-mode handler chain in handlers.ts — control flow here is command-driven
// (server reads agent machines via runners), not poller-driven.

// Keep injected diffs inside the 80KB prompt ceiling with headroom for skills
// and instructions; oversize content truncates with the read-file escape hatch.
const PROMPT_CONTENT_BYTE_BUDGET = 56 * 1024;

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= maxBytes) return { text, truncated: false };
  let cut = maxBytes;
  while (cut > 0 && (buf[cut]! & 0xc0) === 0x80) cut--;
  return { text: buf.subarray(0, cut).toString('utf8'), truncated: true };
}

function aggregateBatchFindings(batches: ReviewFindings[], round: number): ReviewFindings {
  const findings: Finding[] = [];
  const used = new Set<string>();
  for (const [i, batch] of batches.entries()) {
    for (const f of batch.findings) {
      // Recheck rounds restate unresolved findings under their already-namespaced
      // id (b0-f-1); re-prefixing would drift the id every round (b0-b0-f-1).
      let id = /^b\d+-/.test(f.id) ? f.id : `b${i}-${f.id}`;
      // A restated b0-f-1 and a NEW batch-0 f-1 would otherwise collide — one
      // response id would ambiguously cover two findings. Disambiguate with the
      // round (then a counter) so coverage stays one-to-one.
      if (used.has(id)) {
        let candidate = `b${i}-r${round}-${f.id}`;
        for (let n = 2; used.has(candidate); n++) candidate = `b${i}-r${round}-${f.id}-${n}`;
        id = candidate;
      }
      used.add(id);
      findings.push(id === f.id ? f : { ...f, id });
    }
  }
  const verdict = batches.some(b => b.verdict === 'request-changes') ? 'request-changes' : 'approve';
  return { round, verdict, findings };
}

function coverageGaps(findings: ReviewFindings, responseIds: Set<string>): { missing: string[]; unknown: string[] } {
  const findingIds = new Set(findings.findings.map(f => f.id));
  return {
    missing: [...findingIds].filter(id => !responseIds.has(id)),
    unknown: [...responseIds].filter(id => !findingIds.has(id)),
  };
}

async function emitIntervention(
  bus: EventBus,
  task: TaskState,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    await bus.emit({
      id: '',
      type: 'human.intervention',
      timestamp: new Date().toISOString(),
      projectId: task.projectId,
      agentId: task.agentId,
      taskId: task.id,
      data,
    });
  } catch (err) {
    console.warn('[ServerEventHandler] intervention emit failed:', err);
  }
}

interface Gate {
  task: TaskState;
}

async function gate(
  bus: EventBus,
  manager: AgentManager,
  event: BaxianEvent,
  expect: {
    status: TaskState['status'];
    phase: 'spec' | 'code' | 'any';
    // spec review 总走 server 中转，不受 task.reviewMode 约束。
    requireServerMode: boolean;
  },
): Promise<Gate | null> {
  if (!event.taskId) return null;
  const task = await manager.getTask(event.taskId);
  if (!task) return null;
  if (expect.requireServerMode && task.reviewMode !== 'server') {
    console.warn(`[ServerEventHandler] ${event.type} ignored: task ${task.id} not in server mode`);
    return null;
  }
  const token = event.data?.token as string | undefined;
  const phaseOk = expect.phase === 'any'
    || (expect.phase === 'spec' ? task.phase === 'spec' : task.phase !== 'spec');
  if (task.status !== expect.status || !phaseOk || !token || token !== task.signalToken) {
    await emitIntervention(bus, task, {
      phase: `${event.type}-stale`,
      taskStatus: task.status,
      taskPhase: task.phase ?? null,
    });
    return null;
  }
  return { task };
}

export function registerServerEventHandlers(bus: EventBus, manager: AgentManager): void {
  const configured = manager.getReviewStore();
  if (!configured) {
    console.warn('[ServerEventHandler] no ReviewStore configured; server review mode disabled');
    return;
  }
  const reviewStore = configured;
  const transport = () => manager.getReviewTransport();

  // Release an agent at a max_rounds pause and clear its TaskState reference —
  // ONLY when actually unbound. A stale reference on this still-active status
  // would let the released agent's later failures sweep the paused task to
  // failed via failTasksForAgent; a failed release keeps the reference so the
  // fault stays attributable (mirrors the GitHub cap paths).
  async function releaseAndClearAtCap(
    task: TaskState,
    agentId: string,
    field: 'agentId' | 'qaAgentId',
    opts: { allowAwaitingHuman?: boolean } = {},
  ): Promise<void> {
    const released = await manager.releaseAgentForTask(agentId, task.id, 'idle', opts)
      .catch(() => false);
    if (!released) {
      const state = await manager.getAgentState(agentId);
      if (state && state.taskId === task.id) {
        await emitIntervention(bus, task, {
          phase: 'server-max-rounds-release-failed',
          agentId,
          field,
        });
        return;
      }
    }
    await manager.updateTask(task.id, { [field]: undefined })
      .catch(err => console.error(`[ServerHandler] max_rounds clear ${field}(${task.id}) failed:`, err));
  }

  // Persist a verdict/response save; on failure re-arm the consumed signal so
  // the agent's re-emit retries the whole read→store path (the exchange file is
  // only deleted AFTER a successful store, so the retry re-reads it).
  async function putVerdictRound(
    task: TaskState,
    agentId: string,
    kind: 'code-reviewed' | 'code-fixed' | 'spec-reviewed' | 'spec-fixed',
    data: ReviewRound,
  ): Promise<boolean> {
    try {
      await reviewStore.putRound(task.id, data.phase, data);
      return true;
    } catch (err) {
      await emitIntervention(bus, task, {
        phase: `server-${data.phase}-verdict-store-failed`,
        round: data.round,
        error: err instanceof Error ? err.message : String(err),
      });
      await manager.setupPhaseSignal(task.id, agentId, kind, { skipSnapshot: true });
      return false;
    }
  }

  // Missing-config guard exits: the re-arm's resolveAgent IS the getAgentConfig
  // that just failed, so arming misses until the config is restored — hold the
  // agent so the stall is explicit (operator restores config, then cancels to retry).
  async function rearmOrHold(task: TaskState, agentId: string, kind: PhaseSignalKind): Promise<void> {
    const armed = await manager.setupPhaseSignal(task.id, agentId, kind, { skipSnapshot: true });
    if (!armed) await manager.holdAgentForUnarmedSignal(task.id, agentId, kind);
  }

  // Shared by code-done (first review) and code-fixed (recheck): read the dev
  // diff, persist the round, size/batch, dispatch QA.
  async function prepareAndDispatchCodeReview(
    task: TaskState,
    opts: { recheck: boolean; priorFindingsJson?: string; priorResponseJson?: string },
  ): Promise<void> {
    const dev = manager.getAgentConfig(task.agentId);
    if (!dev) {
      await emitIntervention(bus, task, { phase: 'server-code-review-no-dev-agent' });
      if (task.agentId) {
        const kind = task.status === 'fixing' ? 'code-fixed' : 'code-done';
        await rearmOrHold(task, task.agentId, kind);
      }
      return;
    }
    const cap = manager.getConfig().review.rounds + (task.maxRoundsContinues ?? 0);
    const nextRound = task.reviewRound + 1;
    if (nextRound > cap) {
      const capResult = await manager.transitionTaskStatus(task.id, 'max_rounds', { fromStatus: ['in_progress', 'fixing'] });
      if (!capResult) return;
      const paused = capResult.task;
      // QA was unbound when the fix dispatched but its TaskState reference
      // lingers — clear it so a released agent's later failures can't sweep
      // this paused gate to failed.
      if (paused.qaAgentId) await releaseAndClearAtCap(paused, paused.qaAgentId, 'qaAgentId');
      await bus.emit({
        id: '',
        type: 'review.max_rounds',
        timestamp: new Date().toISOString(),
        projectId: paused.projectId,
        agentId: paused.agentId,
        taskId: paused.id,
        data: { round: nextRound, cap },
      });
      return;
    }

    await manager.refreshWorktreeCacheFor(task.agentId);
    // Anchor BEFORE diff: a commit landing between the two reads then shows up
    // in the diff but not the anchor → publish refuses (fail-closed). The
    // reverse order would let an unreviewed commit publish under a matching
    // anchor.
    let content;
    let reviewHeadAnchorSha: string;
    try {
      reviewHeadAnchorSha = await transport().readHeadSha(dev);
      content = await transport().readContent(task, dev, 'code');
    } catch (err) {
      await emitIntervention(bus, task, {
        phase: 'server-code-content-read-failed',
        error: err instanceof Error ? err.message : String(err),
      });
      // First review entry consumed code-done; rechecks enter from code-fixed
      // (status 'fixing'). Re-arm whichever signal was consumed so the dev can
      // re-emit after the worktree/read issue is fixed.
      const kind = task.status === 'fixing' ? 'code-fixed' : 'code-done';
      await manager.setupPhaseSignal(task.id, task.agentId, kind, { skipSnapshot: true });
      return;
    }

    const round: ReviewRound = {
      round: nextRound,
      phase: 'code',
      content: content.content,
      ...(content.diffstat ? { diffstat: content.diffstat } : {}),
      ...(content.baseSha ? { baseSha: content.baseSha } : {}),
      startedAt: new Date().toISOString(),
    };

    // The entry signal is already consumed — a persistence failure must re-arm
    // it like content-read failures do, or the dev's re-emit has no consumer.
    const putEntryRound = async (data: ReviewRound): Promise<boolean> => {
      try {
        await reviewStore.putRound(task.id, 'code', data);
        return true;
      } catch (err) {
        await emitIntervention(bus, task, {
          phase: 'server-code-round-store-failed',
          error: err instanceof Error ? err.message : String(err),
        });
        const kind = task.status === 'fixing' ? 'code-fixed' : 'code-done';
        await manager.setupPhaseSignal(task.id, task.agentId, kind, { skipSnapshot: true });
        return false;
      }
    };

    const lines = countLines(content.content);
    if (lines > DIFF_LARGE_THRESHOLD) {
      const batches = buildBatches(splitDiffByFile(content.content), DIFF_LARGE_THRESHOLD);
      if (batches.length > 1) {
        round.batchFindings = [];
        if (!(await putEntryRound(round))) return;
        await dispatchBatch(task.id, batches, 0, content.diffstat, { ...opts, reviewHeadAnchorSha });
        return;
      }
    }

    if (!(await putEntryRound(round))) return;
    const sized = truncateUtf8(content.content, PROMPT_CONTENT_BYTE_BUDGET);
    await manager.dispatchServerReviewToQa(task.id, {
      phase: 'code',
      recheck: opts.recheck,
      content: sized.text,
      reviewHeadAnchorSha,
      ...(content.diffstat ? { diffstat: content.diffstat } : {}),
      ...(sized.truncated ? { contentTruncated: true } : {}),
      ...(opts.priorFindingsJson ? { priorFindingsJson: opts.priorFindingsJson } : {}),
      ...(opts.priorResponseJson ? { priorResponseJson: opts.priorResponseJson } : {}),
    });
  }

  async function dispatchBatch(
    taskId: string,
    batches: DiffFile[][],
    index: number,
    diffstat: string | undefined,
    opts: { recheck: boolean; priorFindingsJson?: string; priorResponseJson?: string; reviewHeadAnchorSha?: string },
  ): Promise<void> {
    const text = batches[index].map(f => f.text).join('\n');
    const sized = truncateUtf8(text, PROMPT_CONTENT_BYTE_BUDGET);
    await manager.dispatchServerReviewToQa(taskId, {
      phase: 'code',
      recheck: opts.recheck,
      continuation: index > 0,
      content: sized.text,
      ...(diffstat ? { diffstat } : {}),
      ...(sized.truncated ? { contentTruncated: true } : {}),
      batch: { index, total: batches.length },
      // Only the round-opening slice pins the anchor; continuations are the same round.
      ...(index === 0 && opts.reviewHeadAnchorSha ? { reviewHeadAnchorSha: opts.reviewHeadAnchorSha } : {}),
      ...(opts.priorFindingsJson ? { priorFindingsJson: opts.priorFindingsJson } : {}),
      ...(opts.priorResponseJson ? { priorResponseJson: opts.priorResponseJson } : {}),
    });
  }

  // Re-slice the stored round content for batch continuation after restart or
  // between batches — batches are deterministic for a given content + threshold.
  function rebuildBatches(roundData: ReviewRound): DiffFile[][] {
    return buildBatches(splitDiffByFile(roundData.content), DIFF_LARGE_THRESHOLD);
  }

  bus.on('server.code.ready', async (event) => {
    const gated = await gate(bus, manager, event, { status: 'in_progress', phase: 'code', requireServerMode: true });
    if (!gated) return;
    await prepareAndDispatchCodeReview(gated.task, { recheck: false });
  });

  bus.on('server.code.review.submitted', async (event) => {
    const gated = await gate(bus, manager, event, { status: 'review', phase: 'code', requireServerMode: true });
    if (!gated) return;
    const { task } = gated;
    const qa = manager.getAgentConfig(task.qaAgentId ?? '');
    if (!qa) {
      await emitIntervention(bus, task, { phase: 'server-code-review-no-qa-agent' });
      if (task.qaAgentId) {
        await rearmOrHold(task, task.qaAgentId, 'code-reviewed');
      }
      return;
    }
    const round = Math.max(task.reviewRound, 1);
    const roundData = await reviewStore.getRound(task.id, 'code', round);
    if (!roundData) {
      await emitIntervention(bus, task, { phase: 'server-code-review-round-missing', round });
      await manager.setupPhaseSignal(task.id, qa.id, 'code-reviewed', { skipSnapshot: true });
      return;
    }

    await manager.refreshWorktreeCacheFor(qa.id);
    let findings: ReviewFindings | null;
    try {
      findings = await transport().readFindings(task, qa);
    } catch (err) {
      const reason = err instanceof ReviewExchangeError ? err.reason : 'unknown';
      await emitIntervention(bus, task, {
        phase: 'server-code-findings-invalid',
        reason,
        error: err instanceof Error ? err.message : String(err),
      });
      // The one-shot watcher consumed the signal; re-arm with the SAME token so
      // QA can fix the file and re-emit instead of stranding the review.
      await manager.setupPhaseSignal(task.id, qa.id, 'code-reviewed', { skipSnapshot: true });
      return;
    }

    // findings === null with data already stored = crash-replay after the file
    // was deleted but before the flow advanced; fall through with the STORED
    // data so the continuation resumes instead of stranding the task.
    let current = roundData;
    if (findings === null) {
      const alreadyStored = task.batchTotal !== undefined
        ? (roundData.batchFindings?.length ?? 0) > (task.batchIndex ?? 0)
        : roundData.findings !== undefined;
      if (!alreadyStored) {
        await emitIntervention(bus, task, { phase: 'server-code-findings-missing', round });
        await manager.setupPhaseSignal(task.id, qa.id, 'code-reviewed', { skipSnapshot: true });
        return;
      }
    } else if (findings.round !== round) {
      // Stale exchange file from an old round (delete failed / agent reuse) —
      // never route an old verdict as the current round's.
      await emitIntervention(bus, task, {
        phase: 'server-code-findings-round-mismatch',
        round,
        payloadRound: findings.round,
      });
      await transport().deleteFindings(qa);
      await manager.setupPhaseSignal(task.id, qa.id, 'code-reviewed', { skipSnapshot: true });
      return;
    } else if (task.batchTotal !== undefined && task.batchIndex !== undefined) {
      const batchFindings = [...(roundData.batchFindings ?? [])];
      batchFindings[task.batchIndex] = findings;
      current = { ...roundData, batchFindings };
      if (!(await putVerdictRound(task, qa.id, 'code-reviewed', current))) return;
      await transport().deleteFindings(qa);
    } else {
      current = { ...roundData, findings, completedAt: new Date().toISOString() };
      if (!(await putVerdictRound(task, qa.id, 'code-reviewed', current))) return;
      await transport().deleteFindings(qa);
    }

    // Recheck rounds are every round after the first; survives crash-replay
    // (the prior hardcoded recheck:false lost this on batch continuation).
    const isRecheck = round > 1;

    if (task.batchTotal !== undefined && task.batchIndex !== undefined) {
      const nextIndex = task.batchIndex + 1;
      if (nextIndex < task.batchTotal) {
        // Recheck continuation batches still need the prior round's findings and
        // response — without them QA can't verify closure for this slice's files.
        const prev = isRecheck ? await reviewStore.getRound(task.id, 'code', round - 1) : null;
        await dispatchBatch(task.id, rebuildBatches(current), nextIndex, current.diffstat, {
          recheck: isRecheck,
          ...(prev?.findings ? { priorFindingsJson: JSON.stringify(prev.findings) } : {}),
          ...(prev?.response ? { priorResponseJson: JSON.stringify(prev.response) } : {}),
        });
        return;
      }
      const aggregated = current.findings
        ?? aggregateBatchFindings((current.batchFindings ?? []).filter(Boolean), round);
      if (!current.findings) {
        const stored = await putVerdictRound(task, qa.id, 'code-reviewed', {
          ...current,
          findings: aggregated,
          completedAt: new Date().toISOString(),
        });
        if (!stored) return;
      }
      await manager.updateTask(task.id, { batchIndex: undefined, batchTotal: undefined });
      await routeCodeVerdict({ ...task, batchIndex: undefined, batchTotal: undefined }, aggregated);
      return;
    }

    await routeCodeVerdict(task, current.findings!);
  });

  async function routeCodeVerdict(task: TaskState, findings: ReviewFindings): Promise<void> {
    if (findings.verdict === 'approve') {
      // Snapshot afterDone the moment the verdict routes it — confirm must not
      // read live config a hot-reload may have flipped mid-gate. On crash-replay
      // the EXISTING snapshot wins (resolveAfterDone) so the verdict-time
      // decision stays stable across restarts.
      const afterDone = manager.resolveAfterDone(task);
      if (task.afterDone === undefined) {
        await manager.updateTask(task.id, { afterDone });
      }
      if (afterDone === null) {
        const ready = await manager.transitionTaskStatus(task.id, 'ready', { fromStatus: ['review'] });
        if (!ready) await emitIntervention(bus, task, { phase: 'server-code-ready-transition-failed' });
        return;
      }
      const approved = await manager.transitionTaskStatus(task.id, 'approved', { fromStatus: ['review'] });
      if (!approved) {
        await emitIntervention(bus, task, { phase: 'server-code-approved-transition-failed' });
        return;
      }
      await manager.dispatchServerAfterDone(task.id, afterDone);
      return;
    }
    // Cap check at VERDICT time, like the GitHub handler: dispatching a fix in
    // the final round would let dev change code that QA never rechecks before
    // max_rounds complete can merge it.
    const cap = manager.getConfig().review.rounds + (task.maxRoundsContinues ?? 0);
    if (task.reviewRound >= cap) {
      const capResult = await manager.transitionTaskStatus(task.id, 'max_rounds', { fromStatus: ['review'] });
      if (!capResult) return;
      const paused = capResult.task;
      // QA is bound at verdict time and the verdict arriving IS its turn
      // completing, so a Held QA must still be releasable; dev stays reserved
      // for Continue/Complete.
      if (paused.qaAgentId) {
        await releaseAndClearAtCap(paused, paused.qaAgentId, 'qaAgentId', { allowAwaitingHuman: true });
      }
      await bus.emit({
        id: '',
        type: 'review.max_rounds',
        timestamp: new Date().toISOString(),
        projectId: paused.projectId,
        agentId: paused.agentId,
        taskId: paused.id,
        data: { round: paused.reviewRound, cap },
      });
      return;
    }
    await manager.dispatchServerFixToDev(task.id, JSON.stringify(findings));
  }

  bus.on('server.code.fix.submitted', async (event) => {
    const gated = await gate(bus, manager, event, { status: 'fixing', phase: 'code', requireServerMode: true });
    if (!gated) return;
    const { task } = gated;
    const dev = manager.getAgentConfig(task.agentId);
    if (!dev) {
      await emitIntervention(bus, task, { phase: 'server-code-fix-no-dev-agent' });
      if (task.agentId) {
        await rearmOrHold(task, task.agentId, 'code-fixed');
      }
      return;
    }
    const round = Math.max(task.reviewRound, 1);
    const roundData = await reviewStore.getRound(task.id, 'code', round);
    if (!roundData?.findings) {
      await emitIntervention(bus, task, { phase: 'server-code-fix-findings-missing', round });
      await manager.setupPhaseSignal(task.id, task.agentId, 'code-fixed', { skipSnapshot: true });
      return;
    }

    await manager.refreshWorktreeCacheFor(task.agentId);
    let response;
    try {
      response = await transport().readResponse(task, dev);
    } catch (err) {
      await emitIntervention(bus, task, {
        phase: 'server-code-response-invalid',
        error: err instanceof Error ? err.message : String(err),
      });
      await manager.setupPhaseSignal(task.id, dev.id, 'code-fixed', { skipSnapshot: true });
      return;
    }
    if (response === null) {
      if (roundData.response === undefined) {
        await emitIntervention(bus, task, { phase: 'server-code-response-missing', round });
        await manager.setupPhaseSignal(task.id, dev.id, 'code-fixed', { skipSnapshot: true });
        return;
      }
      // Crash-replay after delete: response is stored — resume the recheck dispatch.
      await prepareAndDispatchCodeReview(task, {
        recheck: true,
        priorFindingsJson: JSON.stringify(roundData.findings),
        priorResponseJson: JSON.stringify(roundData.response),
      });
      return;
    }
    if (response.round !== round) {
      await emitIntervention(bus, task, {
        phase: 'server-code-response-round-mismatch',
        round,
        payloadRound: response.round,
      });
      await transport().deleteResponse(dev);
      await manager.setupPhaseSignal(task.id, dev.id, 'code-fixed', { skipSnapshot: true });
      return;
    }

    // Fail-closed coverage: every finding id must have exactly one response item,
    // and no response may reference an id QA never raised (hallucinated f99).
    const gaps = coverageGaps(roundData.findings, new Set(response.responses.map(r => r.findingId)));
    if (gaps.missing.length > 0 || gaps.unknown.length > 0) {
      await emitIntervention(bus, task, {
        phase: 'server-code-response-coverage-gap',
        round,
        missingFindingIds: gaps.missing,
        unknownFindingIds: gaps.unknown,
      });
      await manager.setupPhaseSignal(task.id, dev.id, 'code-fixed', { skipSnapshot: true });
      return;
    }

    if (!(await putVerdictRound(task, dev.id, 'code-fixed', { ...roundData, response }))) return;
    await transport().deleteResponse(dev);

    await prepareAndDispatchCodeReview(task, {
      recheck: true,
      priorFindingsJson: JSON.stringify(roundData.findings),
      priorResponseJson: JSON.stringify(response),
    });
  });

  bus.on('server.code.published', async (event) => {
    const gated = await gate(bus, manager, event, { status: 'approved', phase: 'code', requireServerMode: true });
    if (!gated) return;
    const { task } = gated;
    const prNumber = typeof event.data?.prNumber === 'number' ? event.data.prNumber : undefined;
    if (prNumber === undefined && manager.resolveAfterDone(task) === 'pr' && task.prNumber === undefined) {
      // afterDone:'pr' without a PR number would sail through confirm as plain
      // 'done', leaving the created PR unmerged. Make dev re-emit with the number.
      await emitIntervention(bus, task, { phase: 'server-code-published-missing-pr-number' });
      await manager.setupPhaseSignal(task.id, task.agentId, 'code-ready', { skipSnapshot: true });
      return;
    }
    if (prNumber !== undefined) {
      // Same trust model as pane pr-created: never act on an agent-reported PR
      // number without confirming its head branch is OURS (typo/hallucination
      // would point Confirm/Cancel at someone else's PR).
      const verified = await manager.verifyPaneSignalPrNumber(task.id, prNumber);
      if (!verified) {
        await emitIntervention(bus, task, {
          phase: 'server-code-published-pr-number-unverified',
          prNumber,
        });
        await manager.setupPhaseSignal(task.id, task.agentId, 'code-ready', { skipSnapshot: true });
        return;
      }
      await manager.updateTask(task.id, { prNumber });
    }
    // Reviewed-head capture for BOTH pr and branch publishes — the confirm-time
    // merge guard depends on it, so a capture failure must NOT reach ready
    // (fail-open would re-enable blind merges of post-gate pushes).
    const dev = manager.getAgentConfig(task.agentId);
    if (!dev) {
      await emitIntervention(bus, task, { phase: 'server-code-published-no-dev-agent' });
      return;
    }
    await manager.refreshWorktreeCacheFor(task.agentId);
    let publishedHead: string;
    try {
      publishedHead = await transport().readHeadSha(dev);
    } catch (err) {
      await emitIntervention(bus, task, {
        phase: 'server-code-published-head-capture-failed',
        error: err instanceof Error ? err.message : String(err),
      });
      await manager.setupPhaseSignal(task.id, task.agentId, 'code-ready', { skipSnapshot: true });
      return;
    }
    // QA reviewed the diff pinned at dispatch (reviewHeadAnchorSha); a publish
    // from any other head carries commits no server review ever saw. No re-arm:
    // the publish already happened — the exits are Cancel (retract the
    // PR/branch) then Retry for a fresh review.
    if (publishedHead !== task.reviewHeadAnchorSha) {
      await emitIntervention(bus, task, {
        phase: 'server-code-published-head-mismatch',
        publishedHead,
        reviewedHead: task.reviewHeadAnchorSha ?? null,
      });
      return;
    }
    try {
      await manager.updateTask(task.id, { latestHeadSha: publishedHead });
    } catch (err) {
      await emitIntervention(bus, task, {
        phase: 'server-code-published-head-capture-failed',
        error: err instanceof Error ? err.message : String(err),
      });
      await manager.setupPhaseSignal(task.id, task.agentId, 'code-ready', { skipSnapshot: true });
      return;
    }
    const ready = await manager.transitionTaskStatus(task.id, 'ready', { fromStatus: ['approved'] });
    if (!ready) await emitIntervention(bus, task, { phase: 'server-code-published-transition-failed' });
  });

  bus.on('server.spec.ready', async (event) => {
    const gated = await gate(bus, manager, event, { status: 'in_progress', phase: 'any', requireServerMode: false });
    if (!gated) return;
    await dispatchSpecReview(gated.task);
  });

  async function dispatchSpecReview(task: TaskState, prior?: { findingsJson: string; responseJson: string }): Promise<void> {
    const dev = manager.getAgentConfig(task.agentId);
    if (!dev) {
      await emitIntervention(bus, task, { phase: 'server-spec-review-no-dev-agent' });
      if (task.agentId) {
        const kind = task.status === 'fixing' ? 'spec-fixed' : 'spec-done';
        await rearmOrHold(task, task.agentId, kind);
      }
      return;
    }
    const cap = manager.getConfig().review.rounds + (task.maxRoundsContinues ?? 0);
    const nextRound = (task.specReviewRound ?? 0) + 1;
    if (nextRound > cap) {
      const capResult = await manager.transitionTaskStatus(task.id, 'max_rounds', { fromStatus: ['in_progress', 'fixing'] });
      if (!capResult) return;
      const paused = capResult.task;
      // Spec-phase max_rounds has no Continue/Complete — Retry/Cancel only.
      // Release BOTH agents and clear their references (GitHub spec-cap parity).
      if (paused.qaAgentId) await releaseAndClearAtCap(paused, paused.qaAgentId, 'qaAgentId');
      if (paused.agentId) await releaseAndClearAtCap(paused, paused.agentId, 'agentId');
      return;
    }
    await manager.refreshWorktreeCacheFor(task.agentId);
    let content;
    try {
      content = await transport().readContent(task, dev, 'spec');
    } catch (err) {
      await emitIntervention(bus, task, {
        phase: 'server-spec-content-read-failed',
        error: err instanceof Error ? err.message : String(err),
      });
      const kind = task.status === 'fixing' ? 'spec-fixed' : 'spec-done';
      await manager.setupPhaseSignal(task.id, task.agentId, kind, { skipSnapshot: true });
      return;
    }
    try {
      await reviewStore.putRound(task.id, 'spec', {
        round: nextRound,
        phase: 'spec',
        content: content.content,
        startedAt: new Date().toISOString(),
      });
    } catch (err) {
      await emitIntervention(bus, task, {
        phase: 'server-spec-round-store-failed',
        error: err instanceof Error ? err.message : String(err),
      });
      const kind = task.status === 'fixing' ? 'spec-fixed' : 'spec-done';
      await manager.setupPhaseSignal(task.id, task.agentId, kind, { skipSnapshot: true });
      return;
    }
    const sized = truncateUtf8(content.content, MAX_INLINE_CONTENT_BYTES);
    await manager.dispatchServerReviewToQa(task.id, {
      phase: 'spec',
      content: sized.text,
      ...(sized.truncated ? { contentTruncated: true } : {}),
      ...(prior ? { priorFindingsJson: prior.findingsJson, priorResponseJson: prior.responseJson } : {}),
    });
  }

  bus.on('server.spec.review.submitted', async (event) => {
    const gated = await gate(bus, manager, event, { status: 'review', phase: 'spec', requireServerMode: false });
    if (!gated) return;
    const { task } = gated;
    const qa = manager.getAgentConfig(task.qaAgentId ?? '');
    if (!qa) {
      await emitIntervention(bus, task, { phase: 'server-spec-review-no-qa-agent' });
      if (task.qaAgentId) {
        await rearmOrHold(task, task.qaAgentId, 'spec-reviewed');
      }
      return;
    }
    const round = task.specReviewRound ?? 1;
    const roundData = await reviewStore.getRound(task.id, 'spec', round);
    if (!roundData) {
      await emitIntervention(bus, task, { phase: 'server-spec-review-round-missing', round });
      await manager.setupPhaseSignal(task.id, qa.id, 'spec-reviewed', { skipSnapshot: true });
      return;
    }
    await manager.refreshWorktreeCacheFor(qa.id);
    let findings: ReviewFindings | null;
    try {
      findings = await transport().readFindings(task, qa);
    } catch (err) {
      await emitIntervention(bus, task, {
        phase: 'server-spec-findings-invalid',
        error: err instanceof Error ? err.message : String(err),
      });
      await manager.setupPhaseSignal(task.id, qa.id, 'spec-reviewed', { skipSnapshot: true });
      return;
    }
    // Crash-replay after delete: route on the STORED findings.
    let effective = findings;
    if (effective === null) {
      if (roundData.findings === undefined) {
        await emitIntervention(bus, task, { phase: 'server-spec-findings-missing', round });
        await manager.setupPhaseSignal(task.id, qa.id, 'spec-reviewed', { skipSnapshot: true });
        return;
      }
      effective = roundData.findings;
    } else if (effective.round !== round) {
      await emitIntervention(bus, task, {
        phase: 'server-spec-findings-round-mismatch',
        round,
        payloadRound: effective.round,
      });
      await transport().deleteFindings(qa);
      await manager.setupPhaseSignal(task.id, qa.id, 'spec-reviewed', { skipSnapshot: true });
      return;
    } else {
      const stored = await putVerdictRound(task, qa.id, 'spec-reviewed', {
        ...roundData,
        findings: effective,
        completedAt: new Date().toISOString(),
      });
      if (!stored) return;
      await transport().deleteFindings(qa);
    }

    if (effective.verdict === 'approve') {
      try {
        await manager.transitionToCodePhase(task.id);
      } catch (err) {
        await emitIntervention(bus, task, {
          phase: 'server-spec-approve-transition-failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
    // Cap at verdict time (mirrors the code path): a final-round fix would
    // never be rechecked before the spec cap pauses the task.
    const cap = manager.getConfig().review.rounds + (task.maxRoundsContinues ?? 0);
    if ((task.specReviewRound ?? 0) >= cap) {
      const capResult = await manager.transitionTaskStatus(task.id, 'max_rounds', { fromStatus: ['review'] });
      if (!capResult) return;
      const paused = capResult.task;
      if (paused.qaAgentId) await releaseAndClearAtCap(paused, paused.qaAgentId, 'qaAgentId');
      if (paused.agentId) await releaseAndClearAtCap(paused, paused.agentId, 'agentId');
      return;
    }
    await manager.dispatchServerFixToDev(task.id, JSON.stringify(effective));
  });

  bus.on('server.spec.fix.submitted', async (event) => {
    const gated = await gate(bus, manager, event, { status: 'fixing', phase: 'spec', requireServerMode: false });
    if (!gated) return;
    const { task } = gated;
    const dev = manager.getAgentConfig(task.agentId);
    if (!dev) {
      await emitIntervention(bus, task, { phase: 'server-spec-fix-no-dev-agent' });
      if (task.agentId) {
        await rearmOrHold(task, task.agentId, 'spec-fixed');
      }
      return;
    }
    const round = task.specReviewRound ?? 1;
    const roundData = await reviewStore.getRound(task.id, 'spec', round);
    if (!roundData?.findings) {
      await emitIntervention(bus, task, { phase: 'server-spec-fix-findings-missing', round });
      await manager.setupPhaseSignal(task.id, task.agentId, 'spec-fixed', { skipSnapshot: true });
      return;
    }
    await manager.refreshWorktreeCacheFor(task.agentId);
    let response;
    try {
      response = await transport().readResponse(task, dev);
    } catch (err) {
      await emitIntervention(bus, task, {
        phase: 'server-spec-response-invalid',
        error: err instanceof Error ? err.message : String(err),
      });
      await manager.setupPhaseSignal(task.id, dev.id, 'spec-fixed', { skipSnapshot: true });
      return;
    }
    if (response === null) {
      if (roundData.response === undefined) {
        await emitIntervention(bus, task, { phase: 'server-spec-response-missing', round });
        await manager.setupPhaseSignal(task.id, dev.id, 'spec-fixed', { skipSnapshot: true });
        return;
      }
      // Crash-replay after delete: response is stored — resume the recheck dispatch.
      await dispatchSpecReview(task, {
        findingsJson: JSON.stringify(roundData.findings),
        responseJson: JSON.stringify(roundData.response),
      });
      return;
    }
    if (response.round !== round) {
      await emitIntervention(bus, task, {
        phase: 'server-spec-response-round-mismatch',
        round,
        payloadRound: response.round,
      });
      await transport().deleteResponse(dev);
      await manager.setupPhaseSignal(task.id, dev.id, 'spec-fixed', { skipSnapshot: true });
      return;
    }
    const gaps = coverageGaps(roundData.findings, new Set(response.responses.map(r => r.findingId)));
    if (gaps.missing.length > 0 || gaps.unknown.length > 0) {
      await emitIntervention(bus, task, {
        phase: 'server-spec-response-coverage-gap',
        round,
        missingFindingIds: gaps.missing,
        unknownFindingIds: gaps.unknown,
      });
      await manager.setupPhaseSignal(task.id, dev.id, 'spec-fixed', { skipSnapshot: true });
      return;
    }
    if (!(await putVerdictRound(task, dev.id, 'spec-fixed', { ...roundData, response }))) return;
    await transport().deleteResponse(dev);
    await dispatchSpecReview(task, {
      findingsJson: JSON.stringify(roundData.findings),
      responseJson: JSON.stringify(response),
    });
  });
}
