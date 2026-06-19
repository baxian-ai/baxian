import { createSignalToken, type PhaseSignalKind } from '../agent/phase-signal.js';
import { BAXIAN_PR_CLAIM } from '../agent/prompt.js';
import { BRANCH_PREFIX, TASK_TERMINAL_STATUS_SET, isValidBranchName, type BaxianEvent, type TaskState } from '../shared/index.js';
import type { EventBus } from './bus.js';
import { type AgentManager, DispatchTerminalError, EnsureSessionError } from '../agent/manager.js';

type InterventionData = Record<string, unknown> & { phase: string };
const HEAD_SHA_RE = /^[0-9a-f]{40}$/i;

function validHeadSha(value: unknown): string | undefined {
  return typeof value === 'string' && HEAD_SHA_RE.test(value) ? value : undefined;
}

// Re-establish the develop-phase watcher after a handler-side rejection so the same
// task can consume a corrected emit (same token) without a server restart.
async function reArmDevelopWatcher(
  manager: AgentManager,
  task: TaskState,
  agentId: string,
  opts: { skipSnapshot?: boolean } = {},
): Promise<void> {
  const kinds: readonly PhaseSignalKind[] =
    task.phase === 'code' ? ['pr-created'] : ['spec-done', 'pr-created'];
  await manager.setupPhaseSignal(task.id, agentId, kinds, { skipSnapshot: opts.skipSnapshot ?? true });
}

async function emitIntervention(
  bus: EventBus,
  projectId: string,
  agentId: string,
  taskId: string,
  data: InterventionData,
): Promise<void> {
  try {
    const evt: BaxianEvent = {
      id: '',
      type: 'human.intervention',
      timestamp: new Date().toISOString(),
      projectId,
      agentId,
      taskId,
      data,
    };
    await bus.emit(evt);
  } catch (emitErr) {
    console.warn(`[EventHandler] human.intervention emit failed (phase=${data.phase}):`, emitErr);
  }
}

// Live `gh pr view` is the only authoritative source; fallbacks are tagged so
// audit logs reveal that staleness inference is best-effort.
type HeadAnchorSource = 'fetch' | 'task-store' | 'payload-self' | 'completion-approved' | 'unknown';
interface HeadAnchor {
  headSha: string | undefined;
  source: HeadAnchorSource;
  fetchError?: string;
}

async function resolveAuthoritativeHead(
  manager: AgentManager,
  task: TaskState,
  opts: {
    payloadCurrentHeadSha?: string;
    legacyFallback?: string;
  } = {},
): Promise<HeadAnchor> {
  try {
    const headSha = await manager.fetchPrHeadSha(task.id);
    return { headSha, source: 'fetch' };
  } catch (err) {
    const fetchError = err instanceof Error ? err.message : String(err);
    console.warn(
      `[handlers] fetchPrHeadSha(task=${task.id}) failed; falling back to stored / payload:`,
      err,
    );
    const stored = validHeadSha(task.latestHeadSha);
    if (stored) return { headSha: stored, source: 'task-store', fetchError };
    if (opts.payloadCurrentHeadSha) {
      return { headSha: opts.payloadCurrentHeadSha, source: 'payload-self', fetchError };
    }
    if (opts.legacyFallback) {
      return { headSha: opts.legacyFallback, source: 'completion-approved', fetchError };
    }
    return { headSha: undefined, source: 'unknown', fetchError };
  }
}

// pr-fixed verification needs a LIVE head (no stale fallback). GitHub has brief
// read-after-write lag + transient failures, so retry a few times, then throw so
// the handler fails closed instead of mis-reading a no-op.
async function fetchVerifiedHeadSha(manager: AgentManager, taskId: string): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await manager.fetchPrHeadSha(taskId);
    } catch (err) {
      lastErr = err;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// Budget = initial APPROVE dispatch + N redispatches; sized to converge a ~10-finding PR.
export const POST_APPROVE_REDISPATCH_CAP = 10;

// Clock-skew tolerance for the verdict freshness gate. GitHub `submitted_at` is
// second-granularity and its clock drifts from baxian's ms-precision
// `reviewDispatchedAt`; a false-reject is costly (poller cursor marks the review
// processed and won't retry → task strands), while real superseded passes are
// seconds-to-minutes stale, so a few seconds of slack is safe.
export const VERDICT_FRESHNESS_SKEW_MS = 5000;

async function dispatchDevPostApproveCheck(
  bus: EventBus,
  manager: AgentManager,
  task: TaskState,
  approvedHeadSha: string,
  opts: { redispatchCount?: number } = {},
): Promise<void> {
  if (!approvedHeadSha) {
    await emitIntervention(bus, task.projectId, task.agentId, task.id, {
      phase: 'post-approve-approved-head-unavailable',
    });
    return;
  }

  const acquired = await manager.acquireAgentForTask(task.agentId, task.id, 'post-approve');
  if (!acquired) {
    await emitIntervention(bus, task.projectId, task.agentId, task.id, {
      phase: 'post-approve-dev-acquire-failed',
      devAgentId: task.agentId,
    });
    return;
  }

  const signalToken = createSignalToken();
  await manager.setPostApproveCompletion(task.id, {
    token: signalToken,
    approvedHeadSha,
    ...(typeof opts.redispatchCount === 'number' ? { redispatchCount: opts.redispatchCount } : {}),
  });

  let resumed = false;
  let dispatchErr: unknown = null;
  try {
    resumed = await manager.continueSession(task.id, task.agentId, 'post-approve', {
      signalToken,
      ...(typeof opts.redispatchCount === 'number'
        ? { postApproveRedispatchCount: opts.redispatchCount }
        : {}),
    });
  } catch (err) {
    dispatchErr = err;
    console.error(
      `[EventHandler] APPROVE continueSession(dev=${task.agentId}, post-approve) failed:`,
      err,
    );
  }
  if (resumed) return;

  await manager.clearPostApproveCompletionIfMatches(task.id, signalToken);

  if (dispatchErr instanceof DispatchTerminalError) {
    await manager.failTaskForDispatchError(task.id, 'post-approve', task.agentId, dispatchErr);
    return;
  }

  await manager.markAgentWaiting(task.agentId, task.id)
    .catch(err => {
      console.error(
        `[EventHandler] APPROVE markAgentWaiting(dev=${task.agentId}) rollback failed:`,
        err,
      );
      return false;
    });
  await emitIntervention(bus, task.projectId, task.agentId, task.id, {
    phase: 'post-approve-dispatch-failed',
    reviewRound: task.reviewRound,
    ...(dispatchErr instanceof DispatchTerminalError ? { terminalReason: dispatchErr.reason } : {}),
    ...(dispatchErr ? { error: dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr) } : {}),
  });
}

async function isServerModeTask(manager: AgentManager, taskId: string): Promise<boolean> {
  const task = await manager.getTask(taskId);
  return task?.reviewMode === 'server';
}

async function gateDevForPostApproveRedispatch(
  bus: EventBus,
  manager: AgentManager,
  task: TaskState,
): Promise<boolean> {
  const ready = await manager
    .releaseAgentForTask(task.agentId, task.id, 'waiting')
    .catch(err => {
      console.error(
        `[EventHandler] post-approve redispatch releaseAgentForTask(dev=${task.agentId}) failed:`,
        err,
      );
      return false;
    });
  if (ready) return true;
  await emitIntervention(bus, task.projectId, task.agentId, task.id, {
    phase: 'post-approve-dev-wait-gate-failed-before-redispatch',
    devAgentId: task.agentId,
  });
  return false;
}

