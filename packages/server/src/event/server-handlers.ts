import type {
  AgentConfig,
  BaxianEvent,
  Finding,
  ReviewFindings,
  ReviewRound,
  ServerResponseFailure,
  ServerSignalKind,
  ServerSignalRecoveryReason,
  TaskGenerationGuard,
  TaskState,
} from '../shared/index.js';
import { isSpecStagePhase, taskGenerationGuard } from '../shared/index.js';
import type { EventBus } from './bus.js';
import type { AgentManager } from '../agent/manager.js';
import {
  ReviewExchangeError,
  type ReadContentResult,
  type ReviewResponseReadResult,
} from '../agent/review-transport.js';
import type { PhaseSignalKind } from '../agent/phase-signal.js';
import { settlePermitOf } from '../agent/phase-signal-watcher.js';
import { computeBackoffMs } from '../timing/backoff.js';
import {
  reviewFindingsDigest,
  serverResponseFailureSignature,
} from '../state/review-store.js';

const LEGACY_DIFF_LARGE_THRESHOLD = 2000;
const FILE_HEADER_RE = /^diff --git a\/(.+?) b\//;
const SERVER_HANDLER_ATTEMPTS = 3;
const SERVER_HANDLER_BACKOFF = { baseMs: 10, maxMs: 20, factor: 2, jitter: 0 } as const;
const SERVER_SIGNAL_KINDS = new Set<PhaseSignalKind>([
  'code-done', 'code-reviewed', 'code-fixed', 'code-ready', 'spec-done', 'spec-reviewed', 'spec-fixed',
]);

interface LegacyDiffFile {
  path: string;
  text: string;
  lines: number;
}

