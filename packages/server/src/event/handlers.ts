import { createSignalToken, type PhaseSignalKind } from '../agent/phase-signal.js';
import { BRANCH_PREFIX, TASK_TERMINAL_STATUS_SET, isValidBranchName, type BaxianEvent, type TaskState } from '../shared/index.js';
import type { EventBus } from './bus.js';
import { type AgentManager, DispatchTerminalError, EnsureSessionError } from '../agent/manager.js';

type InterventionData = Record<string, unknown> & { phase: string };
const HEAD_SHA_RE = /^[0-9a-f]{40}$/i;

function validHeadSha(value: unknown): string | undefined {
  return typeof value === 'string' && HEAD_SHA_RE.test(value) ? value : undefined;
}

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

const POST_APPROVE_REDISPATCH_CAP = 10;

const VERDICT_FRESHNESS_SKEW_MS = 5000;

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

  const [freshTask, freshCompletion] = await Promise.all([
    manager.getTask(taskNow.id),
    manager.getPostApproveCompletion(taskNow.id),
  ]);
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
  const isNewFeedback = eventKind === 'comment' || eventKind === 'review-comment';
  const prPatch: Partial<Pick<TaskState, 'prNumber' | 'prUrl'>> = {
    ...(eventPrNumber !== undefined ? { prNumber: eventPrNumber } : {}),
    ...(eventPrUrl !== undefined ? { prUrl: eventPrUrl } : {}),
  };
  const taskPatch: Partial<Pick<TaskState, 'prNumber' | 'prUrl' | 'prFeedbackReceivedAt'>> = {
    ...prPatch,
    ...(isNewFeedback ? { prFeedbackReceivedAt: event.timestamp } : {}),
  };
  const needsPatch =
    (eventPrNumber !== undefined && eventPrNumber !== taskNow.prNumber)
    || (eventPrUrl !== undefined && eventPrUrl !== taskNow.prUrl)
    || isNewFeedback;
  if (needsPatch) {
    await manager.updateTask(taskId, taskPatch);
  }
  if (taskNow.status !== 'approved') return;
  if (!isNewFeedback) return;

  const completion = await manager.getPostApproveCompletion(taskNow.id);
  if (!completion) {
    await emitIntervention(bus, taskNow.projectId, taskNow.agentId, taskNow.id, {
      phase: 'post-approve-approved-head-unavailable',
    });
    return;
  }
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
    { ...taskNow, ...taskPatch },
    completion.approvedHeadSha,
    { redispatchCount: nextCount },
  );
}