async function handlePrMergeReady(
  bus: EventBus,
  manager: AgentManager,
  event: BaxianEvent,
): Promise<void> {
  const taskId = event.taskId!;
  const taskNow = await manager.getTask(taskId);
  if (!taskNow) return;
  const eventPrNumber = event.data.prNumber as number | undefined;
  const eventPrUrl = event.data.prUrl as string | undefined;
  const needsPatch =
    (eventPrNumber !== undefined && eventPrNumber !== taskNow.prNumber)
    || (eventPrUrl !== undefined && eventPrUrl !== taskNow.prUrl);
  if (needsPatch) {
    await manager.updateTask(taskId, {
      ...(eventPrNumber !== undefined ? { prNumber: eventPrNumber } : {}),
      ...(eventPrUrl !== undefined ? { prUrl: eventPrUrl } : {}),
    });
  }
  const verdictAgentId = event.data.verdictAgentId as string | undefined;
  // PhaseSignalWatcher unified `data.token`; old PostApproveSignalWatcher used
  // `data.signalToken` — reading the wrong field strands approved tasks.
  const signalToken = event.data.token as string | undefined;
  const completion = await manager.getPostApproveCompletion(taskNow.id);
  if (
    taskNow.status !== 'approved'
    || verdictAgentId !== taskNow.agentId
    || !signalToken
    || completion?.token !== signalToken
  ) return;

  const ok = await manager.markAgentWaiting(taskNow.agentId, taskNow.id);
  if (!ok) {
    await emitIntervention(bus, taskNow.projectId, taskNow.agentId, taskNow.id, {
      phase: 'post-approve-dev-wait-gate-failed',
    });
    return;
  }

  const freshTask = await manager.getTask(taskNow.id);
  const freshCompletion = await manager.getPostApproveCompletion(taskNow.id);
  if (
    !freshTask
    || freshTask.status !== 'approved'
    || freshTask.agentId !== taskNow.agentId
    || freshCompletion?.token !== signalToken
  ) {
    await emitIntervention(bus, taskNow.projectId, taskNow.agentId, taskNow.id, {
      phase: 'post-approve-merge-skipped-stale-task',
    });
    return;
  }

  if (freshCompletion.pendingRedispatch) {
    const nextCount = (freshCompletion.redispatchCount ?? 0) + 1;
    if (nextCount > POST_APPROVE_REDISPATCH_CAP) {
      await manager.clearPostApproveCompletion(freshTask.id);
      await emitIntervention(bus, freshTask.projectId, freshTask.agentId, freshTask.id, {
        phase: 'post-approve-redispatch-cap-exceeded',
        redispatchCount: freshCompletion.redispatchCount ?? 0,
        cap: POST_APPROVE_REDISPATCH_CAP,
      });
      return;
    }
    await dispatchDevPostApproveCheck(
      bus,
      manager,
      freshTask,
      freshCompletion.approvedHeadSha,
      { redispatchCount: nextCount },
    );
    return;
  }

  // merge:'auto' decides what confirm executes; persist the approved head so
  // confirm's merge guard catches a push inside the gate window.
  const readied = await manager.transitionTaskStatus(
    freshTask.id,
    'merge-ready',
    { fromStatus: ['approved'] },
    { latestHeadSha: freshCompletion.approvedHeadSha },
  );
  if (readied) {
    await manager.clearPostApproveCompletionIfMatches(freshTask.id, signalToken);
  }
}

async function handlePrFeedback(
  bus: EventBus,
  manager: AgentManager,
  event: BaxianEvent,
): Promise<void> {
  const taskId = event.taskId!;
  const taskNow = await manager.getTask(taskId);
  if (!taskNow) return;
  const eventPrNumber = event.data.prNumber as number | undefined;
  const eventPrUrl = event.data.prUrl as string | undefined;
  const eventKind = event.data.kind as string | undefined;
  const prPatch: Partial<Pick<TaskState, 'prNumber' | 'prUrl'>> = {
    ...(eventPrNumber !== undefined ? { prNumber: eventPrNumber } : {}),
    ...(eventPrUrl !== undefined ? { prUrl: eventPrUrl } : {}),
  };
  const needsPatch =
    (eventPrNumber !== undefined && eventPrNumber !== taskNow.prNumber)
    || (eventPrUrl !== undefined && eventPrUrl !== taskNow.prUrl);
  if (needsPatch) {
    await manager.updateTask(taskId, prPatch);
  }
  if (taskNow.status !== 'approved') return;
  const isNewFeedback = eventKind === 'comment' || eventKind === 'review-comment';
  if (!isNewFeedback) return;

  const completion = await manager.getPostApproveCompletion(taskNow.id);
  if (!completion) {
    await emitIntervention(bus, taskNow.projectId, taskNow.agentId, taskNow.id, {
      phase: 'post-approve-approved-head-unavailable',
    });
    return;
  }
  // Don't Ctrl-C dev mid-pass on its own webhook echo — coalesce via pendingRedispatch.
  const devState = await manager.getAgentState(taskNow.agentId);
  if (devState?.taskId === taskNow.id) {
    if (!completion.pendingRedispatch) {
      await manager.setPostApproveCompletion(taskNow.id, {
        token: completion.token,
        approvedHeadSha: completion.approvedHeadSha,
        ...(typeof completion.redispatchCount === 'number'
          ? { redispatchCount: completion.redispatchCount } : {}),
        pendingRedispatch: true,
      });
    }
    return;
  }
  const nextCount = (completion.redispatchCount ?? 0) + 1;
  if (nextCount > POST_APPROVE_REDISPATCH_CAP) {
    await manager.clearPostApproveCompletion(taskNow.id);
    await emitIntervention(bus, taskNow.projectId, taskNow.agentId, taskNow.id, {
      phase: 'post-approve-redispatch-cap-exceeded',
      redispatchCount: completion.redispatchCount ?? 0,
      cap: POST_APPROVE_REDISPATCH_CAP,
    });
    return;
  }
  const ready = await gateDevForPostApproveRedispatch(bus, manager, taskNow);
  if (!ready) return;
  await dispatchDevPostApproveCheck(
    bus,
    manager,
    { ...taskNow, ...prPatch },
    completion.approvedHeadSha,
    { redispatchCount: nextCount },
  );
}