function splitLegacyDiffByFile(diff: string): LegacyDiffFile[] {
  if (diff.trim() === '') return [];
  const out: LegacyDiffFile[] = [];
  let current: { path: string; lines: string[] } | null = null;
  const flush = () => {
    if (!current) return;
    out.push({
      path: current.path,
      text: current.lines.join('\n'),
      lines: current.lines.length,
    });
    current = null;
  };
  for (const line of diff.split('\n')) {
    const m = FILE_HEADER_RE.exec(line);
    if (m) {
      flush();
      current = { path: m[1], lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  flush();
  return out;
}

function legacyTopDir(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '.' : path.slice(0, idx);
}

function buildLegacyBatches(files: LegacyDiffFile[], maxLines: number): LegacyDiffFile[][] {
  const groups: Array<{ files: LegacyDiffFile[]; lines: number }> = [];
  const indexByDir = new Map<string, number>();
  for (const file of files) {
    const dir = legacyTopDir(file.path);
    const existing = indexByDir.get(dir);
    if (existing === undefined) {
      indexByDir.set(dir, groups.length);
      groups.push({ files: [file], lines: file.lines });
    } else {
      groups[existing].files.push(file);
      groups[existing].lines += file.lines;
    }
  }

  const batches: LegacyDiffFile[][] = [];
  let pending: LegacyDiffFile[] = [];
  let pendingLines = 0;
  const flushPending = () => {
    if (pending.length === 0) return;
    batches.push(pending);
    pending = [];
    pendingLines = 0;
  };

  for (const group of groups) {
    if (group.lines > maxLines) {
      flushPending();
      for (const file of group.files) batches.push([file]);
      continue;
    }
    if (pendingLines + group.lines > maxLines) flushPending();
    pending.push(...group.files);
    pendingLines += group.lines;
  }
  flushPending();
  return batches;
}

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
    missing: [...findingIds].filter(id => !responseIds.has(id)).sort(),
    unknown: [...responseIds].filter(id => !findingIds.has(id)).sort(),
  };
}

function waitForHandlerRetry(attempt: number): Promise<void> {
  const ms = computeBackoffMs(attempt, SERVER_HANDLER_BACKOFF);
  return new Promise(resolve => setTimeout(resolve, ms));
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
  expectedTask: TaskGenerationGuard;
}

interface HandlerDispatchOptions {
  expectedTask?: TaskGenerationGuard;
  onSideEffect?: () => void;
  settlePermit?: unknown;
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
    || (expect.phase === 'spec' ? task.phase !== 'code' : !isSpecStagePhase(task.phase));
  if (token && token !== task.signalToken) return null;
  if (task.status !== expect.status || !phaseOk || !token) {
    await emitIntervention(bus, task, {
      phase: `${event.type}-stale`,
      taskStatus: task.status,
      taskPhase: task.phase ?? null,
    });
    return null;
  }
  return { task, expectedTask: taskGenerationGuard(task) };
}

export function registerServerEventHandlers(bus: EventBus, manager: AgentManager): void {
  const configured = manager.getReviewStore();
  if (!configured) {
    console.warn('[ServerEventHandler] no ReviewStore configured; server review mode disabled');
    return;
  }
  const reviewStore = configured;
  const transport = () => manager.getReviewTransport();

  async function releaseAtCap(
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
    if (field === 'agentId') {
      await manager.updateTask(task.id, { agentId: '' })
        .catch(err => console.error(`[ServerHandler] max_rounds clear agentId(${task.id}) failed:`, err));
    }
  }

  async function putVerdictRound(
    task: TaskState,
    agentId: string,
    kind: ServerSignalKind,
    data: ReviewRound,
    opts: HandlerDispatchOptions = {},
  ): Promise<boolean> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= SERVER_HANDLER_ATTEMPTS; attempt++) {
      try {
        const stored = opts.expectedTask
          ? await manager.putReviewRoundIfCurrent(task.id, data, opts.expectedTask)
          : (await reviewStore.putRound(task.id, data.phase, data), true);
        if (!stored) return false;
        return true;
      } catch (err) {
        lastError = err;
        try {
          const stored = await reviewStore.getRound(task.id, data.phase, data.round);
          if (stored && JSON.stringify(stored) === JSON.stringify(data)) return true;
        } catch (readBackError) {
          lastError = readBackError;
        }
        if (attempt < SERVER_HANDLER_ATTEMPTS) await waitForHandlerRetry(attempt);
      }
    }
    return holdConsumedSignal(
      task,
      agentId,
      kind,
      'verdict-store-failed',
      `server-${data.phase}-verdict-store-failed`,
      {
        round: data.round,
        error: lastError instanceof Error ? lastError.message : String(lastError),
      },
      opts.onSideEffect,
    );
  }

  async function holdConsumedSignal(
    task: TaskState,
    agentId: string,
    kind: PhaseSignalKind,
    reason: ServerSignalRecoveryReason,
    failurePhase: string,
    data: Record<string, unknown> = {},
    onSideEffect?: () => void,
  ): Promise<boolean> {
    if (!SERVER_SIGNAL_KINDS.has(kind)) {
      throw new Error(`unsupported consumed server signal kind: ${kind}`);
    }
    const phase = kind.startsWith('spec-') ? 'spec' : 'code';
    const round = phase === 'spec' ? (task.specReviewRound ?? 0) : task.reviewRound;
    const held = await manager.holdConsumedServerSignal(
      task,
      agentId,
      kind as ServerSignalKind,
      { phase, round, reason, failurePhase },
    );
    if (!held) return false;
    onSideEffect?.();
    await emitIntervention(bus, held, {
      phase: failurePhase,
      ...data,
      successorToken: held.signalToken,
    });
    return false;
  }

  async function readResponseWithRetry(
    task: TaskState,
    dev: AgentConfig,
  ): Promise<ReviewResponseReadResult> {
    let result: ReviewResponseReadResult | undefined;
    for (let attempt = 1; attempt <= SERVER_HANDLER_ATTEMPTS; attempt++) {
      result = await transport().readResponseWithRaw(task, dev);
      if (result.kind !== 'unknown' || attempt === SERVER_HANDLER_ATTEMPTS) return result;
      await waitForHandlerRetry(attempt);
    }
    return result!;
  }

  async function runConsumedSignal(
    task: TaskState,
    agentId: string,
    kind: ServerSignalKind,
    handler: () => Promise<void>,
  ): Promise<void> {
    try {
      await handler();
    } catch (err) {
      await holdConsumedSignal(
        task,
        agentId,
        kind,
        'handler-failed',
        `server-${kind.startsWith('spec-') ? 'spec' : 'code'}-handler-failed`,
        { error: err instanceof Error ? err.message : String(err) },
      );
    }
  }

  async function deleteFindingsOrHold(
    task: TaskState,
    qa: AgentConfig,
    kind: Extract<ServerSignalKind, 'code-reviewed' | 'spec-reviewed'>,
    expectedTask: TaskGenerationGuard,
  ): Promise<boolean> {
    try {
      return await manager.deleteReviewExchangeIfCurrent(
        task.id,
        qa,
        'findings',
        expectedTask,
      );
    } catch (err) {
      await holdConsumedSignal(
        task,
        qa.id,
        kind,
        'handler-failed',
        `server-${kind.startsWith('spec-') ? 'spec' : 'code'}-findings-cleanup-failed`,
        { error: err instanceof Error ? err.message : String(err) },
      );
      return false;
    }
  }

  async function deleteResponseOrHold(
    task: TaskState,
    dev: AgentConfig,
    kind: Extract<ServerSignalKind, 'code-fixed' | 'spec-fixed'>,
    opts: HandlerDispatchOptions,
  ): Promise<boolean> {
    try {
      const deleted = await manager.deleteReviewExchangeIfCurrent(
        task.id,
        dev,
        'response',
        opts.expectedTask ?? taskGenerationGuard(task),
      );
      if (deleted) opts.onSideEffect?.();
      return deleted;
    } catch (err) {
      return holdConsumedSignal(
        task,
        dev.id,
        kind,
        'handler-failed',
        `server-${kind.startsWith('spec-') ? 'spec' : 'code'}-response-cleanup-failed`,
        { error: err instanceof Error ? err.message : String(err) },
        opts.onSideEffect,
      );
    }
  }

  async function rejectServerResponse(
    task: TaskState,
    dev: AgentConfig,
    roundData: ReviewRound & { findings: ReviewFindings },
    failure: {
      reason: ServerResponseFailure['reason'];
      failurePhase: string;
      rawResponse?: string;
      responseDigest?: string;
      missingFindingIds?: string[];
      unknownFindingIds?: string[];
      schemaViolationCodes?: string[];
      details?: Record<string, unknown>;
    },
    onSideEffect?: () => void,
  ): Promise<boolean> {
    const phase = roundData.phase;
    const signalKind = `${phase}-fixed` as const;
    const sourceToken = task.signalToken;
    if (!sourceToken) return false;
    const findingsDigest = reviewFindingsDigest(roundData.findings);
    const missingFindingIds = [...(failure.missingFindingIds ?? [])].sort();
    const unknownFindingIds = [...(failure.unknownFindingIds ?? [])].sort();
    const schemaViolationCodes = [...(failure.schemaViolationCodes ?? [])].sort();
    const failureSignature = serverResponseFailureSignature({
      phase,
      round: roundData.round,
      findingsDigest,
      reason: failure.reason,
      missingFindingIds,
      unknownFindingIds,
      schemaViolationCodes,
    });
    const claimed = await manager.claimServerSignalRecovery(task, dev.id, signalKind, {
      mode: 'classify-response',
      phase,
      round: roundData.round,
      findingsDigest,
      failureSignature,
      reason: failure.reason,
      failurePhase: failure.failurePhase,
      missingFindingIds,
      unknownFindingIds,
      schemaViolationCodes,
      ...(failure.responseDigest ? { responseDigest: failure.responseDigest } : {}),
    });
    if (!claimed?.signalToken) return false;
    onSideEffect?.();
    let recorded: ServerResponseFailure;
    try {
      recorded = await reviewStore.recordServerResponseFailure(task.id, phase, roundData.round, {
        signalKind,
        sourceToken,
        successorToken: claimed.signalToken,
        failureSignature,
        reason: failure.reason,
        missingFindingIds,
        unknownFindingIds,
        schemaViolationCodes,
        createdAt: new Date().toISOString(),
        ...(failure.responseDigest ? { responseDigest: failure.responseDigest } : {}),
        ...(failure.rawResponse !== undefined ? { rawResponse: failure.rawResponse } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const held = await manager.holdServerSignalRecovery(
        task.id,
        dev.id,
        claimed.signalToken,
        `server-${phase}-response-audit-store-failed`,
        `${message}. The response file was preserved and the old token is retired.`,
      );
      if (!held) return false;
      await emitIntervention(bus, held, {
        phase: `server-${phase}-response-audit-store-failed`,
        round: roundData.round,
        error: message,
        successorToken: claimed.signalToken,
      });
      return false;
    }
    const nextMode = recorded.disposition === 'auto-correct' ? 'correct-response' : 'hold';
    const finalized = await manager.setServerSignalRecoveryMode(task.id, claimed.signalToken, nextMode);
    if (!finalized) return false;
    if (recorded.disposition !== 'auto-correct') {
      const holdPhase = recorded.disposition === 'hold-repeated-signature'
        ? 'server-feedback-response-repeated'
        : 'server-feedback-correction-limit';
      const held = await manager.holdServerSignalRecovery(
        task.id,
        dev.id,
        claimed.signalToken,
        holdPhase,
        `The ${phase} response failed with ${failure.reason}; automatic correction stopped `
        + `(${recorded.disposition}). Rewrite it deliberately, then Restart or Cancel the task.`,
      );
      if (!held) return false;
      await emitIntervention(bus, held, {
        phase: holdPhase,
        reviewPhase: phase,
        round: roundData.round,
        reason: failure.reason,
        disposition: recorded.disposition,
        missingFindingIds,
        unknownFindingIds,
        findingsDigest,
        successorToken: claimed.signalToken,
      });
      return false;
    }
    const beforeCleanup = await manager.getTask(task.id);
    const currentRecovery = beforeCleanup?.serverSignalRecovery;
    const currentRound = phase === 'spec' ? beforeCleanup?.specReviewRound : beforeCleanup?.reviewRound;
    if (!beforeCleanup
      || beforeCleanup.status !== task.status
      || beforeCleanup.phase !== task.phase
      || beforeCleanup.signalToken !== claimed.signalToken
      || currentRound !== roundData.round
      || currentRecovery?.mode !== 'correct-response'
      || currentRecovery.sourceToken !== sourceToken
      || currentRecovery.failureSignature !== failureSignature) {
      return false;
    }
    try {
      const deleted = await manager.deleteReviewExchangeIfCurrent(
        task.id,
        dev,
        'response',
        taskGenerationGuard(beforeCleanup),
        currentRecovery,
      );
      if (!deleted) return false;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const held = await manager.holdServerSignalRecovery(
        task.id,
        dev.id,
        claimed.signalToken,
        `server-${phase}-response-cleanup-failed`,
        `${message}. The rejected response is archived, but the live file could not be removed safely.`,
      );
      if (!held) return false;
      await emitIntervention(bus, held, {
        phase: `server-${phase}-response-cleanup-failed`,
        round: roundData.round,
        error: message,
        successorToken: claimed.signalToken,
      });
      return false;
    }
    await emitIntervention(bus, finalized, {
      phase: failure.failurePhase,
      round: roundData.round,
      reason: failure.reason,
      missingFindingIds,
      unknownFindingIds,
      schemaViolationCodes,
      findingsDigest,
      responseDigest: failure.responseDigest,
      successorToken: claimed.signalToken,
      ...failure.details,
    });
    await manager.dispatchServerFeedbackCorrection(task.id, JSON.stringify(roundData.findings));
    return false;
  }

  function resolveActiveQa(task: TaskState): AgentConfig | undefined {
    if (!task.qaAgentId) return undefined;
    const recorded = manager.getAgentConfig(task.qaAgentId);
    return recorded?.role === 'qa' ? recorded : undefined;
  }

  async function pauseForUnavailableQa(
    task: TaskState,
    entryKind: PhaseSignalKind,
    phase: string,
    onSideEffect?: () => void,
  ): Promise<boolean> {
    if (!task.qaAgentId || resolveActiveQa(task)) return false;
    await holdConsumedSignal(
      task,
      task.agentId,
      entryKind,
      'handler-failed',
      phase,
      { qaAgentId: task.qaAgentId },
      onSideEffect,
    );
    return true;
  }

  async function autoApproveCode(
    task: TaskState,
    expectedTask?: TaskGenerationGuard,
    entryKind: PhaseSignalKind = 'code-done',
    onSideEffect?: () => void,
  ): Promise<void> {
    const afterDone = await manager.commitServerAfterDone(task.id, expectedTask);
    onSideEffect?.();
    if (afterDone === null) {
      const ready = await manager.transitionTaskStatus(task.id, 'ready', {
        fromStatus: ['in_progress', 'fixing'],
        ...(expectedTask !== undefined ? { expectTask: expectedTask } : {}),
      });
      if (ready) onSideEffect?.();
      if (!ready) {
        await holdConsumedSignal(
          task,
          task.agentId,
          entryKind,
          'handler-failed',
          'server-code-auto-approve-transition-failed',
          {},
          onSideEffect,
        );
      }
      return;
    }
    const dev = manager.getAgentConfig(task.agentId);
    if (!dev) {
      await holdConsumedSignal(
        task,
        task.agentId,
        entryKind,
        'fix-no-dev-agent',
        'server-code-auto-approve-no-dev-agent',
        {},
        onSideEffect,
      );
      return;
    }
    await manager.refreshWorkdirCacheFor(task.agentId);
    let reviewHeadAnchorSha: string;
    try {
      reviewHeadAnchorSha = await transport().readHeadSha(dev);
    } catch (err) {
      await holdConsumedSignal(
        task,
        task.agentId,
        entryKind,
        'handler-failed',
        'server-code-auto-approve-head-capture-failed',
        { error: err instanceof Error ? err.message : String(err) },
        onSideEffect,
      );
      return;
    }
    const approved = await manager.transitionTaskStatus(
      task.id,
      'approved',
      {
        fromStatus: ['in_progress', 'fixing'],
        ...(expectedTask !== undefined ? { expectTask: expectedTask } : {}),
      },
      { reviewHeadAnchorSha },
    );
    if (approved) onSideEffect?.();
    if (!approved) {
      await holdConsumedSignal(
        task,
        task.agentId,
        entryKind,
        'handler-failed',
        'server-code-auto-approve-transition-failed',
        {},
        onSideEffect,
      );
      return;
    }
    const dispatched = await manager.dispatchServerAfterDone(task.id, afterDone);
    if (!dispatched) {
      await holdConsumedSignal(
        task,
        task.agentId,
        entryKind,
        'handler-failed',
        'server-code-auto-approve-publish-dispatch-failed',
        {},
        onSideEffect,
      );
    }
  }

  function specApprovalIsHuman(task: TaskState): boolean {
    return task.researchAgentId !== undefined
      || manager.getProjectConfig(task.projectId)?.specApproval === 'human';
  }

  async function advanceApprovedSpec(
    task: TaskState,
    failurePhase: string,
    expectedTask?: TaskGenerationGuard,
  ): Promise<void> {
    try {
      const result = specApprovalIsHuman(task)
        ? await manager.parkTaskAtSpecReady(task.id, {
            ...(expectedTask !== undefined ? { expectedTask } : {}),
          })
        : await manager.transitionToCodePhase(task.id, expectedTask);
      if (!result) {
        await holdConsumedSignal(task, task.qaAgentId ?? task.agentId, 'spec-reviewed', 'handler-failed', failurePhase);
      }
    } catch (err) {
      await holdConsumedSignal(
        task,
        task.qaAgentId ?? task.agentId,
        'spec-reviewed',
        'handler-failed',
        failurePhase,
        { error: err instanceof Error ? err.message : String(err) },
      );
    }
  }

  async function autoApproveSpec(
    task: TaskState,
    expectedTask?: TaskGenerationGuard,
    onSideEffect?: () => void,
  ): Promise<boolean> {
    try {
      const result = await manager.transitionToCodePhase(task.id, expectedTask);
      if (result) onSideEffect?.();
      if (!result) {
        await holdConsumedSignal(
          task,
          task.agentId,
          task.status === 'fixing' ? 'spec-fixed' : 'spec-done',
          'handler-failed',
          'server-spec-auto-approve-transition-failed',
          {},
          onSideEffect,
        );
        return false;
      }
      return true;
    } catch (err) {
      await holdConsumedSignal(
        task,
        task.agentId,
        task.status === 'fixing' ? 'spec-fixed' : 'spec-done',
        'handler-failed',
        'server-spec-auto-approve-transition-failed',
        { error: err instanceof Error ? err.message : String(err) },
        onSideEffect,
      );
      return false;
    }
  }

  async function prepareAndDispatchCodeReview(
    task: TaskState,
    opts: {
      recheck: boolean;
      bumpRound?: boolean;
      expectedTask?: TaskGenerationGuard;
      onSideEffect?: () => void;
      priorFindingsJson?: string;
      priorResponseJson?: string;
      settlePermit?: unknown;
    },
  ): Promise<boolean> {
    const dev = manager.getAgentConfig(task.agentId);
    if (!dev) {
      const kind = task.status === 'fixing' ? 'code-fixed' : 'code-done';
      return holdConsumedSignal(
        task,
        task.agentId,
        kind,
        'fix-no-dev-agent',
        'server-code-review-no-dev-agent',
        {},
        opts.onSideEffect,
      );
    }
    const cap = manager.getConfig().review.rounds + (task.maxRoundsContinues ?? 0);
    const nextRound = opts.bumpRound === false ? task.reviewRound : task.reviewRound + 1;
    if (nextRound > cap) {
      const capResult = await manager.transitionTaskStatus(task.id, 'max_rounds', {
        fromStatus: ['in_progress', 'fixing'],
        ...(opts.expectedTask !== undefined ? { expectTask: opts.expectedTask } : {}),
      });
      if (!capResult) return false;
      opts.onSideEffect?.();
      const paused = capResult.task;
      if (paused.qaAgentId) await releaseAtCap(paused, paused.qaAgentId, 'qaAgentId');
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

    let content: ReadContentResult;
    let reviewHeadAnchorSha: string;
    if (opts.bumpRound === false) {
      const stored = await reviewStore.getRound(task.id, 'code', nextRound);
      if (!stored || stored.phase !== 'code' || !stored.headSha) {
        throw new Error(`Task ${task.id} has no persisted code review round ${nextRound} to redispatch`);
      }
      content = {
        content: stored.content,
        ...(stored.diffstat ? { diffstat: stored.diffstat } : {}),
        ...(stored.baseSha ? { baseSha: stored.baseSha } : {}),
        headSha: stored.headSha,
        ...(stored.headTree ? { headTree: stored.headTree } : {}),
      };
      reviewHeadAnchorSha = stored.headSha;
    } else {
      await manager.refreshWorkdirCacheFor(task.agentId);
      try {
        content = await transport().readContent(task, dev, 'code');
        if (!content.headSha) throw new ReviewExchangeError('head-failed', 'review head missing from captured content');
        reviewHeadAnchorSha = content.headSha;
      } catch (err) {
        const kind = task.status === 'fixing' ? 'code-fixed' : 'code-done';
        return holdConsumedSignal(
          task,
          task.agentId,
          kind,
          'handler-failed',
          'server-code-content-read-failed',
          { error: err instanceof Error ? err.message : String(err) },
          opts.onSideEffect,
        );
      }
      try {
        const violation = await manager.findLineageViolation(task.id, content.baseSha);
        if (violation) {
          const kind = task.status === 'fixing' ? 'code-fixed' : 'code-done';
          return holdConsumedSignal(task, task.agentId, kind, 'handler-failed', 'server-code-lineage-violation', {
            offendingTaskId: violation.taskId,
            offendingBranch: violation.branch,
            offendingSha: violation.sha,
            note: 'The task branch embeds another active task\'s commits — reviewing it would leak foreign work into this task. Have the dev rebase onto origin/HEAD and re-emit the signal.',
          }, opts.onSideEffect);
        }
      } catch (err) {
        const kind = task.status === 'fixing' ? 'code-fixed' : 'code-done';
        return holdConsumedSignal(
          task,
          task.agentId,
          kind,
          'handler-failed',
          'server-code-lineage-check-failed',
          { error: err instanceof Error ? err.message : String(err) },
          opts.onSideEffect,
        );
      }
    }

    const round: ReviewRound = {
      round: nextRound,
      phase: 'code',
      content: content.content,
      headSha: reviewHeadAnchorSha,
      ...(content.diffstat ? { diffstat: content.diffstat } : {}),
      ...(content.baseSha ? { baseSha: content.baseSha } : {}),
      ...(content.headTree ? { headTree: content.headTree } : {}),
      startedAt: new Date().toISOString(),
    };

    const putEntryRound = (data: ReviewRound): Promise<boolean> => putVerdictRound(
      task,
      task.agentId,
      task.status === 'fixing' ? 'code-fixed' : 'code-done',
      data,
      opts,
    );

    const resolveRecheckInterdiff = async (): Promise<string | undefined> => {
      if (!opts.recheck) return undefined;
      try {
        const result = await manager.computeCodeInterdiff(task.id, nextRound);
        return result.ok && result.diff.trim() !== '' ? result.diff : undefined;
      } catch (err) {
        console.warn(
          `[ServerEventHandler] recheck interdiff unavailable for task ${task.id} round ${nextRound}; ` +
          `dispatching full diff only: ${err instanceof Error ? err.message : String(err)}`,
        );
        return undefined;
      }
    };

    if (opts.bumpRound !== false && !(await putEntryRound(round))) return false;
    const interdiff = await resolveRecheckInterdiff();
    const dispatched = await manager.dispatchServerReviewToQa(task.id, {
      phase: 'code',
      recheck: opts.recheck,
      ...(opts.bumpRound !== undefined ? { bumpRound: opts.bumpRound } : {}),
      content: content.content,
      reviewHeadAnchorSha,
      ...(content.baseSha ? { baseSha: content.baseSha } : {}),
      ...(content.headTree ? { headTree: content.headTree } : {}),
      ...(interdiff ? { interdiff } : {}),
      ...(content.diffstat ? { diffstat: content.diffstat } : {}),
      ...(opts.priorFindingsJson ? { priorFindingsJson: opts.priorFindingsJson } : {}),
      ...(opts.priorResponseJson ? { priorResponseJson: opts.priorResponseJson } : {}),
      callerOwnsConsumedSignalFailure: true,
      ...(opts.settlePermit !== undefined ? { settlePermit: opts.settlePermit } : {}),
      ...(opts.expectedTask !== undefined ? { expectedTask: opts.expectedTask } : {}),
      ...(opts.onSideEffect !== undefined ? { onSideEffect: opts.onSideEffect } : {}),
    });
    if (dispatched) return true;
    const kind = task.status === 'fixing' ? 'code-fixed' : 'code-done';
    return holdConsumedSignal(
      task,
      task.agentId,
      kind,
      'handler-failed',
      'server-code-review-dispatch-failed',
      {},
      opts.onSideEffect,
    );
  }

  async function dispatchLegacyBatch(
    taskId: string,
    batches: LegacyDiffFile[][],
    index: number,
    diffstat: string | undefined,
    opts: {
      recheck: boolean;
      priorFindingsJson?: string;
      priorResponseJson?: string;
      expectedTask?: TaskGenerationGuard;
      settlePermit?: unknown;
    },
  ): Promise<boolean> {
    const text = batches[index].map(f => f.text).join('\n');
    const dispatched = await manager.dispatchServerReviewToQa(taskId, {
      phase: 'code',
      recheck: opts.recheck,
      continuation: true,
      content: text,
      ...(diffstat ? { diffstat } : {}),
      batch: { index, total: batches.length },
      ...(opts.priorFindingsJson ? { priorFindingsJson: opts.priorFindingsJson } : {}),
      ...(opts.priorResponseJson ? { priorResponseJson: opts.priorResponseJson } : {}),
      callerOwnsConsumedSignalFailure: true,
      ...(opts.settlePermit !== undefined ? { settlePermit: opts.settlePermit } : {}),
      ...(opts.expectedTask !== undefined ? { expectedTask: opts.expectedTask } : {}),
    });
    return dispatched !== null;
  }

  function rebuildLegacyBatches(roundData: ReviewRound): LegacyDiffFile[][] {
    return buildLegacyBatches(splitLegacyDiffByFile(roundData.content), LEGACY_DIFF_LARGE_THRESHOLD);
  }

  bus.on('server.code.ready', async (event) => {
    const gated = await gate(bus, manager, event, { status: 'in_progress', phase: 'code', requireServerMode: true });
    if (!gated) return;
    const { task, expectedTask } = gated;
    await runConsumedSignal(task, task.agentId, 'code-done', async () => {
      if (await pauseForUnavailableQa(task, 'code-done', 'server-code-qa-unavailable')) return;
      if (!task.qaAgentId) {
        await autoApproveCode(task, expectedTask);
        return;
      }
      await prepareAndDispatchCodeReview(task, { recheck: false, expectedTask, settlePermit: settlePermitOf(event) });
    });
  });

  bus.on('server.code.review.submitted', async (event) => {
    const gated = await gate(bus, manager, event, { status: 'review', phase: 'code', requireServerMode: true });
    if (!gated) return;
    const { task, expectedTask } = gated;
    await runConsumedSignal(task, task.qaAgentId ?? task.agentId, 'code-reviewed', async () => {
      const qa = manager.getAgentConfig(task.qaAgentId ?? '');
      if (!qa) {
        await holdConsumedSignal(
          task,
          task.qaAgentId ?? '',
          'code-reviewed',
          'handler-failed',
          'server-code-review-no-qa-agent',
        );
        return;
      }
      const round = Math.max(task.reviewRound, 1);
      const roundData = await reviewStore.getRound(task.id, 'code', round);
      if (!roundData) {
        await holdConsumedSignal(
          task,
          qa.id,
          'code-reviewed',
          'handler-failed',
          'server-code-review-round-missing',
          { round },
        );
        return;
      }

      await manager.refreshWorkdirCacheFor(qa.id);
      let findings: ReviewFindings | null;
      try {
        findings = await transport().readFindings(task, qa);
      } catch (err) {
        const reason = err instanceof ReviewExchangeError ? err.reason : 'unknown';
        await holdConsumedSignal(
          task,
          qa.id,
          'code-reviewed',
          'handler-failed',
          'server-code-findings-invalid',
          { reason, error: err instanceof Error ? err.message : String(err) },
        );
        return;
      }

      let current = roundData;
      if (findings === null) {
        const alreadyStored = task.batchTotal !== undefined
          ? (roundData.batchFindings?.length ?? 0) > (task.batchIndex ?? 0)
          : roundData.findings !== undefined;
        if (!alreadyStored) {
          await holdConsumedSignal(
            task,
            qa.id,
            'code-reviewed',
            'handler-failed',
            'server-code-findings-missing',
            { round },
          );
          return;
        }
      } else if (findings.round !== round) {
        await holdConsumedSignal(
          task,
          qa.id,
          'code-reviewed',
          'handler-failed',
          'server-code-findings-round-mismatch',
          { round, payloadRound: findings.round },
        );
        return;
      } else if (task.batchTotal !== undefined && task.batchIndex !== undefined) {
        const batchFindings = [...(roundData.batchFindings ?? [])];
        batchFindings[task.batchIndex] = findings;
        current = { ...roundData, batchFindings };
        if (!(await putVerdictRound(task, qa.id, 'code-reviewed', current, { expectedTask }))) return;
        if (!(await deleteFindingsOrHold(task, qa, 'code-reviewed', expectedTask))) return;
      } else {
        current = { ...roundData, findings, completedAt: new Date().toISOString() };
        if (!(await putVerdictRound(task, qa.id, 'code-reviewed', current, { expectedTask }))) return;
        if (!(await deleteFindingsOrHold(task, qa, 'code-reviewed', expectedTask))) return;
      }

      const isRecheck = round > 1;
      if (task.batchTotal !== undefined && task.batchIndex !== undefined) {
        const nextIndex = task.batchIndex + 1;
        if (nextIndex < task.batchTotal) {
          const prev = isRecheck ? await reviewStore.getRound(task.id, 'code', round - 1) : null;
          const dispatched = await dispatchLegacyBatch(task.id, rebuildLegacyBatches(current), nextIndex, current.diffstat, {
            recheck: isRecheck,
            ...(prev?.findings ? { priorFindingsJson: JSON.stringify(prev.findings) } : {}),
            ...(prev?.response ? { priorResponseJson: JSON.stringify(prev.response) } : {}),
            expectedTask,
            settlePermit: settlePermitOf(event),
          });
          if (!dispatched) {
            await holdConsumedSignal(
              task,
              qa.id,
              'code-reviewed',
              'handler-failed',
              'server-code-review-continuation-dispatch-failed',
            );
          }
          return;
        }
        const aggregated = current.findings
          ?? aggregateBatchFindings((current.batchFindings ?? []).filter(Boolean), round);
        if (!current.findings) {
          const stored = await putVerdictRound(task, qa.id, 'code-reviewed', {
            ...current,
            findings: aggregated,
            completedAt: new Date().toISOString(),
          }, { expectedTask });
          if (!stored) return;
        }
        const cleared = await manager.updateTaskIfStatus(
          task.id,
          expectedTask.status,
          { batchIndex: undefined, batchTotal: undefined },
          expectedTask,
        );
        if (!cleared) return;
        await routeCodeVerdict(
          { ...task, batchIndex: undefined, batchTotal: undefined },
          aggregated,
          expectedTask,
        );
        return;
      }

      await routeCodeVerdict(task, current.findings!, expectedTask);
    });
  });

  async function routeCodeVerdict(
    task: TaskState,
    findings: ReviewFindings,
    expectedTask: TaskGenerationGuard,
  ): Promise<void> {
    if (findings.verdict === 'approve') {
      const afterDone = await manager.commitServerAfterDone(task.id, expectedTask);
      if (afterDone === null) {
        const ready = await manager.transitionTaskStatus(
          task.id,
          'ready',
          { fromStatus: ['review'], expectTask: expectedTask },
        );
        if (!ready) {
          await holdConsumedSignal(
            task,
            task.qaAgentId ?? task.agentId,
            'code-reviewed',
            'handler-failed',
            'server-code-ready-transition-failed',
          );
        }
        return;
      }
      const approved = await manager.transitionTaskStatus(
        task.id,
        'approved',
        { fromStatus: ['review'], expectTask: expectedTask },
      );
      if (!approved) {
        await holdConsumedSignal(
          task,
          task.qaAgentId ?? task.agentId,
          'code-reviewed',
          'handler-failed',
          'server-code-approved-transition-failed',
        );
        return;
      }
      const dispatched = await manager.dispatchServerAfterDone(task.id, afterDone);
      if (!dispatched) {
        await holdConsumedSignal(
          task,
          task.qaAgentId ?? task.agentId,
          'code-reviewed',
          'handler-failed',
          'server-code-publish-dispatch-failed',
        );
      }
      return;
    }
    const cap = manager.getConfig().review.rounds + (task.maxRoundsContinues ?? 0);
    if (task.reviewRound >= cap) {
      const capResult = await manager.transitionTaskStatus(
        task.id,
        'max_rounds',
        { fromStatus: ['review'], expectTask: expectedTask },
      );
      if (!capResult) return;
      const paused = capResult.task;
      if (paused.qaAgentId) {
        await releaseAtCap(paused, paused.qaAgentId, 'qaAgentId', { allowAwaitingHuman: true });
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
    const dispatched = await manager.dispatchServerFixToDev(
      task.id,
      JSON.stringify(findings),
      { callerOwnsConsumedSignalFailure: true, expectedTask },
    );
    if (!dispatched) {
      await holdConsumedSignal(
        task,
        task.qaAgentId ?? task.agentId,
        'code-reviewed',
        'handler-failed',
        'server-code-fix-dispatch-failed',
      );
    }
  }

  async function recheckCodeOrAutoApprove(
    task: TaskState,
    priorFindingsJson: string,
    priorResponseJson: string,
    opts: HandlerDispatchOptions = {},
  ): Promise<boolean> {
    if (await pauseForUnavailableQa(
      task,
      'code-fixed',
      'server-code-qa-unavailable-after-fix',
      opts.onSideEffect,
    )) {
      return false;
    }
    if (!task.qaAgentId) {
      await autoApproveCode(task, opts.expectedTask, 'code-fixed', opts.onSideEffect);
      return true;
    }
    return prepareAndDispatchCodeReview(task, {
      recheck: true,
      priorFindingsJson,
      priorResponseJson,
      ...opts,
    });
  }

  async function runCodeFixSubmission(
    task: TaskState,
    opts: HandlerDispatchOptions = {},
  ): Promise<boolean> {
    const dev = manager.getAgentConfig(task.agentId);
    if (!dev) {
      return holdConsumedSignal(
        task,
        task.agentId,
        'code-fixed',
        'fix-no-dev-agent',
        'server-code-fix-no-dev-agent',
        {},
        opts.onSideEffect,
      );
    }
    const round = Math.max(task.reviewRound, 1);
    const roundData = await reviewStore.getRound(task.id, 'code', round);
    if (!roundData?.findings) {
      return holdConsumedSignal(
        task,
        task.agentId,
        'code-fixed',
        'fix-findings-missing',
        'server-code-fix-findings-missing',
        { round },
        opts.onSideEffect,
      );
    }

    await manager.refreshWorkdirCacheFor(task.agentId);
    let readResult: ReviewResponseReadResult;
    try {
      readResult = await readResponseWithRetry(task, dev);
    } catch (err) {
      return holdConsumedSignal(
        task,
        dev.id,
        'code-fixed',
        'response-read-failed',
        'server-code-response-read-failed',
        {
          reason: err instanceof ReviewExchangeError ? err.reason : 'read-failed',
          error: err instanceof Error ? err.message : String(err),
        },
        opts.onSideEffect,
      );
    }
    if (readResult.kind === 'unknown') {
      return holdConsumedSignal(
        task,
        dev.id,
        'code-fixed',
        'response-read-failed',
        'server-code-response-read-failed',
        { reason: readResult.error.reason, error: readResult.error.message },
        opts.onSideEffect,
      );
    }
    if (readResult.kind === 'invalid') {
      return rejectServerResponse(task, dev, roundData as ReviewRound & { findings: ReviewFindings }, {
        reason: 'response-invalid',
        failurePhase: 'server-code-response-invalid',
        rawResponse: readResult.raw,
        responseDigest: readResult.responseDigest,
        schemaViolationCodes: readResult.schemaViolationCodes,
        details: { error: readResult.error.message },
      }, opts.onSideEffect);
    }
    if (readResult.kind === 'absent') {
      if (roundData.response === undefined) {
        return rejectServerResponse(task, dev, roundData as ReviewRound & { findings: ReviewFindings }, {
          reason: 'response-missing',
          failurePhase: 'server-code-response-missing',
        }, opts.onSideEffect);
      }
      return recheckCodeOrAutoApprove(
        task,
        JSON.stringify(roundData.findings),
        JSON.stringify(roundData.response),
        opts,
      );
    }
    const { response } = readResult;
    if (response.round !== round) {
      return rejectServerResponse(task, dev, roundData as ReviewRound & { findings: ReviewFindings }, {
        reason: 'round-mismatch',
        failurePhase: 'server-code-response-round-mismatch',
        rawResponse: readResult.raw,
        responseDigest: readResult.responseDigest,
        details: { payloadRound: response.round },
      }, opts.onSideEffect);
    }
    if (response.token !== task.signalToken) {
      return rejectServerResponse(task, dev, roundData as ReviewRound & { findings: ReviewFindings }, {
        reason: 'token-mismatch',
        failurePhase: 'server-code-response-token-mismatch',
        rawResponse: readResult.raw,
        responseDigest: readResult.responseDigest,
      }, opts.onSideEffect);
    }
    const findingsDigest = reviewFindingsDigest(roundData.findings);
    if (response.findingsDigest !== findingsDigest) {
      return rejectServerResponse(task, dev, roundData as ReviewRound & { findings: ReviewFindings }, {
        reason: 'findings-digest-mismatch',
        failurePhase: 'server-code-response-findings-digest-mismatch',
        rawResponse: readResult.raw,
        responseDigest: readResult.responseDigest,
      }, opts.onSideEffect);
    }

    const gaps = coverageGaps(roundData.findings, new Set(response.responses.map(r => r.findingId)));
    if (gaps.missing.length > 0 || gaps.unknown.length > 0) {
      return rejectServerResponse(task, dev, roundData as ReviewRound & { findings: ReviewFindings }, {
        reason: 'coverage-gap',
        failurePhase: 'server-code-response-coverage-gap',
        rawResponse: readResult.raw,
        responseDigest: readResult.responseDigest,
        missingFindingIds: gaps.missing,
        unknownFindingIds: gaps.unknown,
      }, opts.onSideEffect);
    }

    if (!(await putVerdictRound(
      task,
      dev.id,
      'code-fixed',
      { ...roundData, response },
      opts,
    ))) return false;
    if (!(await deleteResponseOrHold(task, dev, 'code-fixed', opts))) return false;

    return recheckCodeOrAutoApprove(
      task,
      JSON.stringify(roundData.findings),
      JSON.stringify(response),
      opts,
    );
  }

  bus.on('server.code.fix.submitted', async (event) => {
    const gated = await gate(bus, manager, event, { status: 'fixing', phase: 'code', requireServerMode: true });
    if (!gated) return;
    await runConsumedSignal(gated.task, gated.task.agentId, 'code-fixed', async () => {
      await runCodeFixSubmission(gated.task, { expectedTask: gated.expectedTask, settlePermit: settlePermitOf(event) });
    });
  });

  bus.on('server.code.published', async (event) => {
    const gated = await gate(bus, manager, event, { status: 'approved', phase: 'code', requireServerMode: true });
    if (!gated) return;
    const { task } = gated;
    await runConsumedSignal(task, task.agentId, 'code-ready', async () => {
      const prNumber = typeof event.data?.prNumber === 'number' ? event.data.prNumber : task.prNumber;
      if (prNumber === undefined && manager.resolveAfterDone(task) === 'pr') {
        await holdConsumedSignal(
          task,
          task.agentId,
          'code-ready',
          'handler-failed',
          'server-code-published-missing-pr-number',
        );
        return;
      }
      const dev = manager.getAgentConfig(task.agentId);
      if (!dev) {
        await holdConsumedSignal(
          task,
          task.agentId,
          'code-ready',
          'fix-no-dev-agent',
          'server-code-published-no-dev-agent',
        );
        return;
      }
      await manager.refreshWorkdirCacheFor(task.agentId);
      let publishedHead: string;
      try {
        publishedHead = await transport().readHeadSha(dev);
      } catch (err) {
        await holdConsumedSignal(
          task,
          task.agentId,
          'code-ready',
          'handler-failed',
          'server-code-published-head-capture-failed',
          { error: err instanceof Error ? err.message : String(err) },
        );
        return;
      }
      if (publishedHead !== task.reviewHeadAnchorSha) {
        await holdConsumedSignal(task, task.agentId, 'code-ready', 'handler-failed', 'server-code-published-head-mismatch', {
          publishedHead,
          reviewedHead: task.reviewHeadAnchorSha ?? null,
        });
        return;
      }
      let verifiedBaseBranch: string | undefined;
      if (prNumber !== undefined) {
        const verified = await manager.verifyPaneSignalPrNumber(task.id, prNumber);
        if (!verified) {
          await holdConsumedSignal(
            task,
            task.agentId,
            'code-ready',
            'handler-failed',
            'server-code-published-pr-number-unverified',
            { prNumber },
          );
          return;
        }
        if (verified.headSha !== publishedHead) {
          await holdConsumedSignal(
            task,
            task.agentId,
            'code-ready',
            'handler-failed',
            'server-code-published-pr-head-mismatch',
            {
              prNumber,
              remoteHead: verified.headSha,
              publishedHead,
              reviewedHead: task.reviewHeadAnchorSha,
            },
          );
          return;
        }
        verifiedBaseBranch = verified.targetBranch;
      }
      let ready: Awaited<ReturnType<AgentManager['transitionTaskStatus']>>;
      try {
        ready = await manager.transitionTaskStatus(
          task.id,
          'ready',
          { fromStatus: ['approved'], expectTask: gated.expectedTask },
          {
            ...(prNumber !== undefined ? { prNumber } : {}),
            ...(prNumber !== undefined
              && task.baseBranch === undefined
              && verifiedBaseBranch !== undefined
              ? { baseBranch: verifiedBaseBranch }
              : {}),
            latestHeadSha: publishedHead,
          },
        );
      } catch (err) {
        await holdConsumedSignal(
          task,
          task.agentId,
          'code-ready',
          'handler-failed',
          'server-code-published-head-capture-failed',
          { error: err instanceof Error ? err.message : String(err) },
        );
        return;
      }
      if (!ready) {
        await holdConsumedSignal(
          task,
          task.agentId,
          'code-ready',
          'handler-failed',
          'server-code-published-transition-failed',
        );
      }
    });
  });

  bus.on('server.spec.ready', async (event) => {
    const gated = await gate(bus, manager, event, { status: 'in_progress', phase: 'spec', requireServerMode: false });
    if (!gated) return;
    await runConsumedSignal(gated.task, gated.task.agentId, 'spec-done', async () => {
      await dispatchSpecReview(gated.task, undefined, { expectedTask: gated.expectedTask, settlePermit: settlePermitOf(event) });
    });
  });

  async function dispatchSpecReview(
    task: TaskState,
    prior?: { findingsJson: string; responseJson?: string },
    opts: {
      bumpRound?: boolean;
      expectedTask?: TaskGenerationGuard;
      onSideEffect?: () => void;
      settlePermit?: unknown;
    } = {},
  ): Promise<boolean> {
    const dev = manager.getAgentConfig(task.agentId);
    if (!dev) {
      const kind = task.status === 'fixing' ? 'spec-fixed' : 'spec-done';
      return holdConsumedSignal(
        task,
        task.agentId,
        kind,
        'fix-no-dev-agent',
        'server-spec-review-no-dev-agent',
        {},
        opts.onSideEffect,
      );
    }
    const cap = manager.getConfig().review.rounds + (task.maxRoundsContinues ?? 0);
    const currentRound = task.specReviewRound ?? 0;
    const nextRound = opts.bumpRound === false ? currentRound : currentRound + 1;
    if (nextRound > cap) {
      const capResult = await manager.transitionTaskStatus(task.id, 'max_rounds', {
        fromStatus: ['in_progress', 'fixing'],
        ...(opts.expectedTask !== undefined ? { expectTask: opts.expectedTask } : {}),
      });
      if (!capResult) return false;
      opts.onSideEffect?.();
      const paused = capResult.task;
      if (paused.qaAgentId) await releaseAtCap(paused, paused.qaAgentId, 'qaAgentId');
      if (paused.agentId) await releaseAtCap(paused, paused.agentId, 'agentId');
      return false;
    }
    let content: ReadContentResult;
    if (opts.bumpRound === false) {
      const stored = await reviewStore.getRound(task.id, 'spec', nextRound);
      if (!stored || stored.phase !== 'spec') {
        throw new Error(`Task ${task.id} has no persisted spec review round ${nextRound} to redispatch`);
      }
      content = { content: stored.content, documents: stored.documents };
    } else {
      await manager.refreshWorkdirCacheFor(task.agentId);
      try {
        content = await transport().readContent(task, dev, 'spec');
      } catch (err) {
        const kind = task.status === 'fixing' ? 'spec-fixed' : 'spec-done';
        return holdConsumedSignal(
          task,
          task.agentId,
          kind,
          'handler-failed',
          'server-spec-content-read-failed',
          { error: err instanceof Error ? err.message : String(err) },
          opts.onSideEffect,
        );
      }
      try {
        if (!content.documents) throw new Error('spec transport returned no documents');
        const roundData: ReviewRound = {
          round: nextRound,
          phase: 'spec',
          content: content.content,
          documents: content.documents,
          startedAt: new Date().toISOString(),
        };
        const stored = opts.expectedTask
          ? await manager.putReviewRoundIfCurrent(task.id, roundData, opts.expectedTask)
          : (await reviewStore.putRound(task.id, 'spec', roundData), true);
        if (!stored) return false;
      } catch (err) {
        const kind = task.status === 'fixing' ? 'spec-fixed' : 'spec-done';
        return holdConsumedSignal(
          task,
          task.agentId,
          kind,
          'verdict-store-failed',
          'server-spec-round-store-failed',
          { error: err instanceof Error ? err.message : String(err) },
          opts.onSideEffect,
        );
      }
    }
    if (!resolveActiveQa(task)) {
      if (task.qaAgentId) {
        await emitIntervention(bus, task, {
          phase: 'server-spec-qa-unavailable',
          qaAgentId: task.qaAgentId,
        });
      }
      if (specApprovalIsHuman(task) || task.qaAgentId) {
        const parked = await manager.parkTaskAtSpecReady(task.id, {
          specReviewRound: nextRound,
          ...(opts.expectedTask !== undefined ? { expectedTask: opts.expectedTask } : {}),
        });
        if (parked) opts.onSideEffect?.();
        if (!parked) {
          await holdConsumedSignal(
            task,
            task.agentId,
            task.status === 'fixing' ? 'spec-fixed' : 'spec-done',
            'handler-failed',
            'server-spec-park-transition-failed',
            {},
            opts.onSideEffect,
          );
        }
        return !!parked;
      }
      return autoApproveSpec(task, opts.expectedTask, opts.onSideEffect);
    }
    const dispatched = await manager.dispatchServerReviewToQa(task.id, {
      phase: 'spec',
      ...(opts.bumpRound !== undefined ? { bumpRound: opts.bumpRound } : {}),
      content: content.content,
      ...(prior ? { priorFindingsJson: prior.findingsJson } : {}),
      ...(prior?.responseJson ? { priorResponseJson: prior.responseJson } : {}),
      callerOwnsConsumedSignalFailure: true,
      ...(opts.settlePermit !== undefined ? { settlePermit: opts.settlePermit } : {}),
      ...(opts.expectedTask !== undefined ? { expectedTask: opts.expectedTask } : {}),
      ...(opts.onSideEffect !== undefined ? { onSideEffect: opts.onSideEffect } : {}),
    });
    if (dispatched) return true;
    return holdConsumedSignal(
      task,
      task.agentId,
      task.status === 'fixing' ? 'spec-fixed' : 'spec-done',
      'handler-failed',
      'server-spec-review-dispatch-failed',
      {},
      opts.onSideEffect,
    );
  }

  bus.on('server.spec.review.submitted', async (event) => {
    const gated = await gate(bus, manager, event, { status: 'review', phase: 'spec', requireServerMode: false });
    if (!gated) return;
    const { task, expectedTask } = gated;
    await runConsumedSignal(task, task.qaAgentId ?? task.agentId, 'spec-reviewed', async () => {
      const qa = manager.getAgentConfig(task.qaAgentId ?? '');
      if (!qa) {
        await holdConsumedSignal(
          task,
          task.qaAgentId ?? '',
          'spec-reviewed',
          'handler-failed',
          'server-spec-review-no-qa-agent',
        );
        return;
      }
      const round = task.specReviewRound ?? 1;
      const roundData = await reviewStore.getRound(task.id, 'spec', round);
      if (!roundData) {
        await holdConsumedSignal(
          task,
          qa.id,
          'spec-reviewed',
          'handler-failed',
          'server-spec-review-round-missing',
          { round },
        );
        return;
      }
      await manager.refreshWorkdirCacheFor(qa.id);
      let findings: ReviewFindings | null;
      try {
        findings = await transport().readFindings(task, qa);
      } catch (err) {
        await holdConsumedSignal(
          task,
          qa.id,
          'spec-reviewed',
          'handler-failed',
          'server-spec-findings-invalid',
          { error: err instanceof Error ? err.message : String(err) },
        );
        return;
      }
      let effective = findings;
      if (effective === null) {
        if (roundData.findings === undefined) {
          await holdConsumedSignal(
            task,
            qa.id,
            'spec-reviewed',
            'handler-failed',
            'server-spec-findings-missing',
            { round },
          );
          return;
        }
        effective = roundData.findings;
      } else if (effective.round !== round) {
        await holdConsumedSignal(
          task,
          qa.id,
          'spec-reviewed',
          'handler-failed',
          'server-spec-findings-round-mismatch',
          { round, payloadRound: effective.round },
        );
        return;
      } else {
        const stored = await putVerdictRound(task, qa.id, 'spec-reviewed', {
          ...roundData,
          findings: effective,
          completedAt: new Date().toISOString(),
        }, { expectedTask });
        if (!stored) return;
        if (!(await deleteFindingsOrHold(task, qa, 'spec-reviewed', expectedTask))) return;
      }

      if (effective.verdict === 'approve') {
        await advanceApprovedSpec(task, 'server-spec-approve-transition-failed', expectedTask);
        return;
      }
      const cap = manager.getConfig().review.rounds + (task.maxRoundsContinues ?? 0);
      if ((task.specReviewRound ?? 0) >= cap) {
        const capResult = await manager.transitionTaskStatus(task.id, 'max_rounds', {
          fromStatus: ['review'],
          expectTask: expectedTask,
        });
        if (!capResult) return;
        const paused = capResult.task;
        if (paused.qaAgentId) await releaseAtCap(paused, paused.qaAgentId, 'qaAgentId');
        if (paused.agentId) await releaseAtCap(paused, paused.agentId, 'agentId');
        return;
      }
      const dispatched = await manager.dispatchServerFixToDev(
        task.id,
        JSON.stringify(effective),
        { callerOwnsConsumedSignalFailure: true, expectedTask },
      );
      if (!dispatched) {
        await holdConsumedSignal(
          task,
          task.qaAgentId ?? task.agentId,
          'spec-reviewed',
          'handler-failed',
          'server-spec-fix-dispatch-failed',
        );
      }
    });
  });

  async function runSpecFixSubmission(
    task: TaskState,
    opts: HandlerDispatchOptions = {},
  ): Promise<boolean> {
    const dev = manager.getAgentConfig(task.agentId);
    if (!dev) {
      return holdConsumedSignal(
        task,
        task.agentId,
        'spec-fixed',
        'fix-no-dev-agent',
        'server-spec-fix-no-dev-agent',
        {},
        opts.onSideEffect,
      );
    }
    const round = task.specReviewRound ?? 1;
    const roundData = await reviewStore.getRound(task.id, 'spec', round);
    if (!roundData?.findings) {
      return holdConsumedSignal(
        task,
        task.agentId,
        'spec-fixed',
        'fix-findings-missing',
        'server-spec-fix-findings-missing',
        { round },
        opts.onSideEffect,
      );
    }
    await manager.refreshWorkdirCacheFor(task.agentId);
    let readResult: ReviewResponseReadResult;
    try {
      readResult = await readResponseWithRetry(task, dev);
    } catch (err) {
      return holdConsumedSignal(
        task,
        dev.id,
        'spec-fixed',
        'response-read-failed',
        'server-spec-response-read-failed',
        {
          reason: err instanceof ReviewExchangeError ? err.reason : 'read-failed',
          error: err instanceof Error ? err.message : String(err),
        },
        opts.onSideEffect,
      );
    }
    if (readResult.kind === 'unknown') {
      return holdConsumedSignal(
        task,
        dev.id,
        'spec-fixed',
        'response-read-failed',
        'server-spec-response-read-failed',
        { reason: readResult.error.reason, error: readResult.error.message },
        opts.onSideEffect,
      );
    }
    if (readResult.kind === 'invalid') {
      return rejectServerResponse(task, dev, roundData as ReviewRound & { findings: ReviewFindings }, {
        reason: 'response-invalid',
        failurePhase: 'server-spec-response-invalid',
        rawResponse: readResult.raw,
        responseDigest: readResult.responseDigest,
        schemaViolationCodes: readResult.schemaViolationCodes,
        details: { error: readResult.error.message },
      }, opts.onSideEffect);
    }
    if (readResult.kind === 'absent') {
      if (roundData.response === undefined) {
        return rejectServerResponse(task, dev, roundData as ReviewRound & { findings: ReviewFindings }, {
          reason: 'response-missing',
          failurePhase: 'server-spec-response-missing',
        }, opts.onSideEffect);
      }
      return dispatchSpecReview(task, {
        findingsJson: JSON.stringify(roundData.findings),
        responseJson: JSON.stringify(roundData.response),
      }, opts);
    }
    const { response } = readResult;
    if (response.round !== round) {
      return rejectServerResponse(task, dev, roundData as ReviewRound & { findings: ReviewFindings }, {
        reason: 'round-mismatch',
        failurePhase: 'server-spec-response-round-mismatch',
        rawResponse: readResult.raw,
        responseDigest: readResult.responseDigest,
        details: { payloadRound: response.round },
      }, opts.onSideEffect);
    }
    if (response.token !== task.signalToken) {
      return rejectServerResponse(task, dev, roundData as ReviewRound & { findings: ReviewFindings }, {
        reason: 'token-mismatch',
        failurePhase: 'server-spec-response-token-mismatch',
        rawResponse: readResult.raw,
        responseDigest: readResult.responseDigest,
      }, opts.onSideEffect);
    }
    const findingsDigest = reviewFindingsDigest(roundData.findings);
    if (response.findingsDigest !== findingsDigest) {
      return rejectServerResponse(task, dev, roundData as ReviewRound & { findings: ReviewFindings }, {
        reason: 'findings-digest-mismatch',
        failurePhase: 'server-spec-response-findings-digest-mismatch',
        rawResponse: readResult.raw,
        responseDigest: readResult.responseDigest,
      }, opts.onSideEffect);
    }
    const gaps = coverageGaps(roundData.findings, new Set(response.responses.map(r => r.findingId)));
    if (gaps.missing.length > 0 || gaps.unknown.length > 0) {
      return rejectServerResponse(task, dev, roundData as ReviewRound & { findings: ReviewFindings }, {
        reason: 'coverage-gap',
        failurePhase: 'server-spec-response-coverage-gap',
        rawResponse: readResult.raw,
        responseDigest: readResult.responseDigest,
        missingFindingIds: gaps.missing,
        unknownFindingIds: gaps.unknown,
      }, opts.onSideEffect);
    }
    if (!(await putVerdictRound(
      task,
      dev.id,
      'spec-fixed',
      { ...roundData, response },
      opts,
    ))) return false;
    if (!(await deleteResponseOrHold(task, dev, 'spec-fixed', opts))) return false;
    return dispatchSpecReview(task, {
      findingsJson: JSON.stringify(roundData.findings),
      responseJson: JSON.stringify(response),
    }, opts);
  }

  bus.on('server.spec.fix.submitted', async (event) => {
    const gated = await gate(bus, manager, event, { status: 'fixing', phase: 'spec', requireServerMode: false });
    if (!gated) return;
    await runConsumedSignal(gated.task, gated.task.agentId, 'spec-fixed', async () => {
      await runSpecFixSubmission(gated.task, { expectedTask: gated.expectedTask, settlePermit: settlePermitOf(event) });
    });
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
    dispatchCodeReview: async (task, opts = {}) => {
      if (task.status === 'fixing') return runCodeFixSubmission(task, opts);
      const prior = await latestVerdictRound(task.id, 'code', task.reviewRound);
      return prepareAndDispatchCodeReview(task, {
        recheck: prior !== null,
        ...(opts.bumpRound !== undefined ? { bumpRound: opts.bumpRound } : {}),
        ...(opts.expectedTask !== undefined ? { expectedTask: opts.expectedTask } : {}),
        ...(opts.onSideEffect !== undefined ? { onSideEffect: opts.onSideEffect } : {}),
        ...(opts.settlePermit !== undefined ? { settlePermit: opts.settlePermit } : {}),
        ...(prior?.findings ? { priorFindingsJson: JSON.stringify(prior.findings) } : {}),
        ...(prior?.response ? { priorResponseJson: JSON.stringify(prior.response) } : {}),
      });
    },
    dispatchSpecReview: async (task, opts = {}) => {
      if (task.status === 'fixing') return runSpecFixSubmission(task, opts);
      const prior = await latestVerdictRound(task.id, 'spec', task.specReviewRound ?? 0);
      const priorContext = prior?.findings
        ? {
            findingsJson: JSON.stringify(prior.findings),
            ...(prior.response ? { responseJson: JSON.stringify(prior.response) } : {}),
          }
        : undefined;
      return dispatchSpecReview(task, priorContext, opts);
    },
  });
}
