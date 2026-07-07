import {
  DIFF_LARGE_THRESHOLD,
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

function aggregateBatchFindings(batches: ReviewFindings[], round: number): ReviewFindings {
  const findings: Finding[] = [];
  const used = new Set<string>();
  for (const [i, batch] of batches.entries()) {
    for (const f of batch.findings) {
      let id = /^b\d+-/.test(f.id) ? f.id : `b${i}-${f.id}`;
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

  async function rearmOrHold(task: TaskState, agentId: string, kind: PhaseSignalKind): Promise<void> {
    const armed = await manager.setupPhaseSignal(task.id, agentId, kind, { skipSnapshot: true });
    if (!armed) await manager.holdAgentForUnarmedSignal(task.id, agentId, kind);
  }

  async function autoApproveCode(task: TaskState): Promise<void> {
    const afterDone = manager.resolveAfterDone(task);
    if (task.afterDone === undefined) {
      await manager.updateTask(task.id, { afterDone });
    }
    if (afterDone === null) {
      const ready = await manager.transitionTaskStatus(task.id, 'ready', { fromStatus: ['in_progress'] });
      if (!ready) await emitIntervention(bus, task, { phase: 'server-code-auto-approve-transition-failed' });
      return;
    }
    const dev = manager.getAgentConfig(task.agentId);
    if (!dev) {
      await emitIntervention(bus, task, { phase: 'server-code-auto-approve-no-dev-agent' });
      return;
    }
    await manager.refreshWorktreeCacheFor(task.agentId);
    let reviewHeadAnchorSha: string;
    try {
      reviewHeadAnchorSha = await transport().readHeadSha(dev);
    } catch (err) {
      await emitIntervention(bus, task, {
        phase: 'server-code-auto-approve-head-capture-failed',
        error: err instanceof Error ? err.message : String(err),
      });
      await manager.setupPhaseSignal(task.id, task.agentId, 'code-done', { skipSnapshot: true });
      return;
    }
    const approved = await manager.transitionTaskStatus(
      task.id, 'approved', { fromStatus: ['in_progress'] },
      { reviewHeadAnchorSha },
    );
    if (!approved) {
      await emitIntervention(bus, task, { phase: 'server-code-auto-approve-transition-failed' });
      return;
    }
    await manager.dispatchServerAfterDone(task.id, afterDone);
  }

  function specApprovalIsHuman(task: TaskState): boolean {
    return manager.getProjectConfig(task.projectId)?.specApproval === 'human';
  }

  async function advanceApprovedSpec(task: TaskState, failurePhase: string): Promise<void> {
    try {
      const result = specApprovalIsHuman(task)
        ? await manager.parkTaskAtSpecReady(task.id)
        : await manager.transitionToCodePhase(task.id);
      if (!result) {
        await emitIntervention(bus, task, { phase: failurePhase });
      }
    } catch (err) {
      await emitIntervention(bus, task, {
        phase: failurePhase,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function autoApproveSpec(task: TaskState): Promise<boolean> {
    try {
      const result = await manager.transitionToCodePhase(task.id);
      if (!result) {
        await emitIntervention(bus, task, { phase: 'server-spec-auto-approve-transition-failed' });
        return false;
      }
      return true;
    } catch (err) {
      await emitIntervention(bus, task, {
        phase: 'server-spec-auto-approve-transition-failed',
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  async function prepareAndDispatchCodeReview(
    task: TaskState,
    opts: { recheck: boolean; priorFindingsJson?: string; priorResponseJson?: string },
  ): Promise<boolean> {
    const dev = manager.getAgentConfig(task.agentId);
    if (!dev) {
      await emitIntervention(bus, task, { phase: 'server-code-review-no-dev-agent' });
      if (task.agentId) {
        const kind = task.status === 'fixing' ? 'code-fixed' : 'code-done';
        await rearmOrHold(task, task.agentId, kind);
      }
      return false;
    }
    const cap = manager.getConfig().review.rounds + (task.maxRoundsContinues ?? 0);
    const nextRound = task.reviewRound + 1;
    if (nextRound > cap) {
      const capResult = await manager.transitionTaskStatus(task.id, 'max_rounds', { fromStatus: ['in_progress', 'fixing'] });
      if (!capResult) return false;
      const paused = capResult.task;
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
      return false;
    }

    await manager.refreshWorktreeCacheFor(task.agentId);
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
      const kind = task.status === 'fixing' ? 'code-fixed' : 'code-done';
      await manager.setupPhaseSignal(task.id, task.agentId, kind, { skipSnapshot: true });
      return false;
    }

    const rearmEntry = async (): Promise<void> => {
      const kind = task.status === 'fixing' ? 'code-fixed' : 'code-done';
      await manager.setupPhaseSignal(task.id, task.agentId, kind, { skipSnapshot: true });
    };
    try {
      const violation = await manager.findLineageViolation(task.id, content.baseSha);
      if (violation) {
        await emitIntervention(bus, task, {
          phase: 'server-code-lineage-violation',
          offendingTaskId: violation.taskId,
          offendingBranch: violation.branch,
          offendingSha: violation.sha,
          note: 'The task branch embeds another active task\'s commits — reviewing it would leak foreign work into this task. Have the dev rebase onto origin/HEAD and re-emit the signal.',
        });
        await rearmEntry();
        return false;
      }
    } catch (err) {
      await emitIntervention(bus, task, {
        phase: 'server-code-lineage-check-failed',
        error: err instanceof Error ? err.message : String(err),
      });
      await rearmEntry();
      return false;
    }

    const round: ReviewRound = {
      round: nextRound,
      phase: 'code',
      content: content.content,
      ...(content.diffstat ? { diffstat: content.diffstat } : {}),
      ...(content.baseSha ? { baseSha: content.baseSha } : {}),
      startedAt: new Date().toISOString(),
    };

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
        if (!(await putEntryRound(round))) return false;
        return dispatchBatch(task.id, batches, 0, content.diffstat, { ...opts, reviewHeadAnchorSha });
      }
    }

    if (!(await putEntryRound(round))) return false;
    const dispatched = await manager.dispatchServerReviewToQa(task.id, {
      phase: 'code',
      recheck: opts.recheck,
      content: content.content,
      reviewHeadAnchorSha,
      ...(content.diffstat ? { diffstat: content.diffstat } : {}),
      ...(opts.priorFindingsJson ? { priorFindingsJson: opts.priorFindingsJson } : {}),
      ...(opts.priorResponseJson ? { priorResponseJson: opts.priorResponseJson } : {}),
    });
    return dispatched !== null;
  }

  async function dispatchBatch(
    taskId: string,
    batches: DiffFile[][],
    index: number,
    diffstat: string | undefined,
    opts: { recheck: boolean; priorFindingsJson?: string; priorResponseJson?: string; reviewHeadAnchorSha?: string },
  ): Promise<boolean> {
    const text = batches[index].map(f => f.text).join('\n');
    const dispatched = await manager.dispatchServerReviewToQa(taskId, {
      phase: 'code',
      recheck: opts.recheck,
      continuation: index > 0,
      content: text,
      ...(diffstat ? { diffstat } : {}),
      batch: { index, total: batches.length },
      ...(index === 0 && opts.reviewHeadAnchorSha ? { reviewHeadAnchorSha: opts.reviewHeadAnchorSha } : {}),
      ...(opts.priorFindingsJson ? { priorFindingsJson: opts.priorFindingsJson } : {}),
      ...(opts.priorResponseJson ? { priorResponseJson: opts.priorResponseJson } : {}),
    });
    return dispatched !== null;
  }

  function rebuildBatches(roundData: ReviewRound): DiffFile[][] {
    return buildBatches(splitDiffByFile(roundData.content), DIFF_LARGE_THRESHOLD);
  }

  bus.on('server.code.ready', async (event) => {
    const gated = await gate(bus, manager, event, { status: 'in_progress', phase: 'code', requireServerMode: true });
    if (!gated) return;
    const { task } = gated;
    const hasQa = !!(task.qaAgentId ?? manager.findQaPartner(task.agentId)?.id);
    if (!hasQa) {
      await autoApproveCode(task);
      return;
    }
    await prepareAndDispatchCodeReview(task, { recheck: false });
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
      await manager.setupPhaseSignal(task.id, qa.id, 'code-reviewed', { skipSnapshot: true });
      return;
    }

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

    const isRecheck = round > 1;

    if (task.batchTotal !== undefined && task.batchIndex !== undefined) {
      const nextIndex = task.batchIndex + 1;
      if (nextIndex < task.batchTotal) {
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
    const cap = manager.getConfig().review.rounds + (task.maxRoundsContinues ?? 0);
    if (task.reviewRound >= cap) {
      const capResult = await manager.transitionTaskStatus(task.id, 'max_rounds', { fromStatus: ['review'] });
      if (!capResult) return;
      const paused = capResult.task;
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

  async function runCodeFixSubmission(task: TaskState): Promise<boolean> {
    const dev = manager.getAgentConfig(task.agentId);
    if (!dev) {
      await emitIntervention(bus, task, { phase: 'server-code-fix-no-dev-agent' });
      if (task.agentId) {
        await rearmOrHold(task, task.agentId, 'code-fixed');
      }
      return false;
    }
    const round = Math.max(task.reviewRound, 1);
    const roundData = await reviewStore.getRound(task.id, 'code', round);
    if (!roundData?.findings) {
      await emitIntervention(bus, task, { phase: 'server-code-fix-findings-missing', round });
      await manager.setupPhaseSignal(task.id, task.agentId, 'code-fixed', { skipSnapshot: true });
      return false;
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
      return false;
    }
    if (response === null) {
      if (roundData.response === undefined) {
        await emitIntervention(bus, task, { phase: 'server-code-response-missing', round });
        await manager.setupPhaseSignal(task.id, dev.id, 'code-fixed', { skipSnapshot: true });
        return false;
      }
      return prepareAndDispatchCodeReview(task, {
        recheck: true,
        priorFindingsJson: JSON.stringify(roundData.findings),
        priorResponseJson: JSON.stringify(roundData.response),
      });
    }
    if (response.round !== round) {
      await emitIntervention(bus, task, {
        phase: 'server-code-response-round-mismatch',
        round,
        payloadRound: response.round,
      });
      await transport().deleteResponse(dev);
      await manager.setupPhaseSignal(task.id, dev.id, 'code-fixed', { skipSnapshot: true });
      return false;
    }

    const gaps = coverageGaps(roundData.findings, new Set(response.responses.map(r => r.findingId)));
    if (gaps.missing.length > 0 || gaps.unknown.length > 0) {
      await emitIntervention(bus, task, {
        phase: 'server-code-response-coverage-gap',
        round,
        missingFindingIds: gaps.missing,
        unknownFindingIds: gaps.unknown,
      });
      await manager.setupPhaseSignal(task.id, dev.id, 'code-fixed', { skipSnapshot: true });
      return false;
    }

    if (!(await putVerdictRound(task, dev.id, 'code-fixed', { ...roundData, response }))) return false;
    await transport().deleteResponse(dev);

    return prepareAndDispatchCodeReview(task, {
      recheck: true,
      priorFindingsJson: JSON.stringify(roundData.findings),
      priorResponseJson: JSON.stringify(response),
    });
  }

  bus.on('server.code.fix.submitted', async (event) => {
    const gated = await gate(bus, manager, event, { status: 'fixing', phase: 'code', requireServerMode: true });
    if (!gated) return;
    await runCodeFixSubmission(gated.task);
  });

  bus.on('server.code.published', async (event) => {
    const gated = await gate(bus, manager, event, { status: 'approved', phase: 'code', requireServerMode: true });
    if (!gated) return;
    const { task } = gated;
    const prNumber = typeof event.data?.prNumber === 'number' ? event.data.prNumber : undefined;
    if (prNumber === undefined && manager.resolveAfterDone(task) === 'pr' && task.prNumber === undefined) {
      await emitIntervention(bus, task, { phase: 'server-code-published-missing-pr-number' });
      await manager.setupPhaseSignal(task.id, task.agentId, 'code-ready', { skipSnapshot: true });
      return;
    }
    if (prNumber !== undefined) {
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
    const { task } = gated;
    const hasQa = !!(task.qaAgentId ?? manager.findQaPartner(task.agentId)?.id);
    if (!hasQa && !specApprovalIsHuman(task)) {
      await autoApproveSpec(task);
      return;
    }
    // 无 QA 但需人类审核：仍走 dispatchSpecReview 存 spec 内容，再由其停驻
    await dispatchSpecReview(task);
  });

  async function dispatchSpecReview(task: TaskState, prior?: { findingsJson: string; responseJson?: string }): Promise<boolean> {
    const dev = manager.getAgentConfig(task.agentId);
    if (!dev) {
      await emitIntervention(bus, task, { phase: 'server-spec-review-no-dev-agent' });
      if (task.agentId) {
        const kind = task.status === 'fixing' ? 'spec-fixed' : 'spec-done';
        await rearmOrHold(task, task.agentId, kind);
      }
      return false;
    }
    const cap = manager.getConfig().review.rounds + (task.maxRoundsContinues ?? 0);
    const nextRound = (task.specReviewRound ?? 0) + 1;
    if (nextRound > cap) {
      const capResult = await manager.transitionTaskStatus(task.id, 'max_rounds', { fromStatus: ['in_progress', 'fixing'] });
      if (!capResult) return false;
      const paused = capResult.task;
      if (paused.qaAgentId) await releaseAndClearAtCap(paused, paused.qaAgentId, 'qaAgentId');
      if (paused.agentId) await releaseAndClearAtCap(paused, paused.agentId, 'agentId');
      return false;
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
      return false;
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
      return false;
    }
    const hasQa = !!(task.qaAgentId ?? manager.findQaPartner(task.agentId)?.id);
    if (!hasQa) {
      if (specApprovalIsHuman(task)) {
        const parked = await manager.parkTaskAtSpecReady(task.id, { specReviewRound: nextRound });
        if (!parked) await emitIntervention(bus, task, { phase: 'server-spec-park-transition-failed' });
        return !!parked;
      }
      // 循环中途配置被关闭：退回无 QA 的自动通过
      return autoApproveSpec(task);
    }
    const dispatched = await manager.dispatchServerReviewToQa(task.id, {
      phase: 'spec',
      content: content.content,
      ...(prior ? { priorFindingsJson: prior.findingsJson } : {}),
      ...(prior?.responseJson ? { priorResponseJson: prior.responseJson } : {}),
    });
    return dispatched !== null;
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
      await advanceApprovedSpec(task, 'server-spec-approve-transition-failed');
      return;
    }
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

  async function runSpecFixSubmission(task: TaskState): Promise<boolean> {
    const dev = manager.getAgentConfig(task.agentId);
    if (!dev) {
      await emitIntervention(bus, task, { phase: 'server-spec-fix-no-dev-agent' });
      if (task.agentId) {
        await rearmOrHold(task, task.agentId, 'spec-fixed');
      }
      return false;
    }
    const round = task.specReviewRound ?? 1;
    const roundData = await reviewStore.getRound(task.id, 'spec', round);
    if (!roundData?.findings) {
      await emitIntervention(bus, task, { phase: 'server-spec-fix-findings-missing', round });
      await manager.setupPhaseSignal(task.id, task.agentId, 'spec-fixed', { skipSnapshot: true });
      return false;
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
      return false;
    }
    if (response === null) {
      if (roundData.response === undefined) {
        await emitIntervention(bus, task, { phase: 'server-spec-response-missing', round });
        await manager.setupPhaseSignal(task.id, dev.id, 'spec-fixed', { skipSnapshot: true });
        return false;
      }
      return dispatchSpecReview(task, {
        findingsJson: JSON.stringify(roundData.findings),
        responseJson: JSON.stringify(roundData.response),
      });
    }
    if (response.round !== round) {
      await emitIntervention(bus, task, {
        phase: 'server-spec-response-round-mismatch',
        round,
        payloadRound: response.round,
      });
      await transport().deleteResponse(dev);
      await manager.setupPhaseSignal(task.id, dev.id, 'spec-fixed', { skipSnapshot: true });
      return false;
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
      return false;
    }
    if (!(await putVerdictRound(task, dev.id, 'spec-fixed', { ...roundData, response }))) return false;
    await transport().deleteResponse(dev);
    return dispatchSpecReview(task, {
      findingsJson: JSON.stringify(roundData.findings),
      responseJson: JSON.stringify(response),
    });
  }

  bus.on('server.spec.fix.submitted', async (event) => {
    const gated = await gate(bus, manager, event, { status: 'fixing', phase: 'spec', requireServerMode: false });
    if (!gated) return;
    await runSpecFixSubmission(gated.task);
  });

  async function latestVerdictRound(taskId: string, phase: 'code' | 'spec', fromRound: number): Promise<ReviewRound | null> {
    for (let r = fromRound; r >= 1; r--) {
      const data = await reviewStore.getRound(taskId, phase, r);
      if (data?.findings) return data;
    }
    return null;
  }

  // 手工发起复用自然入口的完整协议：fixing 走 fix-submission（读/校验 dev 的 response 后派 recheck，
  // 缺 response 拒绝）；其余状态按最近结论轮携带 prior 上下文，否则 QA 无从核对上一轮 findings
  manager.setServerReviewDriver({
    dispatchCodeReview: async (task) => {
      if (task.status === 'fixing') return runCodeFixSubmission(task);
      const prior = await latestVerdictRound(task.id, 'code', task.reviewRound);
      return prepareAndDispatchCodeReview(task, {
        recheck: prior !== null,
        ...(prior?.findings ? { priorFindingsJson: JSON.stringify(prior.findings) } : {}),
        ...(prior?.response ? { priorResponseJson: JSON.stringify(prior.response) } : {}),
      });
    },
    dispatchSpecReview: async (task) => {
      if (task.status === 'fixing') return runSpecFixSubmission(task);
      const prior = await latestVerdictRound(task.id, 'spec', task.specReviewRound ?? 0);
      return dispatchSpecReview(task, prior?.findings
        ? {
          findingsJson: JSON.stringify(prior.findings),
          ...(prior.response ? { responseJson: JSON.stringify(prior.response) } : {}),
        }
        : undefined);
    },
  });
}