async function handlePrCodePush(
  bus: EventBus,
  manager: AgentManager,
  event: BaxianEvent,
): Promise<void> {
  const taskId = event.taskId!;
  const agentId = event.agentId!;
  const eventPrNumber = event.data.prNumber as number | undefined;
  const eventPrUrl = event.data.prUrl as string | undefined;
  const eventKind = event.data.kind as string | undefined;
  const eventHeadSha = validHeadSha(event.data.headSha);
  // Only `push` freshens `latestHeadSha` — legacy events (kind=undefined) use headSha
  // for the review anchor only, not for the staleness fallback cache.
  const prPatch: Partial<Pick<TaskState, 'prNumber' | 'prUrl' | 'latestHeadSha'>> = {
    ...(eventPrNumber !== undefined ? { prNumber: eventPrNumber } : {}),
    ...(eventPrUrl !== undefined ? { prUrl: eventPrUrl } : {}),
    ...(eventKind === 'push' && eventHeadSha ? { latestHeadSha: eventHeadSha } : {}),
  };

  const taskBeforeTransition = await manager.getTask(taskId);
  if (!taskBeforeTransition) return;
  const willHavePrNumber =
    taskBeforeTransition.prNumber !== undefined || eventPrNumber !== undefined;
  if (taskBeforeTransition.status === 'in_progress' && !willHavePrNumber) {
    console.warn(
      `[EventHandler] pr.updated: task ${taskId} in_progress but neither task nor event has prNumber; ` +
      `deferring catch-up`,
    );
    return;
  }

  // Anchor at dispatch time — must NOT shift if a subsequent push lands mid-review.
  const anchorAtDispatch = eventHeadSha ?? validHeadSha(taskBeforeTransition.latestHeadSha);
  const result = await manager.transitionTaskStatus(
    taskId,
    'review',
    { fromStatus: ['in_progress', 'fixing', 'review', 'approved', 'merge-ready'] },
    {
      ...prPatch,
      ...(anchorAtDispatch ? { reviewHeadAnchorSha: anchorAtDispatch } : {}),
      reviewDispatchedAt: new Date().toISOString(),
      // Rotate token atomically so an old QA's late verdict is rejected by the gate.
      signalToken: createSignalToken(),
    },
  );
  if (!result) return;
  const { task: transitioned, previousStatus } = result;
  const expectedRound = transitioned.reviewRound;
  await manager.clearPostApproveCompletion(transitioned.id);

  let devAlreadyWaiting = false;
  if (previousStatus === 'approved' || previousStatus === 'merge-ready') {
    devAlreadyWaiting = await manager
      .releaseAgentForTask(transitioned.agentId, transitioned.id, 'waiting')
      .catch(err => {
        console.error(
          `[EventHandler] pr.updated releaseAgentForTask(dev=${transitioned.agentId}) before approved→recheck failed:`,
          err,
        );
        return false;
      });
    if (!devAlreadyWaiting) {
      await emitIntervention(bus, transitioned.projectId, transitioned.agentId, transitioned.id, {
        phase: 'post-approve-dev-wait-gate-failed-before-recheck',
        devAgentId: transitioned.agentId,
      });
      return;
    }
  }

  if (previousStatus === 'review' && transitioned.qaAgentId) {
    const released = await manager
      .releaseAgentForTask(transitioned.qaAgentId, transitioned.id, 'idle')
      .catch(err => {
        console.error(
          `[EventHandler] pr.updated releaseAgentForTask(QA=${transitioned.qaAgentId}) for review→review push failed:`,
          err,
        );
        return false;
      });
    if (!released) {
      await emitIntervention(bus, transitioned.projectId, transitioned.agentId, transitioned.id, {
        phase: 'qa-release-failed-cannot-recheck',
        qaAgentId: transitioned.qaAgentId,
      });
      return;
    }
  }

  const qaPhase: 'review' | 'recheck' =
    previousStatus === 'fixing' || previousStatus === 'review'
    || previousStatus === 'approved' || previousStatus === 'merge-ready'
      ? 'recheck'
      : 'review';

  const qa = manager.findQaPartner(agentId);
  if (!qa) {
    if (!devAlreadyWaiting && !(await manager.markAgentWaiting(agentId, transitioned.id))) {
      await emitIntervention(bus, transitioned.projectId, transitioned.agentId, transitioned.id, {
        phase: 'dev-wait-gate-failed-no-qa',
      });
    }
    return;
  }

  const acquired = await manager.acquireAgentForTask(qa.id, transitioned.id, qaPhase);
  if (!acquired) {
    await emitIntervention(bus, transitioned.projectId, transitioned.agentId, transitioned.id, {
      phase: 'qa-acquire-failed',
      qaAgentId: qa.id,
      qaPhase,
    });
    return;
  }

  // Persist qaAgentId BEFORE setting up so a pane-fallback verdict's review.submitted
  // handler can read it for the release path.
  await manager.updateTask(transitioned.id, { qaAgentId: qa.id });

  const { armed } = await manager.rotateAndSetupPhaseSignal(
    transitioned.id,
    qa.id,
    ['pr-approved', 'pr-changes-requested'] as const,
  );
  if (!armed) {
    console.warn(
      `[EventHandler] pr.updated verdict watcher failed to arm for task=${transitioned.id} (${qaPhase}); rolling back recheck dispatch`,
    );
    if (previousStatus === 'in_progress' || previousStatus === 'fixing') {
      // Full rollback: restore status+token+anchor and re-arm so the dev's already-emitted
      // signal isn't stranded by the token rotation.
      await manager.rollbackVerdictArmFailure(transitioned.id, {
        status: previousStatus,
        signalToken: taskBeforeTransition.signalToken,
        reviewHeadAnchorSha: taskBeforeTransition.reviewHeadAnchorSha,
        reviewDispatchedAt: taskBeforeTransition.reviewDispatchedAt,
      });
    } else {
      // approved/review: don't restore status (approved with cleared completion is unsafe;
      // review was already current). Leave in review for operator follow-up.
      await manager.updateTask(transitioned.id, { qaAgentId: undefined });
    }
    await manager.releaseAgentForTask(qa.id, transitioned.id, 'idle').catch(err => {
      console.error(`[EventHandler] pr.updated releaseAgentForTask(QA=${qa.id}) after arm-failure rollback failed:`, err);
      return false;
    });
    await emitIntervention(bus, transitioned.projectId, transitioned.agentId, transitioned.id, {
      phase: previousStatus === 'approved' || previousStatus === 'merge-ready' ? 'qa-recheck-arm-failed-after-approved-push' : 'qa-recheck-arm-failed',
      qaAgentId: qa.id,
      qaPhase,
    });
    return;
  }
  let started = false;
  let dispatchErr: unknown = null;
  try {
    started = await manager.startSession(transitioned.id, qa.id, qaPhase);
  } catch (err) {
    dispatchErr = err;
    console.error(
      `[EventHandler] pr.updated startSession(QA=${qa.id}, ${qaPhase}) hard error:`,
      err,
    );
  }
  if (!started) {
    console.warn(
      `[EventHandler] pr.updated QA ${qaPhase} not started; previousStatus=${previousStatus}`,
    );
    if (dispatchErr instanceof DispatchTerminalError) {
      await manager.failTaskForDispatchError(transitioned.id, qaPhase, qa.id, dispatchErr);
    } else if (dispatchErr instanceof EnsureSessionError && dispatchErr.partial.handled) {
      // handleDialogPendingFromRuntime already marked QA Held + fail task + release partners
    } else {
      await manager.updateTask(transitioned.id, { qaAgentId: undefined });
      await manager.releaseAgentForTask(qa.id, transitioned.id, 'idle')
        .catch(err => {
          console.error(
            `[EventHandler] pr.updated releaseAgentForTask(QA=${qa.id}) after start-not-true failed:`,
            err,
          );
          return false;
        });
      if (previousStatus === 'approved' || previousStatus === 'merge-ready') {
        await emitIntervention(bus, transitioned.projectId, transitioned.agentId, transitioned.id, {
          phase: 'qa-recheck-failed-after-approved-push',
          qaAgentId: qa.id,
        });
      } else if (previousStatus !== 'review') {
        await manager.transitionTaskStatus(transitioned.id, previousStatus, { fromStatus: ['review'] });
      } else {
        await emitIntervention(bus, transitioned.projectId, transitioned.agentId, transitioned.id, {
          phase: 'qa-recheck-failed-after-stop',
          qaAgentId: qa.id,
        });
      }
    }
    return;
  }

  // Bump round for first review / approved re-review only; fixing/review→review recheck
  // of the in-flight pass must NOT bump.
  if (previousStatus === 'in_progress' || previousStatus === 'approved' || previousStatus === 'merge-ready') {
    await manager.bumpReviewRoundIfStillAt(transitioned.id, expectedRound);
  }

  const ok = devAlreadyWaiting || (await manager.markAgentWaiting(agentId, transitioned.id));
  if (!ok) {
    await manager.markAwaitingHuman(
      qa.id,
      'dev-wait-gate-failed-after-qa-started',
      `QA review for task ${transitioned.id} started but dev wait-gate failed; QA prompt may still be running, needs operator decision.`,
      { expectedTaskId: transitioned.id },
    ).catch(err => {
      console.error(
        `[EventHandler] pr.updated markAwaitingHuman(QA=${qa.id}) after dev-wait-gate-fail:`,
        err,
      );
    });
  }
}