async function releaseQaAfterSkippedRollback(
  manager: AgentManager,
  taskId: string,
  qaId: string,
  logPrefix: string,
): Promise<void> {
  const now = await manager.getTask(taskId);
  if (now && !TASK_TERMINAL_STATUS_SET.has(now.status)) {
    // pass 被并发接管：QA 已被接管方 re-acquire，释放会误清其绑定；
    // 但本次派发的 arm 可能已顶掉接管方的 watcher（start 先 stop 同 task 旧 watcher），按当前 pass 重建
    console.warn(`${logPrefix} rollback skipped for task=${taskId}: pass superseded`);
    await manager.rearmPhaseSignalForCurrentPass(taskId);
    return;
  }
  // 终态/已删：没有接管方持有这只 QA，而 cancel 清理可能没见到刚写入的 qaAgentId
  await manager.releaseAgentForTask(qaId, taskId, 'idle').catch(err => {
    console.error(`${logPrefix} releaseAgentForTask(QA=${qaId}) after terminal-skip rollback failed:`, err);
    return false;
  });
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
  // 合成 push 的触发信号已被消费但仍留在 pane，失败回滚重建 pr-fixed watcher 时跳过快照，否则立即重放成循环
  const rearmSkipSnapshot = event.data.source === 'pr-fixed';
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

  const anchorAtDispatch = eventHeadSha ?? validHeadSha(taskBeforeTransition.latestHeadSha);
  const result = await manager.transitionTaskStatus(
    taskId,
    'review',
    { fromStatus: ['in_progress', 'fixing', 'review', 'approved', 'merge-ready'] },
    {
      ...prPatch,
      ...(anchorAtDispatch ? { reviewHeadAnchorSha: anchorAtDispatch } : {}),
      reviewDispatchedAt: new Date().toISOString(),
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

  await manager.updateTask(transitioned.id, { qaAgentId: qa.id });

  const { token: dispatchToken, armed } = await manager.rotateAndSetupPhaseSignal(
    transitioned.id,
    qa.id,
    ['pr-approved', 'pr-changes-requested'] as const,
  );
  if (!armed) {
    console.warn(
      `[EventHandler] pr.updated verdict watcher failed to arm for task=${transitioned.id} (${qaPhase}); rolling back recheck dispatch`,
    );
    if (previousStatus === 'in_progress' || previousStatus === 'fixing') {
      const rolledBack = await manager.rollbackVerdictArmFailure(transitioned.id, {
        status: previousStatus,
        signalToken: taskBeforeTransition.signalToken,
        reviewHeadAnchorSha: taskBeforeTransition.reviewHeadAnchorSha,
        reviewDispatchedAt: taskBeforeTransition.reviewDispatchedAt,
      }, { expect: { status: 'review', signalToken: dispatchToken }, rearmSkipSnapshot });
      if (!rolledBack) {
        await releaseQaAfterSkippedRollback(manager, transitioned.id, qa.id, '[EventHandler] pr.updated arm-failure');
        return;
      }
    } else {
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
    } else if (previousStatus === 'in_progress' || previousStatus === 'fixing') {
      // 仅回滚 status 会留下 transition 轮换后的 token，dev 在途 pass 的完成信号将永久失配；
      // startSession 窗口内 pass 可能已被并发接管，此时回滚与 QA 释放都要让位于接管方
      const rolledBack = await manager.rollbackVerdictArmFailure(transitioned.id, {
        status: previousStatus,
        signalToken: taskBeforeTransition.signalToken,
        reviewHeadAnchorSha: taskBeforeTransition.reviewHeadAnchorSha,
        reviewDispatchedAt: taskBeforeTransition.reviewDispatchedAt,
      }, { expect: { status: 'review', signalToken: dispatchToken }, rearmSkipSnapshot });
      if (rolledBack) {
        await manager.releaseAgentForTask(qa.id, transitioned.id, 'idle')
          .catch(err => {
            console.error(
              `[EventHandler] pr.updated releaseAgentForTask(QA=${qa.id}) after start-not-true failed:`,
              err,
            );
            return false;
          });
      } else {
        await releaseQaAfterSkippedRollback(manager, transitioned.id, qa.id, '[EventHandler] pr.updated recheck');
      }
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
      } else {
        await emitIntervention(bus, transitioned.projectId, transitioned.agentId, transitioned.id, {
          phase: 'qa-recheck-failed-after-stop',
          qaAgentId: qa.id,
        });
      }
    }
    return;
  }

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

async function redispatchReviewForStaleVerdict(
  manager: AgentManager,
  task: TaskState,
): Promise<boolean> {
  if (task.status !== 'review') return false;
  if (task.qaAgentId) {
    // 当前 pass 的 QA 会话还在跑时，迟到的旧 verdict 只是噪音，不能重派打断
    const qaState = await manager.getAgentState(task.qaAgentId);
    if (qaState?.taskId === task.id) return false;
  }
  try {
    // fromStatus/expectSignalToken 在 dispatch 锁内复核：本地快照到这里的窗口里任务可能已离开 review
    // 或被并发 dispatcher 换代 pass，不能靠上面的预检
    await manager.dispatchReviewToQa(task.id, {
      fromStatus: ['review'],
      bumpRound: false,
      expectSignalToken: task.signalToken,
    });
  } catch (err) {
    console.error(
      `[EventHandler] stale-verdict auto-redispatch failed for task ${task.id}:`,
      err,
    );
    return false;
  }
  console.warn(
    `[EventHandler] stale verdict for task ${task.id} arrived with no active QA session; redispatched review`,
  );
  return true;
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
    task.reviewRound === 0 ? { ...prPatch, reviewRound: 1 } : prPatch,
  );
  if (!result) return;
  const { task: transitioned } = result;

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
    const taskAtEntry = await manager.getTask(event.taskId);
    if (taskAtEntry?.reviewMode === 'server') return;
    if (taskAtEntry?.phase === 'spec') {
      console.warn(
        `[EventHandler] pr.created ignored for task ${event.taskId}: task in spec phase`,
      );
      return;
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
              const isOwnBxBranch = prInfo.headRefName === ownPrefix;
              const boundToThisTask = !!bound && bound.id === taskNow.id;
              // Adopt only on deterministic ownership — our own bx/<taskId> namespace or a branch this
              // task already owns. A dev-chosen branch that is neither is rejected to intervention, not
              // adopted on an unverifiable claim (a mis-reported PR number must not rebind the task).
              if (!isForeignBxBranch && isValidBranchName(prInfo.headRefName)
                && (isOwnBxBranch || boundToThisTask)) {
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
    const taskBeforeTransition = await manager.getTask(event.taskId);
    // A poller-sourced pr.created adopts by branch match alone (no pane verify). bx/<taskId> is unique
    // to this task; a custom branch name can be reused, so for a custom-branch task only accept a PR it
    // already tracks — a new custom-branch PR must arrive via the deterministic pane signal, not by the
    // poller matching a stale/foreign open PR that happens to share the branch name.
    if (event.data.source !== 'pane-signal'
      && taskBeforeTransition
      && taskBeforeTransition.branch !== BRANCH_PREFIX + event.taskId
      && taskBeforeTransition.prNumber !== event.data.prNumber) {
      console.warn(
        `[EventHandler] pr.created: ignoring poller-sourced PR ${event.data.prNumber} on custom branch ` +
        `for task ${event.taskId} (untracked; custom-branch PRs adopt via the pane signal)`,
      );
      return;
    }
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

    const acquired = await manager.acquireAgentForTask(qa.id, transitioned.id, 'review');
    if (!acquired) {
      await emitIntervention(bus, transitioned.projectId, transitioned.agentId, transitioned.id, {
        phase: 'qa-acquire-failed',
        qaAgentId: qa.id,
      });
      return;
    }

    await manager.updateTask(transitioned.id, { qaAgentId: qa.id });

    const { token: dispatchToken, armed } = await manager.rotateAndSetupPhaseSignal(
      transitioned.id,
      qa.id,
      ['pr-approved', 'pr-changes-requested'] as const,
    );
    if (!armed) {
      console.warn(
        `[EventHandler] pr.created verdict watcher failed to arm for task=${transitioned.id}; rolling back review dispatch`,
      );
      const rolledBack = await manager.rollbackVerdictArmFailure(transitioned.id, {
        status: previousStatus,
        signalToken: taskBeforeTransition?.signalToken,
        reviewHeadAnchorSha: taskBeforeTransition?.reviewHeadAnchorSha,
        reviewDispatchedAt: taskBeforeTransition?.reviewDispatchedAt,
      }, { expect: { status: 'review', signalToken: dispatchToken } });
      if (!rolledBack) {
        await releaseQaAfterSkippedRollback(manager, transitioned.id, qa.id, '[EventHandler] pr.created arm-failure');
        return;
      }
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
      } else {
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

    if (previousStatus === 'in_progress') {
      await manager.bumpReviewRoundIfStillAt(transitioned.id, expectedRound);
    }

    const ok = await manager.markAgentWaiting(event.agentId, transitioned.id);
    if (!ok) {
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
    const taskAtEntry = await manager.getTask(event.taskId);
    if (taskAtEntry?.reviewMode === 'server') return;

    const eventKind = event.data.kind as
      | 'push' | 'comment' | 'review-comment' | 'pr-edit' | 'pr-merge-ready' | undefined;

    if (eventKind !== 'pr-merge-ready' && taskAtEntry?.phase === 'spec') {
      console.warn(
        `[EventHandler] pr.updated (kind=${eventKind ?? 'push'}) ignored for task ${event.taskId}: task in spec phase`,
      );
      return;
    }

    if (eventKind === 'pr-merge-ready') return handlePrMergeReady(bus, manager, event);
    if (eventKind !== 'push' && eventKind !== undefined) return handlePrFeedback(bus, manager, event);
    return handlePrCodePush(bus, manager, event);
  });

  bus.on('pr.merged', async (event) => {
    if (!event.taskId) return;

    const eventPrNumber = event.data.prNumber as number | undefined;
    const eventPrUrl = event.data.prUrl as string | undefined;

    // The poller surfaces every merged PR on a managed branch — including a stale one whose number
    // this task never tracked (e.g. a reused custom branch name). bx/<taskId> is unique to this task,
    // so its merge is definitively ours even if pr.created was missed and prNumber was never recorded;
    // for any other branch require the tracked PR number to match, else a foreign/stale merge on a
    // reused custom branch name could prematurely finish an active task.
    const taskBefore = await manager.getTask(event.taskId);
    if (!taskBefore) return;
    const mergedOwnBxBranch = (event.data.branch as string | undefined) === BRANCH_PREFIX + event.taskId;
    if (!mergedOwnBxBranch && typeof eventPrNumber === 'number' && taskBefore.prNumber !== eventPrNumber) return;

    const prPatch: Partial<Pick<TaskState, 'prNumber' | 'prUrl'>> = {
      ...(eventPrNumber !== undefined ? { prNumber: eventPrNumber } : {}),
      ...(eventPrUrl !== undefined ? { prUrl: eventPrUrl } : {}),
    };

    const result = await manager.transitionTaskStatus(
      event.taskId,
      'merged',
      { fromStatus: ['in_progress', 'fixing', 'review', 'approved', 'merge-ready', 'ready', 'max_rounds'] },
      prPatch,
    );
    if (!result) return;
    const { task: transitioned } = result;

    if (transitioned.qaAgentId) {
      if (transitioned.prNumber && transitioned.branch) {
        await manager.dispatchPostMergeCleanup(transitioned.qaAgentId, {
          taskId: transitioned.id,
          branch: transitioned.branch,
        }).catch(err => console.warn(
          `[EventHandler] pr.merged dispatchPostMergeCleanup(QA=${transitioned.qaAgentId}) failed:`,
          err,
        ));
      } else {
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

    const action = event.data.action as 'APPROVE' | 'REQUEST_CHANGES' | string;
    let task = await manager.getTask(event.taskId);
    if (!task) return;
    if (task.reviewMode === 'server') return;

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

    if (task.phase === 'spec') {
      console.warn(
        `[EventHandler] review.submitted (action=${action}) ignored for task ${task.id}: task in spec phase`,
      );
      return;
    }

    const verdictSubmittedAt =
      typeof event.data.submittedAt === 'string' ? event.data.submittedAt : undefined;
    if (verdictSubmittedAt && task.reviewDispatchedAt) {
      const submittedMs = Date.parse(verdictSubmittedAt);
      const dispatchedMs = Date.parse(task.reviewDispatchedAt);
      if (
        Number.isFinite(submittedMs) && Number.isFinite(dispatchedMs)
        && submittedMs < dispatchedMs - VERDICT_FRESHNESS_SKEW_MS
      ) {
        if (!(await redispatchReviewForStaleVerdict(manager, task))) {
          await emitIntervention(bus, task.projectId, task.agentId, task.id, {
            phase: 'stale-verdict-superseded-pass',
            action,
            submittedAt: verdictSubmittedAt,
            reviewDispatchedAt: task.reviewDispatchedAt,
          });
        }
        return;
      }
    }

    const verdictPassToken =
      (typeof event.data.reviewPassToken === 'string' ? event.data.reviewPassToken : undefined)
      ?? (typeof event.data.token === 'string' ? event.data.token : undefined);
    if (verdictPassToken && task.signalToken && verdictPassToken !== task.signalToken) {
      if (!(await redispatchReviewForStaleVerdict(manager, task))) {
        await emitIntervention(bus, task.projectId, task.agentId, task.id, {
          phase: 'stale-verdict-wrong-pass',
          action,
          verdictPassToken,
          currentToken: task.signalToken,
          source: event.data.source === 'pane-signal' ? 'pane-signal' : 'poller',
        });
      }
      return;
    }

    const eventPrNumber = event.data.prNumber as number | undefined;
    const eventPrUrl = event.data.prUrl as string | undefined;
    const prPatch: Partial<Pick<TaskState, 'prNumber' | 'prUrl'>> = {
      ...(eventPrNumber !== undefined && eventPrNumber !== task.prNumber ? { prNumber: eventPrNumber } : {}),
      ...(eventPrUrl !== undefined && eventPrUrl !== task.prUrl ? { prUrl: eventPrUrl } : {}),
    };
    const isPaneSignal = event.data.source === 'pane-signal';
    const reviewedHeadSha = validHeadSha(event.data.headSha)
      ?? (isPaneSignal ? validHeadSha(task.reviewHeadAnchorSha) : undefined);
    const currentHeadSha = validHeadSha(event.data.currentHeadSha)
      ?? (isPaneSignal ? validHeadSha(task.reviewHeadAnchorSha) : undefined);

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

  bus.on('pr.fix.submitted', async (event) => {
    if (!event.taskId || !event.agentId) return;
    const task = await manager.getTask(event.taskId);
    if (!task || task.reviewMode === 'server' || task.status !== 'fixing' || task.phase === 'spec') return;
    const { projectId, agentId } = task;

    const stayFixing = async (data: { phase: string; [key: string]: unknown }): Promise<void> => {
      await emitIntervention(bus, projectId, agentId, task.id, data);
      await manager.setupPhaseSignal(task.id, agentId, 'pr-fixed', { skipSnapshot: true });
    };

    const token = typeof event.data.token === 'string' ? event.data.token : undefined;
    if (!token || !task.signalToken || token !== task.signalToken) {
      await emitIntervention(bus, projectId, agentId, task.id, {
        phase: 'stale-pr-fixed-wrong-pass',
        signalToken: token,
        currentToken: task.signalToken,
      });
      return;
    }

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

    if (!task.reviewHeadAnchorSha) {
      await stayFixing({ phase: 'fix-verify-no-anchor', headSha });
      return;
    }

    if (headSha === task.reviewHeadAnchorSha) {
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
    }
    // head fetch / 回复检查是秒级网络等待，期间真 push / verdict 可能已换代 pass；旧信号不得再驱动派发
    const preEmit = await manager.getTask(task.id);
    if (!preEmit || preEmit.status !== 'fixing' || preEmit.signalToken !== token) return;

    // head 前进时不能指望 poller：push 事件已被消费（cursor 不回退），若那次派发失败回滚，
    // 这里的合成 push 是唯一重试入口；宁可与迟到的真 push 竞态重派一轮，也不静默滞留 fixing

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

    const afterAdvance = await manager.getTask(task.id);
    if (afterAdvance?.status === 'fixing') {
      await emitIntervention(bus, projectId, agentId, task.id, {
        phase: 'fix-advance-rolled-back',
        note: 'pr-fixed advanced the PR to QA recheck but the QA dispatch failed and rolled the task back to fixing; the completion watcher is consumed. Inspect the QA agent and re-dispatch.',
      });
    }
  });
}