async function handleReviewApproval(
  bus: EventBus,
  manager: AgentManager,
  task: TaskState,
  reviewedHeadSha: string | undefined,
  currentHeadSha: string | undefined,
  prPatch: Partial<Pick<TaskState, 'prNumber' | 'prUrl'>>,
): Promise<void> {
  if (!reviewedHeadSha) {
    await emitIntervention(bus, task.projectId, task.agentId, task.id, {
      phase: 'approval-reviewed-head-unavailable',
    });
    return;
  }

  const anchor = await resolveAuthoritativeHead(manager, task, {
    payloadCurrentHeadSha: currentHeadSha,
  });
  if (anchor.source === 'fetch' && anchor.headSha && task.latestHeadSha !== anchor.headSha) {
    await manager.updateTask(task.id, { latestHeadSha: anchor.headSha });
  }
  if (anchor.headSha && reviewedHeadSha !== anchor.headSha) {
    await emitIntervention(bus, task.projectId, task.agentId, task.id, {
      phase: 'stale-approval-head-mismatch',
      reviewedHeadSha,
      currentHeadSha: anchor.headSha,
      source: anchor.source,
      ...(anchor.fetchError ? { fetchError: anchor.fetchError } : {}),
    });
    return;
  }

  const result = await manager.transitionTaskStatus(
    task.id,
    'approved',
    { fromStatus: ['review'] },
    // reviewRound 0 = first pass entered via catch-up (deferred bump). Count it now.
    task.reviewRound === 0 ? { ...prPatch, reviewRound: 1 } : prPatch,
  );
  if (!result) return;
  const { task: transitioned } = result;

  // Verdict consumed → tear down the fallback verdict watcher (poller path leaves
  // it set-up-but-unfired; pane path already removed its entry — this is a no-op).
  manager.stopPhaseSignalWatcher(transitioned.id);

  if (transitioned.qaAgentId) {
    await manager.releaseAgentForTask(transitioned.qaAgentId, transitioned.id, 'idle', { allowAwaitingHuman: true })
      .catch(err =>
        console.error(
          `[EventHandler] APPROVE releaseAgentForTask(QA=${transitioned.qaAgentId}) failed:`,
          err,
        ),
      );
  }

  await dispatchDevPostApproveCheck(bus, manager, transitioned, reviewedHeadSha);
}

async function handleReviewRequestChanges(
  bus: EventBus,
  manager: AgentManager,
  task: TaskState,
  reviewedHeadSha: string | undefined,
  currentHeadSha: string | undefined,
  prPatch: Partial<Pick<TaskState, 'prNumber' | 'prUrl'>>,
): Promise<void> {
  const approvedCompletion = task.status === 'approved'
    ? await manager.getPostApproveCompletion(task.id)
    : null;
  const anchor = await resolveAuthoritativeHead(manager, task, {
    payloadCurrentHeadSha: currentHeadSha,
    legacyFallback: approvedCompletion?.approvedHeadSha,
  });
  if (anchor.source === 'fetch' && anchor.headSha && task.latestHeadSha !== anchor.headSha) {
    await manager.updateTask(task.id, { latestHeadSha: anchor.headSha });
  }
  if (reviewedHeadSha && anchor.headSha && reviewedHeadSha !== anchor.headSha) {
    await emitIntervention(bus, task.projectId, task.agentId, task.id, {
      phase: 'stale-request-changes-head-mismatch',
      reviewedHeadSha,
      currentHeadSha: anchor.headSha,
      source: anchor.source,
      ...(anchor.fetchError ? { fetchError: anchor.fetchError } : {}),
    });
    return;
  }

  const reviewedRound = task.reviewRound === 0 ? 1 : task.reviewRound;
  const nextRound = reviewedRound + 1;
  if (task.status === 'approved' && nextRound <= manager.getConfig().review.rounds) {
    // Post-approve check may still be running — clearing completion blocks auto-merge;
    // fix dispatch deferred to avoid prompt collision with the in-flight check.
    const devState = await manager.getAgentState(task.agentId);
    const postApproveActive = await manager.getPostApproveCompletion(task.id);
    if (devState?.taskId === task.id && postApproveActive) {
      await manager.clearPostApproveCompletion(task.id);
      await emitIntervention(bus, task.projectId, task.agentId, task.id, {
        phase: 'request-changes-during-post-approve',
        devAgentId: task.agentId,
        note: 'Dev is still running post-approve check; fix dispatch deferred to avoid prompt collision. PostApproveCompletion cleared to block auto-merge. Operator: wait for post-approve signal to complete, then re-trigger REQUEST_CHANGES manually or cancel the task.',
      });
      return;
    }
    const ready = await manager
      .releaseAgentForTask(task.agentId, task.id, 'waiting')
      .catch(err => {
        console.error(
          `[EventHandler] REQUEST_CHANGES releaseAgentForTask(dev=${task.agentId}) before fix failed:`,
          err,
        );
        return false;
      });
    if (!ready) {
      await emitIntervention(bus, task.projectId, task.agentId, task.id, {
        phase: 'post-approve-dev-wait-gate-failed-before-fix',
        devAgentId: task.agentId,
      });
      return;
    }
  }

  if (nextRound > manager.getConfig().review.rounds) {
    return handleMaxRounds(bus, manager, task, prPatch, reviewedRound);
  }

  const result = await manager.transitionTaskStatus(
    task.id,
    'fixing',
    { fromStatus: ['review', 'approved', 'merge-ready'] },
    { ...prPatch, reviewRound: nextRound, fixDispatchedAt: new Date().toISOString() },
  );
  if (!result) return;
  const { task: transitioned, previousStatus } = result;
  await manager.clearPostApproveCompletion(transitioned.id);
  manager.stopPhaseSignalWatcher(transitioned.id);

  if (previousStatus === 'review' && transitioned.qaAgentId) {
    const qaReleased = await manager
      .releaseAgentForTask(transitioned.qaAgentId, transitioned.id, 'idle', { allowAwaitingHuman: true })
      .catch(err => {
        console.error(
          `[EventHandler] REQUEST_CHANGES releaseAgentForTask(QA=${transitioned.qaAgentId}) failed:`,
          err,
        );
        return false;
      });
    if (!qaReleased) {
      await emitIntervention(bus, transitioned.projectId, transitioned.agentId, transitioned.id, {
        phase: 'qa-release-failed-but-dev-dispatched',
        qaAgentId: transitioned.qaAgentId,
      });
    }
  }

  const acquired = await manager.acquireAgentForTask(transitioned.agentId, transitioned.id, 'fix');
  if (!acquired) {
    await emitIntervention(bus, transitioned.projectId, transitioned.agentId, transitioned.id, {
      phase: 'dev-acquire-failed-fix',
      devAgentId: transitioned.agentId,
    });
    return;
  }

  const { armed } = await manager.rotateAndSetupPhaseSignal(transitioned.id, transitioned.agentId, 'pr-fixed');

  if (!armed) {
    console.warn(
      `[EventHandler] REQUEST_CHANGES pr-fixed watcher failed to arm for task=${transitioned.id}; holding dev (not dispatching fix)`,
    );
    await manager.markAwaitingHuman(
      transitioned.agentId,
      'signal-arm-failed:pr-fixed',
      'pr-fixed watcher failed to arm; the fix was not dispatched (its completion signal would have no consumer). Cancel the task or delete the agent to retry.',
      { expectedTaskId: transitioned.id },
    );
    return;
  }

  let resumed = false;
  let dispatchErr: unknown = null;
  try {
    resumed = await manager.continueSession(transitioned.id, transitioned.agentId, 'fix');
  } catch (err) {
    dispatchErr = err;
    console.error(
      `[EventHandler] REQUEST_CHANGES continueSession(dev=${transitioned.agentId}, fix) failed:`,
      err,
    );
  }
  if (!resumed) {
    console.warn(
      `[EventHandler] REQUEST_CHANGES dev=${transitioned.agentId} not resumable for task=${transitioned.id}; ` +
      `task remains in 'fixing' but no dev session is attached`,
    );
    if (dispatchErr instanceof DispatchTerminalError) {
      await manager.failTaskForDispatchError(
        transitioned.id, 'fix', transitioned.agentId, dispatchErr,
      );
    } else {
      await manager.markAgentWaiting(transitioned.agentId, transitioned.id)
        .catch(err => {
          console.error(
            `[EventHandler] REQUEST_CHANGES markAgentWaiting(dev=${transitioned.agentId}) rollback failed:`,
            err,
          );
          return false;
        });
      await emitIntervention(bus, transitioned.projectId, transitioned.agentId, transitioned.id, {
        phase: 'fix-resume-failed',
        reviewRound: transitioned.reviewRound,
      });
    }
  }
}

async function handleMaxRounds(
  bus: EventBus,
  manager: AgentManager,
  task: TaskState,
  prPatch: Partial<Pick<TaskState, 'prNumber' | 'prUrl'>>,
  reviewedRound: number,
): Promise<void> {
  const result = await manager.transitionTaskStatus(
    task.id,
    'max_rounds',
    { fromStatus: ['review', 'approved', 'merge-ready'] },
    { ...prPatch, reviewRound: reviewedRound },
  );
  if (!result) return;
  const { task: transitioned } = result;
  await manager.clearPostApproveCompletion(transitioned.id);
  manager.stopPhaseSignalWatcher(transitioned.id);

  if (transitioned.qaAgentId) {
    const qaState = await manager.getAgentState(transitioned.qaAgentId);
    if (qaState?.taskId === transitioned.id) {
      const qaReleased = await manager
        .releaseAgentForTask(transitioned.qaAgentId, transitioned.id, 'idle', { allowAwaitingHuman: true })
        .catch(err => {
          console.error(
            `[EventHandler] max_rounds releaseAgentForTask(QA=${transitioned.qaAgentId}) failed:`,
            err,
          );
          return false;
        });
      if (qaReleased) {
        await manager.updateTask(transitioned.id, { qaAgentId: undefined })
          .catch(err =>
            console.error(`[EventHandler] max_rounds clear qaAgentId(${transitioned.id}) failed:`, err),
          );
      }
    } else {
      await manager.updateTask(transitioned.id, { qaAgentId: undefined })
        .catch(err =>
          console.error(`[EventHandler] max_rounds clear stale qaAgentId(${transitioned.id}) failed:`, err),
        );
    }
  }

  try {
    await bus.emit({
      id: '',
      type: 'review.max_rounds',
      timestamp: new Date().toISOString(),
      projectId: transitioned.projectId,
      agentId: transitioned.agentId,
      taskId: transitioned.id,
      data: { reviewRound: transitioned.reviewRound },
    });
  } catch (emitErr) {
    console.warn(`[EventHandler] max_rounds emit failed:`, emitErr);
  }
}

export function registerEventHandlers(
  bus: EventBus,
  manager: AgentManager,
): void {
  bus.on('pr.created', async (event) => {
    if (!event.taskId || !event.agentId) return;
    if (await isServerModeTask(manager, event.taskId)) return;

    // pane-signal pr.created carries data.prNumber (extracted from the agent's
    // [bx:pr-created:<num>:<token>] signal) but no prUrl / headSha. The
    // transition only needs prNumber to wire task→PR; prUrl is derivable from
    // repo+number; headSha lands via the next pr.updated push event.
    //
    // spec phase 由 server 评审链（server.spec.* handlers）驱动；poller 不应越过它派 QA review，
    // 否则 QA 在 spec-review 槽位上跑 pr-review 流程，gh pr review --approve 会误触 post-approve。
    {
      const taskNow = await manager.getTask(event.taskId);
      if (taskNow?.phase === 'spec') {
        console.warn(
          `[EventHandler] pr.created ignored for task ${event.taskId}: task in spec phase`,
        );
        return;
      }
    }

    let paneVerifiedHeadSha: string | undefined;
    let reconciledBranch: string | undefined;
    if (event.data.source === 'pane-signal' && event.data.prNumber !== undefined) {
      try {
        const prNumber = event.data.prNumber as number;
        let verified = await manager.verifyPaneSignalPrNumber(event.taskId, prNumber);
        if (!verified) {
          const taskNow = await manager.getTask(event.taskId);
          if (taskNow) {
            const prInfo = await manager.fetchPrHeadRef(prNumber, taskNow.projectId);
            if (prInfo) {
              const ownPrefix = BRANCH_PREFIX + event.taskId;
              const isForeignBxBranch = prInfo.headRefName.startsWith(BRANCH_PREFIX)
                && prInfo.headRefName !== ownPrefix;
              const bound = await manager.findTaskByBranch(prInfo.headRefName, taskNow.projectId);
              const hasClaimMarker = prInfo.body.includes(BAXIAN_PR_CLAIM);
              if (!isForeignBxBranch && hasClaimMarker && isValidBranchName(prInfo.headRefName)
                && (!bound || bound.id === taskNow.id)) {
                reconciledBranch = prInfo.headRefName;
                verified = prInfo;
              }
            }
          }
        }
        if (!verified) {
          const taskNow = await manager.getTask(event.taskId);
          console.warn(
            `[EventHandler] pr.created REJECT pane prNumber=${event.data.prNumber} for task ${event.taskId} ` +
            `(branch mismatch: task.branch=${taskNow?.branch})`,
          );
          if (taskNow) {
            await reArmDevelopWatcher(manager, taskNow, event.agentId);
            await emitIntervention(bus, taskNow.projectId, event.agentId, event.taskId, {
              phase: 'pane-pr-created-branch-mismatch',
              claimedPrNumber: event.data.prNumber as number,
              taskBranch: taskNow.branch ?? '',
            });
          }
          return;
        }
        paneVerifiedHeadSha = verified.headSha;
      } catch (err) {
        console.warn(
          `[EventHandler] pr.created: verifyPaneSignalPrNumber failed for task ${event.taskId}:`,
          err,
        );
        const taskNow = await manager.getTask(event.taskId);
        if (taskNow) {
          await reArmDevelopWatcher(manager, taskNow, event.agentId, { skipSnapshot: false });
          await emitIntervention(bus, taskNow.projectId, event.agentId, event.taskId, {
            phase: 'pane-pr-created-verify-error',
            claimedPrNumber: event.data.prNumber as number,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
    }

    const createdHeadSha = validHeadSha(event.data.headSha) ?? paneVerifiedHeadSha;
    // Snapshot pre-transition fields so an arm failure can be rolled back atomically (restore
    // status/token/anchor instead of stranding the task in review with no QA — see armed gate below).
    const taskBeforeTransition = await manager.getTask(event.taskId);
    const result = await manager.transitionTaskStatus(
      event.taskId,
      'review',
      { fromStatus: ['in_progress', 'fixing'] },
      {
        ...(event.data.prNumber !== undefined ? { prNumber: event.data.prNumber as number } : {}),
        ...(event.data.prUrl !== undefined ? { prUrl: event.data.prUrl as string } : {}),
        ...(createdHeadSha ? { latestHeadSha: createdHeadSha, reviewHeadAnchorSha: createdHeadSha } : {}),
        ...(reconciledBranch ? { branch: reconciledBranch } : {}),
        reviewDispatchedAt: new Date().toISOString(),
        signalToken: createSignalToken(),
      },
    );
    if (!result) {
      console.warn(
        `[EventHandler] pr.created: cannot transition task ${event.taskId} (terminal or invalid from-state)`,
      );
      if (event.data.source === 'pane-signal') {
        const taskNow = await manager.getTask(event.taskId);
        if (taskNow && ['in_progress', 'fixing'].includes(taskNow.status)) {
          await reArmDevelopWatcher(manager, taskNow, event.agentId);
          await emitIntervention(bus, taskNow.projectId, event.agentId, event.taskId, {
            phase: 'pane-pr-created-transition-failed',
            claimedPrNumber: event.data.prNumber as number,
            taskBranch: taskNow.branch ?? '',
          });
        }
      }
      return;
    }
    const { task: transitioned, previousStatus } = result;
    if (reconciledBranch) {
      console.log(
        `[EventHandler] pr.created reconciled branch for task ${event.taskId}: ` +
        `${taskBeforeTransition?.branch} → ${reconciledBranch}`,
      );
    }
    // Round captured before any verdict can land (watcher armed only after this) — the
    // count-once token for bumpReviewRoundIfStillAt on the dispatch success path.
    const expectedRound = transitioned.reviewRound;

    const qa = manager.findQaPartner(event.agentId);
    if (!qa) {
      const ok = await manager.markAgentWaiting(event.agentId, transitioned.id);
      if (!ok) {
        await emitIntervention(bus, transitioned.projectId, transitioned.agentId, transitioned.id, {
          phase: 'dev-wait-gate-failed-no-qa',
        });
      }
      return;
    }

    // Acquire before startSession so the lock window covers the task binding write.
    const acquired = await manager.acquireAgentForTask(qa.id, transitioned.id, 'review');
    if (!acquired) {
      await emitIntervention(bus, transitioned.projectId, transitioned.agentId, transitioned.id, {
        phase: 'qa-acquire-failed',
        qaAgentId: qa.id,
      });
      return;
    }

    // Persist qaAgentId BEFORE setting up so a pane-fallback verdict's review.submitted
    // handler can read task.qaAgentId for the release path.
    await manager.updateTask(transitioned.id, { qaAgentId: qa.id });

    // Poller is authoritative for the verdict (native `gh pr review` state, with
    // commit_id + submitted_at). Set up the verdict watcher as a FALLBACK: when dev
    // and qa share a GitHub identity, `gh pr review` is rejected (422 — can't
    // review your own PR) and leaves no GitHub state to poll, so QA echoes the
    // verdict as a pane signal instead. A distinct-identity task never fires this
    // watcher; the review.submitted handler tears it down when the poller verdict lands.
    const { armed } = await manager.rotateAndSetupPhaseSignal(
      transitioned.id,
      qa.id,
      ['pr-approved', 'pr-changes-requested'] as const,
    );
    if (!armed) {
      // Verdict watcher didn't arm. For a same-identity task the poller can't supply a verdict
      // (422), so dispatching now would deadlock with no consumer. Atomically restore the
      // pre-transition state (status/token/anchor) + re-arm the develop watcher so the dev's
      // already-emitted pr-created is re-consumed (self-heal), then release QA + intervention.
      console.warn(
        `[EventHandler] pr.created verdict watcher failed to arm for task=${transitioned.id}; rolling back review dispatch`,
      );
      await manager.rollbackVerdictArmFailure(transitioned.id, {
        status: previousStatus,
        signalToken: taskBeforeTransition?.signalToken,
        reviewHeadAnchorSha: taskBeforeTransition?.reviewHeadAnchorSha,
        reviewDispatchedAt: taskBeforeTransition?.reviewDispatchedAt,
      });
      await manager.releaseAgentForTask(qa.id, transitioned.id, 'idle').catch(err => {
        console.error(`[EventHandler] pr.created releaseAgentForTask(QA=${qa.id}) after arm-failure rollback failed:`, err);
        return false;
      });
      await emitIntervention(bus, transitioned.projectId, transitioned.agentId, transitioned.id, {
        phase: 'qa-review-arm-failed',
        qaAgentId: qa.id,
      });
      return;
    }
    let started = false;
    let dispatchErr: unknown = null;
    try {
      started = await manager.startSession(transitioned.id, qa.id, 'review');
    } catch (err) {
      dispatchErr = err;
      console.error(`[EventHandler] pr.created startSession(QA=${qa.id}) hard error:`, err);
    }
    if (!started) {
      console.warn(
        `[EventHandler] pr.created QA session not started for task=${transitioned.id}; ` +
        `task stays in 'review' but no active QA — emitting human.intervention`,
      );
      if (dispatchErr instanceof DispatchTerminalError) {
        await manager.failTaskForDispatchError(transitioned.id, 'review', qa.id, dispatchErr);
      } else if (dispatchErr instanceof EnsureSessionError && dispatchErr.partial.handled) {
        // handleDialogPendingFromRuntime 已标 QA Held + fail task + release partners；这里
        // 再调 release 会因 boundTask terminal 让 shouldReleaseHeldBinding 放行 → 解锁仍卡 dialog 的 pane。
      } else {
        // Rollback the pre-set up qaAgentId so the task doesn't keep a binding to a QA we never started.
        await manager.updateTask(transitioned.id, { qaAgentId: undefined });
        await manager.releaseAgentForTask(qa.id, transitioned.id, 'idle')
          .catch(err => {
            console.error(
              `[EventHandler] pr.created releaseAgentForTask(QA=${qa.id}) after start-not-true failed:`,
              err,
            );
            return false;
          });
        await emitIntervention(bus, transitioned.projectId, transitioned.agentId, transitioned.id, {
          phase: 'qa-review-start-failed',
          qaAgentId: qa.id,
        });
      }
      return;
    }

    // QA review pass started → count it (1-based Round). Bump on the success path only,
    // so a no-QA / acquire / startSession failure above never inflates the round. The
    // count-once token no-ops if a same-identity verdict already counted this pass.
    if (previousStatus === 'in_progress') {
      await manager.bumpReviewRoundIfStillAt(transitioned.id, expectedRound);
    }

    const ok = await manager.markAgentWaiting(event.agentId, transitioned.id);
    if (!ok) {
      // QA review prompt 已粘进 pane 在跑；裸 release 让下一 review 派来同一 pane 会污染 outcome。
      // 标 awaiting_human 让 operator 决定如何收尾（取消该 task 走 cancelTask，或等 QA 跑完再 Resume）。
      // expectedTaskId: 防止迟到的 mark 撞 outcome 已被接受 + QA release+reassign 后的新 binding。
      await manager.markAwaitingHuman(
        qa.id,
        'dev-wait-gate-failed-after-qa-started',
        `QA review for task ${transitioned.id} started but dev wait-gate failed; QA prompt may still be running, needs operator decision.`,
        { expectedTaskId: transitioned.id },
      ).catch(err => {
        console.error(
          `[EventHandler] pr.created markAwaitingHuman(QA=${qa.id}) after dev-wait-gate-fail:`,
          err,
        );
      });
    }
  });

  bus.on('pr.updated', async (event) => {
    if (!event.taskId || !event.agentId) return;
    // Server tasks review via the exchange protocol — a poller-observed sync on
    // the published PR must not drag them into legacy QA review.
    // pr.merged stays open: external merges of a ready PR finish through it.
    if (await isServerModeTask(manager, event.taskId)) return;

    const eventKind = event.data.kind as
      | 'push' | 'comment' | 'review-comment' | 'pr-edit' | 'pr-merge-ready' | undefined;

    // spec phase 由 server 评审链驱动；pr-merge-ready 是 dev 内部状态推进，不受限。
    if (eventKind !== 'pr-merge-ready') {
      const taskNow = await manager.getTask(event.taskId);
      if (taskNow?.phase === 'spec') {
        console.warn(
          `[EventHandler] pr.updated (kind=${eventKind ?? 'push'}) ignored for task ${event.taskId}: task in spec phase`,
        );
        return;
      }
    }

    if (eventKind === 'pr-merge-ready') return handlePrMergeReady(bus, manager, event);
    if (eventKind !== 'push' && eventKind !== undefined) return handlePrFeedback(bus, manager, event);
    return handlePrCodePush(bus, manager, event);
  });

  bus.on('pr.merged', async (event) => {
    if (!event.taskId) return;

    const eventPrNumber = event.data.prNumber as number | undefined;
    const eventPrUrl = event.data.prUrl as string | undefined;
    const prPatch: Partial<Pick<TaskState, 'prNumber' | 'prUrl'>> = {
      ...(eventPrNumber !== undefined ? { prNumber: eventPrNumber } : {}),
      ...(eventPrUrl !== undefined ? { prUrl: eventPrUrl } : {}),
    };

    const result = await manager.transitionTaskStatus(
      event.taskId,
      'merged',
      // max_rounds included so manual mark-complete (and an externally-merged
      // max_rounds PR the poller detects) transitions to merged + runs cleanup.
      // ready included for server-mode afterDone:'pr' tasks whose managed PR is
      // merged directly on GitHub instead of via baxian's Confirm.
      { fromStatus: ['in_progress', 'fixing', 'review', 'approved', 'merge-ready', 'ready', 'max_rounds'] },
      prPatch,
    );
    if (!result) return;
    const { task: transitioned } = result;

    if (transitioned.qaAgentId) {
      // Keep QA bound (non-dispatchable) until its branch cleanup + /clear finish, then release.
      // dispatchPostMergeCleanup owns the worktree removal → branch delete → /clear → release.
      if (transitioned.prNumber && transitioned.branch) {
        await manager.dispatchPostMergeCleanup(transitioned.qaAgentId, {
          prNumber: transitioned.prNumber,
          taskId: transitioned.id,
          branch: transitioned.branch,
        }).catch(err => console.warn(
          `[EventHandler] pr.merged dispatchPostMergeCleanup(QA=${transitioned.qaAgentId}) failed:`,
          err,
        ));
      } else {
        // Nothing to clean up or compact — release QA immediately so it frees up.
        try {
          await manager.releaseAgentForTask(transitioned.qaAgentId, transitioned.id, 'idle');
        } catch (err) {
          console.error(
            `[EventHandler] pr.merged releaseAgentForTask(QA=${transitioned.qaAgentId}) failed:`,
            err,
          );
        }
      }
    }

    try {
      await manager.cleanupAfterMerge(transitioned.id);
    } catch (err) {
      console.error(`[EventHandler] cleanupAfterMerge(${transitioned.id}) failed:`, err);
    }
  });

  bus.on('review.submitted', async (event) => {
    if (!event.taskId) return;
    if (await isServerModeTask(manager, event.taskId)) return;

    const action = event.data.action as 'APPROVE' | 'REQUEST_CHANGES' | string;
    let task = await manager.getTask(event.taskId);
    if (!task) return;

    // Terminal-task escape: release QA on manual reviews of merged/cancelled/failed/max_rounds
    // tasks; transitions below return null on terminal so QA would otherwise stay glued.
    // 注：spec phase 任务也可能终态（spec-review max_rounds 只改 status 不清 phase）。terminal
    // escape 必须在 spec gate 之前，否则 spec terminal 状态的残留 QA 绑定无法靠这条 manual
    // review 兜底释放。
    {
      const terminalQaId = task.qaAgentId;
      if (terminalQaId && TASK_TERMINAL_STATUS_SET.has(task.status)) {
        const qaState = await manager.getAgentState(terminalQaId);
        if (qaState?.taskId === task.id) {
          const terminalTask = task;
          await manager
            .releaseAgentForTask(terminalQaId, terminalTask.id, 'idle')
            .catch(err =>
              console.error(
                `[EventHandler] terminal-task manual review releaseAgentForTask(QA=${terminalQaId}) failed:`,
                err,
              ),
            );
          await emitIntervention(bus, terminalTask.projectId, terminalTask.agentId, terminalTask.id, {
            phase: 'manual-review-on-terminal-task-completed',
            qaAgentId: terminalQaId,
            taskStatus: terminalTask.status,
            reviewAction: action,
            note: 'Manual QA review on a terminal task finished. Task state untouched; QA released. Operator owns any follow-up.',
          });
          return;
        }
      }
    }

    // spec phase（非 terminal）由 server 评审链（server.spec.review.submitted）驱动 verdict；
    // GitHub PR review 不应改 task.status，早退避免误推 approved + 派 dev post-approve。
    // terminal 状态已在前面兜底释放，此处只屏蔽 active spec 路径。
    if (task.phase === 'spec') {
      console.warn(
        `[EventHandler] review.submitted (action=${action}) ignored for task ${task.id}: task in spec phase`,
      );
      return;
    }

    // Freshness gate: reject a verdict whose GitHub submit time precedes the
    // current review pass's dispatch. Such a verdict belongs to a SUPERSEDED
    // pass — dev force-pushed mid-review, the server re-dispatched a fresh pass,
    // and the prior pass's late verdict is now landing. GitHub attributes a
    // review to its submit-time head, so commit_id can't catch this; only baxian
    // knows when it dispatched the active pass. Skipped when either timestamp is
    // absent (can't prove staleness → allow).
    const verdictSubmittedAt =
      typeof event.data.submittedAt === 'string' ? event.data.submittedAt : undefined;
    if (verdictSubmittedAt && task.reviewDispatchedAt) {
      const submittedMs = Date.parse(verdictSubmittedAt);
      const dispatchedMs = Date.parse(task.reviewDispatchedAt);
      // Reject only when clearly older than dispatch (beyond the skew budget) — a
      // same-second fresh verdict must not be killed by clock granularity/drift.
      if (
        Number.isFinite(submittedMs) && Number.isFinite(dispatchedMs)
        && submittedMs < dispatchedMs - VERDICT_FRESHNESS_SKEW_MS
      ) {
        await emitIntervention(bus, task.projectId, task.agentId, task.id, {
          phase: 'stale-verdict-superseded-pass',
          action,
          submittedAt: verdictSubmittedAt,
          reviewDispatchedAt: task.reviewDispatchedAt,
        });
        return;
      }
    }

    // Per-pass identity gate. signalToken rotates on every (re)dispatch, so a verdict
    // whose pass token != the task's current token belongs to a SUPERSEDED pass. The
    // token arrives two ways and BOTH must be checked:
    //   - poller verdict: `reviewPassToken` (QA stamps it into the gh review body,
    //     <!-- baxian:pr-approved:TOKEN -->; mapper/poller extract it).
    //   - pane fallback verdict: `data.token` (the signal the watcher matched).
    // Checking only the poller stamp leaves a hole: an old QA's late
    // `[bx:pr-approved:<old-token>]`, fired by a not-yet-replaced watcher after a
    // redispatch whose new-QA dispatch failed, would bypass the rotation. That pane
    // case is worse — it has no headSha, so the handler would otherwise bind it to the
    // new anchor head the old QA never reviewed. Verify-if-present: a human review (no
    // stamp / no token) is not rejected.
    const verdictPassToken =
      (typeof event.data.reviewPassToken === 'string' ? event.data.reviewPassToken : undefined)
      ?? (typeof event.data.token === 'string' ? event.data.token : undefined);
    if (verdictPassToken && task.signalToken && verdictPassToken !== task.signalToken) {
      await emitIntervention(bus, task.projectId, task.agentId, task.id, {
        phase: 'stale-verdict-wrong-pass',
        action,
        verdictPassToken,
        currentToken: task.signalToken,
        source: event.data.source === 'pane-signal' ? 'pane-signal' : 'poller',
      });
      return;
    }

    const eventPrNumber = event.data.prNumber as number | undefined;
    const eventPrUrl = event.data.prUrl as string | undefined;
    const prPatch: Partial<Pick<TaskState, 'prNumber' | 'prUrl'>> = {
      ...(eventPrNumber !== undefined && eventPrNumber !== task.prNumber ? { prNumber: eventPrNumber } : {}),
      ...(eventPrUrl !== undefined && eventPrUrl !== task.prUrl ? { prUrl: eventPrUrl } : {}),
    };
    // Poller verdicts carry `headSha` (the review's GitHub commit_id) and
    // `currentHeadSha` (the PR's live head). A pane-fallback verdict (same-identity
    // 422 case) carries neither — the agent doesn't observe SHAs — so it applies to
    // the head pinned at dispatch into `task.reviewHeadAnchorSha`. Using
    // `latestHeadSha` would let a mid-review push silently re-anchor the approval to
    // a commit QA never saw; the anchor is immutable per review round.
    const isPaneSignal = event.data.source === 'pane-signal';
    const reviewedHeadSha = validHeadSha(event.data.headSha)
      ?? (isPaneSignal ? validHeadSha(task.reviewHeadAnchorSha) : undefined);
    const currentHeadSha = validHeadSha(event.data.currentHeadSha)
      ?? (isPaneSignal ? validHeadSha(task.reviewHeadAnchorSha) : undefined);

    // A late verdict can arrive while the task is still in_progress/fixing (the
    // pr.created/pr.updated that should have moved it to review was missed). Catch up
    // to review WITHOUT bumping here: the first-review count is derived from persisted
    // state below (reviewRound === 0 ⇒ first pass) and applied only when the verdict is
    // accepted. So a stale verdict that returns early leaves reviewRound 0, and the
    // NEXT valid verdict — which no longer re-enters this catch-up — still counts it.
    if ((task.status === 'in_progress' || task.status === 'fixing') && eventPrNumber !== undefined) {
      const catchup = await manager.transitionTaskStatus(
        event.taskId,
        'review',
        { fromStatus: ['in_progress', 'fixing'] },
        prPatch,
      );
      if (catchup) {
        task = catchup.task;
        if (task.agentId) {
          const ok = await manager.markAgentWaiting(task.agentId, task.id);
          if (!ok) {
            await emitIntervention(bus, task.projectId, task.agentId, task.id, {
              phase: 'dev-wait-gate-failed-late-catchup',
            });
          }
        }
      } else {
        return;
      }
    }

    if (action === 'APPROVE') {
      return handleReviewApproval(bus, manager, task, reviewedHeadSha, currentHeadSha, prPatch);
    }
    if (action === 'REQUEST_CHANGES') {
      return handleReviewRequestChanges(bus, manager, task, reviewedHeadSha, currentHeadSha, prPatch);
    }
  });

  // Dev emitted pr-fixed: it claims the fixing round is done. Verify on GitHub
  // before advancing (option C) — a new commit OR a reply to the findings means
  // real work; neither means a no-op claim. Every GitHub read
  // fails closed: a verification we can't complete must NOT be read as "no-op".
  bus.on('pr.fix.submitted', async (event) => {
    if (!event.taskId || !event.agentId) return;
    const task = await manager.getTask(event.taskId);
    if (!task || task.reviewMode === 'server' || task.status !== 'fixing' || task.phase === 'spec') return;
    const { projectId, agentId } = task;

    // The watcher is one-shot and already consumed this pr-fixed. For paths that
    // leave the task in `fixing`, re-establish (skipSnapshot so we don't re-fire on the
    // same scrollback signal) so the dev can retry pr-fixed after addressing the
    // note — otherwise a corrected retry has no watcher and the task strands.
    const stayFixing = async (data: { phase: string; [key: string]: unknown }): Promise<void> => {
      await emitIntervention(bus, projectId, agentId, task.id, data);
      await manager.setupPhaseSignal(task.id, agentId, 'pr-fixed', { skipSnapshot: true });
    };

    // Anti-stale, fail-closed: a pr-fixed with a missing OR mismatched token
    // (superseded pass) must not advance. No re-establish — a superseded pass means a
    // fresh dispatch already set up its own watcher.
    const token = typeof event.data.token === 'string' ? event.data.token : undefined;
    if (!token || !task.signalToken || token !== task.signalToken) {
      await emitIntervention(bus, projectId, agentId, task.id, {
        phase: 'stale-pr-fixed-wrong-pass',
        signalToken: token,
        currentToken: task.signalToken,
      });
      return;
    }

    // pr-fixed's premise is "read the real GitHub state", so the head MUST come
    // from a live fetch (resolveAuthoritativeHead's stale fallback could read the
    // pre-push anchor). Fail closed on fetch failure rather than guessing no-op.
    let headSha: string;
    try {
      headSha = await fetchVerifiedHeadSha(manager, task.id);
    } catch (err) {
      await stayFixing({
        phase: 'fix-verify-head-fetch-failed',
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // Without a review anchor we can't tell a pushed fix from a no-op — fail closed
    // rather than mis-read the missing anchor as "no new commit".
    if (!task.reviewHeadAnchorSha) {
      await stayFixing({ phase: 'fix-verify-no-anchor', headSha });
      return;
    }

    // New commit → the poller's pr.updated(push) is the authoritative advance;
    // re-dispatching here too would double-trigger the QA recheck. Defer to it.
    if (headSha !== task.reviewHeadAnchorSha) return;

    // No new commit: did the dev do anything since THIS fix round started? Use
    // fixDispatchedAt (not reviewDispatchedAt) so QA/human comments left during the
    // prior review don't count as dev activity. Fail closed on a fetch error.
    const since = task.fixDispatchedAt ?? task.reviewDispatchedAt;
    let hasReplies: boolean;
    try {
      hasReplies = since ? await manager.prHasDevReplySince(task.id, since) : false;
    } catch (err) {
      await stayFixing({
        phase: 'fix-verify-replies-fetch-failed',
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (!hasReplies) {
      await stayFixing({
        phase: 'fix-no-op-no-commit-no-reply',
        note: 'Dev emitted pr-fixed but pushed no commit and left no reply on the PR — the fixing round changed nothing. Inspect the pane.',
      });
      return;
    }

    // Replies but no new commit (all "Won't fix"): recheck the same head + the
    // replies. Reuse the push path for identical round/anchor/token semantics.
    await bus.emit({
      id: '',
      type: 'pr.updated',
      timestamp: new Date().toISOString(),
      projectId,
      agentId,
      taskId: task.id,
      data: {
        kind: 'push',
        headSha,
        ...(task.prNumber !== undefined ? { prNumber: task.prNumber } : {}),
        ...(task.prUrl !== undefined ? { prUrl: task.prUrl } : {}),
        source: 'pr-fixed',
      },
    });

    // If that synthetic advance failed downstream — the push handler rolls a failed
    // QA dispatch back from review to fixing — the one-shot pr-fixed watcher is
    // already consumed and (unlike a real push) there is no poller event to retry
    // it. Surface it rather than leaving the task silently stuck in fixing.
    const afterAdvance = await manager.getTask(task.id);
    if (afterAdvance?.status === 'fixing') {
      await emitIntervention(bus, projectId, agentId, task.id, {
        phase: 'fix-advance-rolled-back',
        note: 'pr-fixed advanced the PR to QA recheck but the QA dispatch failed and rolled the task back to fixing; the completion watcher is consumed. Inspect the QA agent and re-dispatch.',
      });
    }
  });
}
