import { decodeSignalActorId, type PhaseSignalKind } from '../agent/phase-signal.js';
import { BODY_DIGEST_SOURCE } from '../platform/body-digest.js';
import { ackRevisionKey } from '../platform/markers.js';
import { LINE_SAFE_ID_RE } from '../platform/row-schema.js';
import { SHA_HEX_SOURCE, SOURCE_KEY_PATTERN } from '../platform/types.js';
import {
  BRANCH_PREFIX,
  isRecord,
  isSpecStagePhase,
  isValidBranchName,
  type BaxianEvent,
  type TaskState,
} from '../shared/index.js';
import type { EventBus } from './bus.js';
import {
  type AgentManager,
  type PostApproveEpisodeKey,
  DispatchTerminalError,
  isRecoverableQaDispatchHold,
} from '../agent/manager.js';
import { ReplNotReadyError } from '../agent/tmux.js';
import { DirtyWorkdirError } from '../agent/branch.js';

type InterventionData = Record<string, unknown> & { phase: string };
const HEAD_SHA_RE = new RegExp(`^${SHA_HEX_SOURCE}$`);
const BODY_DIGEST_RE = new RegExp(`^${BODY_DIGEST_SOURCE}$`);
const PR_UPDATED_REVIEW_FROM_STATUSES: TaskState['status'][] = [
  'in_progress', 'fixing', 'review', 'approved', 'merge-ready',
];

function validHeadSha(value: unknown): string | undefined {
  return typeof value === 'string' && HEAD_SHA_RE.test(value) ? value : undefined;
}

class GitVerdictPayloadError extends Error {
  constructor(message: string) {
    super(`malformed git verdict: ${message}`);
    this.name = 'GitVerdictPayloadError';
  }
}

interface GitVerdictPayload {
  action: 'APPROVE' | 'REQUEST_CHANGES';
  reviewPassToken: string;
  verdictToken: string;
  headSha: string;
  currentHeadSha: string;
  prNumber: number;
  prUrl: string;
  carrier: { sourceKey: string; id: string; bodyDigest: string };
}

interface GitFeedbackRevision {
  sourceKey: string;
  id: string;
  bodyDigest: string;
  versionTime?: number;
}

function parseGitVerdictPayload(data: Record<string, unknown>): GitVerdictPayload {
  if (data.action !== 'APPROVE' && data.action !== 'REQUEST_CHANGES') {
    throw new GitVerdictPayloadError('unknown action');
  }
  if (data.source !== 'platform-poller') throw new GitVerdictPayloadError('invalid source');
  if (typeof data.reviewPassToken !== 'string' || !/^[0-9a-f]{12}$/.test(data.reviewPassToken)) {
    throw new GitVerdictPayloadError('invalid review pass token');
  }
  if (typeof data.verdictToken !== 'string' || !/^[0-9a-f]{12}$/.test(data.verdictToken)) {
    throw new GitVerdictPayloadError('invalid verdict token');
  }
  const headSha = validHeadSha(data.headSha);
  const currentHeadSha = validHeadSha(data.currentHeadSha);
  if (!headSha || !currentHeadSha) throw new GitVerdictPayloadError('invalid head sha');
  if (!Number.isInteger(data.prNumber) || (data.prNumber as number) < 1) {
    throw new GitVerdictPayloadError('invalid PR number');
  }
  if (typeof data.prUrl !== 'string' || data.prUrl.trim() === '' || data.prUrl.length > 4096) {
    throw new GitVerdictPayloadError('invalid PR URL');
  }
  if (typeof data.branch !== 'string' || data.branch.trim() === '' || data.branch.length > 1024) {
    throw new GitVerdictPayloadError('invalid PR branch');
  }
  if (data.submittedAt !== undefined
    && (typeof data.submittedAt !== 'string' || !Number.isFinite(Date.parse(data.submittedAt)))) {
    throw new GitVerdictPayloadError('invalid submission time');
  }
  if (data.verdictConflict !== undefined && typeof data.verdictConflict !== 'boolean') {
    throw new GitVerdictPayloadError('invalid conflict flag');
  }
  if (!isRecord(data.verdictCarrier)) throw new GitVerdictPayloadError('missing carrier');
  const carrier = data.verdictCarrier;
  if (typeof carrier.sourceKey !== 'string' || carrier.sourceKey.trim() === '' || carrier.sourceKey.length > 128
    || typeof carrier.id !== 'string' || carrier.id.trim() === '' || carrier.id.length > 512
    || typeof carrier.bodyDigest !== 'string' || !/^[0-9a-f]{64}$/.test(carrier.bodyDigest)) {
    throw new GitVerdictPayloadError('invalid carrier');
  }
  return {
    action: data.action,
    reviewPassToken: data.reviewPassToken,
    verdictToken: data.verdictToken,
    headSha,
    currentHeadSha,
    prNumber: data.prNumber as number,
    prUrl: data.prUrl,
    carrier: {
      sourceKey: carrier.sourceKey,
      id: carrier.id,
      bodyDigest: carrier.bodyDigest,
    },
  };
}

function parseGitFeedbackRevision(value: unknown): GitFeedbackRevision | null {
  if (!isRecord(value)) return null;
  if (typeof value.sourceKey !== 'string' || !SOURCE_KEY_PATTERN.test(value.sourceKey)) return null;
  if (typeof value.id !== 'string' || !LINE_SAFE_ID_RE.test(value.id)) return null;
  if (typeof value.bodyDigest !== 'string' || !BODY_DIGEST_RE.test(value.bodyDigest)) return null;
  if (value.versionTime !== undefined
    && (typeof value.versionTime !== 'number' || !Number.isFinite(value.versionTime))) return null;
  return {
    sourceKey: value.sourceKey,
    id: value.id,
    bodyDigest: value.bodyDigest,
    ...(value.versionTime !== undefined ? { versionTime: value.versionTime } : {}),
  };
}

async function reArmDevelopWatcher(
  manager: AgentManager,
  task: TaskState,
  agentId: string,
  opts: { skipSnapshot?: boolean } = {},
): Promise<void> {
  const kinds: readonly PhaseSignalKind[] = task.phase === 'research'
    ? ['spec-done']
    : task.phase === 'code'
      ? ['pr-created']
      : ['spec-done', 'pr-created'];
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

const POST_APPROVE_REDISPATCH_CAP = 10;
const POST_APPROVE_RECOVERY_MIN_AGE_MS = 60_000;
// 损坏值不可自愈，每周期 sweep 会重踩同一分支：按 task+值去重，值变化或修复后允许重报
const unparseableUpdatedAtWarned = new Map<string, string>();

const VERDICT_FRESHNESS_SKEW_MS = 5000;

function postApproveEpisodeKey(task: TaskState): PostApproveEpisodeKey | null {
  if (task.postApproveGeneration === undefined
    || task.postApproveToken === undefined
    || task.postApproveHeadSha === undefined) return null;
  return {
    generation: task.postApproveGeneration,
    token: task.postApproveToken,
    headSha: task.postApproveHeadSha,
  };
}

async function dispatchGitDevPostApproveCheck(
  bus: EventBus,
  manager: AgentManager,
  snapshot: TaskState,
  approvedHeadSha: string,
  opts: { redispatchCount?: number; expectedEpisode?: PostApproveEpisodeKey } = {},
): Promise<void> {
  if (!approvedHeadSha) {
    await emitIntervention(bus, snapshot.projectId, snapshot.agentId, snapshot.id, {
      phase: 'post-approve-approved-head-unavailable',
    });
    return;
  }
  const live = await manager.getTask(snapshot.id);
  if (!live || live.status !== 'approved' || live.reviewMode !== 'git') return;
  let key = postApproveEpisodeKey(live);
  if (!key || key.headSha !== approvedHeadSha || live.postApprovePhase === undefined) {
    await emitIntervention(bus, snapshot.projectId, snapshot.agentId, snapshot.id, {
      phase: 'post-approve-episode-invalid',
    });
    return;
  }
  if (opts.expectedEpisode
    && (key.generation !== opts.expectedEpisode.generation
      || key.token !== opts.expectedEpisode.token
      || key.headSha !== opts.expectedEpisode.headSha)) return;
  if (opts.redispatchCount !== undefined) {
    const rotated = await manager.rotateGitPostApproveEpisode(
      live.id,
      opts.expectedEpisode ?? key,
      opts.redispatchCount,
    );
    if (!rotated) return;
    key = rotated;
  }

  const acquired = await manager.acquireAgentForTask(live.agentId, live.id, 'post-approve');
  if (!acquired) {
    await emitIntervention(bus, live.projectId, live.agentId, live.id, {
      phase: 'post-approve-dev-acquire-failed',
      devAgentId: live.agentId,
      generation: key.generation,
    });
    return;
  }
  if (!(await manager.armGitPostApproveEpisode(live.id, key))) {
    await manager.markAgentWaiting(live.agentId, live.id, {
      expectedPostApproveEpisode: key,
    }).catch(err => {
      console.error(`[EventHandler] post-approve arm refusal release failed for task=${live.id}:`, err);
    });
    await emitIntervention(bus, live.projectId, live.agentId, live.id, {
      phase: 'post-approve-signal-arm-failed',
      generation: key.generation,
    });
    return;
  }

  let resumed = false;
  let dispatchErr: unknown;
  try {
    resumed = await manager.continueSession(live.id, live.agentId, 'post-approve', {
      signalToken: key.token,
      postApproveEpisode: key,
      ...(opts.redispatchCount !== undefined
        ? { postApproveRedispatchCount: opts.redispatchCount }
        : {}),
    });
  } catch (err) {
    dispatchErr = err;
    console.error(`[EventHandler] post-approve dispatch failed for task=${live.id}:`, err);
  }
  if (resumed) {
    await manager.confirmPostApprovePromptDelivered(live.id, key);
    return;
  }
  if (dispatchErr instanceof DispatchTerminalError) {
    await manager.failTaskForDispatchError(live.id, 'post-approve', live.agentId, dispatchErr, {
      expectedPostApproveEpisode: key,
    });
    return;
  }
  await manager.markAgentWaiting(live.agentId, live.id, {
    expectedPostApproveEpisode: key,
  }).catch(err => {
    console.error(`[EventHandler] post-approve rollback failed for task=${live.id}:`, err);
  });
  await emitIntervention(bus, live.projectId, live.agentId, live.id, {
    phase: 'post-approve-dispatch-failed',
    reviewRound: live.reviewRound,
    generation: key.generation,
    ...(dispatchErr ? { error: dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr) } : {}),
  });
}

async function handlePrMergeReady(
  bus: EventBus,
  manager: AgentManager,
  event: BaxianEvent,
): Promise<void> {
  const taskId = event.taskId!;
  const taskNow = await manager.getTask(taskId);
  if (!taskNow || taskNow.reviewMode !== 'git') return;
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
  const entryGitEpisode = postApproveEpisodeKey(taskNow);
  if (entryGitEpisode?.token !== signalToken) return;

  const ok = await manager.markAgentWaiting(taskNow.agentId, taskNow.id, {
    expectedPostApproveEpisode: entryGitEpisode,
  });
  if (!ok) {
    await emitIntervention(bus, taskNow.projectId, taskNow.agentId, taskNow.id, {
      phase: 'post-approve-dev-wait-gate-failed',
    });
    return;
  }

  const [freshTask, entryCompletion] = await Promise.all([
    manager.getTask(taskNow.id),
    manager.getPostApproveCompletion(taskNow.id),
  ]);
  if (
    !freshTask
    || freshTask.status !== 'approved'
    || freshTask.reviewMode !== 'git'
    || freshTask.agentId !== taskNow.agentId
    || freshTask.postApproveRevoked !== undefined
    || entryCompletion?.token !== signalToken
  ) {
    await emitIntervention(bus, taskNow.projectId, taskNow.agentId, taskNow.id, {
      phase: 'post-approve-merge-skipped-stale-task',
    });
    return;
  }

  let freshCompletion = entryCompletion;
  const gitEpisodeKey = postApproveEpisodeKey(freshTask);
  if (!gitEpisodeKey || gitEpisodeKey.token !== signalToken) {
    await emitIntervention(bus, freshTask.projectId, freshTask.agentId, freshTask.id, {
      phase: 'post-approve-merge-skipped-stale-task',
    });
    return;
  }
  await manager.markPostApproveSignalReceived(freshTask.id, gitEpisodeKey);
  const scanFailedRetry = async (error: string): Promise<void> => {
    await manager.updatePostApproveCompletionIfToken(
      freshTask.id,
      signalToken,
      { pendingRedispatch: true },
      { expectedGeneration: gitEpisodeKey.generation, expectedHeadSha: gitEpisodeKey.headSha },
    );
    await emitIntervention(bus, freshTask.projectId, freshTask.agentId, freshTask.id, {
      phase: 'post-approve-merge-skipped-scan-failed',
      error,
    });
  };
  let verified: Awaited<ReturnType<AgentManager['platformVerifyAcceptedPass']>>;
  try {
    verified = await manager.platformVerifyAcceptedPass(freshTask.id);
  } catch (err) {
    await scanFailedRetry(err instanceof Error ? err.message : String(err));
    return;
  }
  if (verified.kind === 'retryable') {
    await scanFailedRetry(verified.reason);
    return;
  }
  if (verified.kind === 'provenance-invalid') {
    const begun = await manager.beginGitReviewPass(freshTask.id, {
      fromStatus: [freshTask.status],
      headSha: gitEpisodeKey.headSha,
      bumpRound: true,
      qaPhase: 'recheck',
      expectPhase: freshTask.phase,
      expectSignalToken: freshTask.signalToken,
      patch: { latestHeadSha: gitEpisodeKey.headSha },
    });
    if (begun?.task.reviewDispatch) {
      try {
        await manager.dispatchGitReviewLease(freshTask.id, {
          expectedGeneration: begun.task.reviewDispatch.generation,
        });
      } catch (err) {
        if (err instanceof DispatchTerminalError && begun.task.qaAgentId) {
          await manager.failTaskForDispatchError(
            freshTask.id,
            'recheck',
            begun.task.qaAgentId,
            err,
            { expectedReviewDispatch: begun.task.reviewDispatch },
          );
          return;
        }
        await emitIntervention(bus, freshTask.projectId, freshTask.agentId, freshTask.id, {
          phase: 'post-approve-provenance-redispatch-failed',
          reason: verified.reason,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return;
  }
  if (verified.pendingCount > 0 && !freshCompletion.pendingRedispatch) {
    if (await manager.updatePostApproveCompletionIfToken(
      freshTask.id,
      signalToken,
      { pendingRedispatch: true },
      { expectedGeneration: gitEpisodeKey.generation, expectedHeadSha: gitEpisodeKey.headSha },
    )) {
      freshCompletion = { ...freshCompletion, pendingRedispatch: true };
    }
  } else if (verified.pendingCount === 0 && freshCompletion.pendingRedispatch) {
    if (await manager.updatePostApproveCompletionIfToken(
      freshTask.id,
      signalToken,
      { pendingRedispatch: false },
      { expectedGeneration: gitEpisodeKey.generation, expectedHeadSha: gitEpisodeKey.headSha },
    )) {
      freshCompletion = { ...freshCompletion, pendingRedispatch: false };
    }
  }
  for (;;) {
    if (freshCompletion.pendingRedispatch) {
      const nextCount = (freshCompletion.redispatchCount ?? 0) + 1;
      if (nextCount > POST_APPROVE_REDISPATCH_CAP) {
        const revoked = await manager.revokePostApproveCompletion(freshTask.id, 'redispatch-cap', {
          expectedToken: freshCompletion.token,
          expectedGeneration: gitEpisodeKey.generation,
          expectedHeadSha: gitEpisodeKey.headSha,
        });
        if (!revoked) {
          // The pass rotated after the entry re-validation; this merge-ready and its cap decision are stale.
          await emitIntervention(bus, taskNow.projectId, taskNow.agentId, taskNow.id, {
            phase: 'post-approve-merge-skipped-stale-task',
          });
          return;
        }
        await emitIntervention(bus, freshTask.projectId, freshTask.agentId, freshTask.id, {
          phase: 'post-approve-redispatch-cap-exceeded',
          redispatchCount: freshCompletion.redispatchCount ?? 0,
          cap: POST_APPROVE_REDISPATCH_CAP,
        });
        return;
      }
      await dispatchGitDevPostApproveCheck(
        bus,
        manager,
        freshTask,
        freshCompletion.approvedHeadSha,
        { redispatchCount: nextCount },
      );
      return;
    }

    const completed = await manager.completeApprovedPassToMergeReady(
      freshTask.id,
      gitEpisodeKey,
    );
    if ('task' in completed) return;
    if (completed.refused === 'pending') {
      const latest = await manager.getPostApproveCompletion(freshTask.id);
      if (latest?.token === signalToken) {
        freshCompletion = latest;
        continue;
      }
    }
    await emitIntervention(bus, taskNow.projectId, taskNow.agentId, taskNow.id, {
      phase: 'post-approve-merge-skipped-stale-task',
    });
    return;
  }
}

async function handlePrFeedback(
  bus: EventBus,
  manager: AgentManager,
  event: BaxianEvent,
): Promise<void> {
  const taskId = event.taskId!;
  const taskNow = await manager.getTask(taskId);
  if (!taskNow || taskNow.reviewMode !== 'git') return;
  const revision = parseGitFeedbackRevision(event.data.revision);
  if (!revision) {
    await emitIntervention(bus, taskNow.projectId, taskNow.agentId, taskNow.id, {
      phase: 'git-feedback-revision-invalid',
    });
    return;
  }
  const revisionKey = ackRevisionKey(revision.sourceKey, revision.id, revision.bodyDigest);
  if (taskNow.consumedFeedback?.[revisionKey] !== undefined) return;
  const revisionTime = revision.versionTime ?? Date.parse(event.timestamp);
  const outcome = await manager.consumeGitFeedbackRevision(
    taskId,
    { key: revisionKey, versionTime: revisionTime },
    { feedbackAt: event.timestamp },
  );
  if (outcome.kind !== 'pending' && outcome.kind !== 'returned') return;
  const effected = outcome.task;
  const completion = await manager.getPostApproveCompletion(effected.id);
  const devState = await manager.getAgentState(effected.agentId);
  if (outcome.kind === 'pending' && completion !== null && devState?.taskId === effected.id) return;
  const nextCount = (effected.redispatchCount ?? completion?.redispatchCount ?? 0) + 1;
  if (nextCount > POST_APPROVE_REDISPATCH_CAP) {
    const key = postApproveEpisodeKey(effected);
    await manager.revokePostApproveCompletion(effected.id, 'redispatch-cap', key
      ? {
          expectedToken: key.token,
          expectedGeneration: key.generation,
          expectedHeadSha: key.headSha,
        }
      : {});
    await emitIntervention(bus, effected.projectId, effected.agentId, effected.id, {
      phase: 'post-approve-redispatch-cap-exceeded',
      redispatchCount: effected.redispatchCount ?? 0,
      cap: POST_APPROVE_REDISPATCH_CAP,
    });
    return;
  }
  const approvedHead = effected.postApproveHeadSha ?? validHeadSha(effected.latestHeadSha);
  if (!approvedHead) {
    await emitIntervention(bus, effected.projectId, effected.agentId, effected.id, {
      phase: 'post-approve-approved-head-unavailable',
    });
    return;
  }
  await dispatchGitDevPostApproveCheck(bus, manager, effected, approvedHead, { redispatchCount: nextCount });
}

export async function recoverGitPostApprovePending(bus: EventBus, manager: AgentManager): Promise<void> {
  const tasks = await manager.listActiveGitTasks();
  for (const task of tasks) {
    try {
      await recoverOneGitPendingTask(bus, manager, task);
    } catch (err) {
      console.warn(`[EventHandler] recoverGitPostApprovePending: task=${task.id} failed, continuing:`, err);
      await emitIntervention(bus, task.projectId, task.agentId, task.id, {
        phase: 'post-approve-recovery-failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function recoverOneGitPendingTask(bus: EventBus, manager: AgentManager, task: TaskState): Promise<void> {
  {
    const live = await manager.getTask(task.id);
    if (!live || live.reviewMode !== 'git' || live.status !== 'approved' || live.pendingRedispatch !== true) return;
    if (live.postApproveRevoked) return;
    const updatedAt = Date.parse(live.updatedAt);
    if (!Number.isFinite(updatedAt)) {
      if (unparseableUpdatedAtWarned.get(live.id) !== live.updatedAt) {
        unparseableUpdatedAtWarned.set(live.id, live.updatedAt);
        console.warn(
          `[EventHandler] recoverGitPostApprovePending: task=${live.id} updatedAt unparseable, skipping recovery:`,
          live.updatedAt,
        );
      }
      return;
    }
    unparseableUpdatedAtWarned.delete(live.id);
    if (Date.now() - updatedAt < POST_APPROVE_RECOVERY_MIN_AGE_MS) return;
    if (live.postApprovePhase === 'delivered') {
      const devState = await manager.getAgentState(live.agentId);
      if (devState?.taskId === live.id) {
        const rearmed = await manager.rearmPostApproveSignal(live.id);
        if (!rearmed) {
          const fresh = await manager.getTask(live.id);
          if (fresh?.status === 'approved'
            && fresh.pendingRedispatch === true
            && fresh.postApprovePhase === 'delivered'
            && fresh.postApproveGeneration === live.postApproveGeneration
            && fresh.postApproveToken === live.postApproveToken) {
            throw new Error(`post-approve signal re-arm refused for active task ${live.id}`);
          }
        }
        return;
      }
    }
    const approvedHead = validHeadSha(live.postApproveHeadSha ?? live.latestHeadSha);
    if (!approvedHead) {
      await emitIntervention(bus, live.projectId, live.agentId, live.id, {
        phase: 'post-approve-approved-head-unavailable',
      });
      return;
    }
    const nextCount = (live.redispatchCount ?? 0) + 1;
    if (nextCount > POST_APPROVE_REDISPATCH_CAP) {
      const key = postApproveEpisodeKey(live);
      await manager.revokePostApproveCompletion(live.id, 'redispatch-cap', key
        ? {
            expectedToken: key.token,
            expectedGeneration: key.generation,
            expectedHeadSha: key.headSha,
          }
        : {});
      await emitIntervention(bus, live.projectId, live.agentId, live.id, {
        phase: 'post-approve-redispatch-cap-exceeded',
        redispatchCount: live.redispatchCount ?? 0,
        cap: POST_APPROVE_REDISPATCH_CAP,
      });
      return;
    }
    await dispatchGitDevPostApproveCheck(bus, manager, live, approvedHead, {
      redispatchCount: nextCount,
      expectedEpisode: postApproveEpisodeKey(live) ?? undefined,
    });
  }
}

async function handlePrCodePush(
  bus: EventBus,
  manager: AgentManager,
  event: BaxianEvent,
): Promise<void> {
  const taskId = event.taskId!;
  const eventPrNumber = event.data.prNumber as number | undefined;
  const eventPrUrl = event.data.prUrl as string | undefined;
  const eventKind = event.data.kind as string | undefined;
  const eventHeadSha = validHeadSha(event.data.headSha);
  const task = await manager.getTask(taskId);
  if (!task || task.reviewMode !== 'git') return;
  if (eventKind === 'push' && eventHeadSha
    && event.data.source !== 'pr-fixed'
    && task.reviewDispatch === undefined
    && task.latestHeadSha === eventHeadSha
    && task.reviewHeadAnchorSha === eventHeadSha) {
    return;
  }
  if (task.status === 'in_progress' && task.prNumber === undefined && eventPrNumber === undefined) {
    console.warn(
      `[EventHandler] pr.updated: task ${taskId} in_progress but neither task nor event has prNumber; deferring catch-up`,
    );
    return;
  }
  if (!PR_UPDATED_REVIEW_FROM_STATUSES.includes(task.status)) return;
  let reviewHead = eventHeadSha ?? validHeadSha(task.latestHeadSha);
  const prNumber = eventPrNumber ?? task.prNumber;
  if (reviewHead === undefined && prNumber !== undefined) {
    const verified = await manager.platformVerifyPrBinding(taskId, prNumber);
    if (verified.ok) reviewHead = validHeadSha(verified.headSha);
  }
  if (reviewHead === undefined) {
    await emitIntervention(bus, task.projectId, task.agentId, taskId, {
      phase: 'git-review-head-unavailable',
    });
    return;
  }

  const bumpRound = task.status === 'in_progress'
    || task.status === 'approved'
    || task.status === 'merge-ready'
    || (task.status === 'review' && task.reviewRoundPending === true);
  const begun = await manager.beginGitReviewPass(taskId, {
    fromStatus: [task.status],
    headSha: reviewHead,
    bumpRound,
    expectPhase: task.phase,
    expectSignalToken: task.signalToken,
    patch: {
      ...(eventPrNumber !== undefined ? { prNumber: eventPrNumber } : {}),
      ...(eventPrUrl !== undefined ? { prUrl: eventPrUrl } : {}),
      latestHeadSha: reviewHead,
    },
  });
  if (!begun?.task.reviewDispatch) {
    const current = await manager.getTask(taskId);
    if (current?.reviewDispatch?.phase === 'uncertain') {
      const qaPhase = current.reviewDispatch.qaPhase;
      await emitIntervention(bus, current.projectId, current.agentId, taskId, {
        phase: 'git-review-dispatch-uncertain',
        qaPhase,
        headSha: reviewHead,
      });
    }
    return;
  }
  const qaPhase = begun.task.reviewDispatch.qaPhase;
  try {
    await manager.dispatchGitReviewLease(taskId, {
      expectedGeneration: begun.task.reviewDispatch.generation,
    });
  } catch (err) {
    console.error(`[EventHandler] pr.updated git review dispatch failed for task=${taskId}:`, err);
    if (err instanceof DispatchTerminalError && err.reason === 'ack_unknown') {
      await emitIntervention(bus, begun.task.projectId, begun.task.agentId, taskId, {
        phase: 'git-review-dispatch-uncertain',
        qaPhase,
        error: err.message,
      });
    } else if (err instanceof DispatchTerminalError && begun.task.qaAgentId) {
      await manager.failTaskForDispatchError(taskId, qaPhase, begun.task.qaAgentId, err, {
        expectedReviewDispatch: begun.task.reviewDispatch,
      });
    } else {
      await emitIntervention(bus, begun.task.projectId, begun.task.agentId, taskId, {
        phase: 'git-review-dispatch-failed',
        qaPhase,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function redispatchReviewForStaleVerdict(
  manager: AgentManager,
  task: TaskState,
): Promise<boolean> {
  if (task.status !== 'review') return false;
  if (task.qaAgentId) {
    // 当前 pass 的 QA 会话还在跑时，迟到的旧 verdict 只是噪音，不能重派打断；
    // 派发期 hold（checkout 未备好）意味着从未开工，等同无会话，可安全重派
    let qaState: Awaited<ReturnType<AgentManager['getAgentState']>>;
    try {
      qaState = await manager.getAgentState(task.qaAgentId);
    } catch (err) {
      // 无状态证据时 fail closed：不自动重派，让调用方落 stale-verdict 兜底介入
      console.warn(
        `[EventHandler] stale-verdict QA state read failed for ${task.qaAgentId}; not redispatching:`,
        err,
      );
      return false;
    }
    if (qaState?.taskId === task.id && !isRecoverableQaDispatchHold(qaState)) return false;
  }
  try {
    // fromStatus/expectSignalToken 在 dispatch 锁内复核：本地快照到这里的窗口里任务可能已离开 review
    // 或被并发 dispatcher 换代 pass，不能靠上面的预检
    const entry = manager.getPendingDispatchRetry(task.id);
    const qaPhase = entry?.kind === 'qa-recheck' && entry.signalToken === task.signalToken && entry.qaPhase !== undefined
      ? entry.qaPhase
      : (task.reviewRound === 0 ? 'review' as const : undefined);
    await manager.dispatchReviewToQa(task.id, {
      fromStatus: ['review'],
      bumpRound: task.reviewRoundPending === true,
      expectPhase: task.phase,
      expectSignalToken: task.signalToken,
      ...(qaPhase !== undefined ? { qaPhase } : {}),
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
  reviewedHeadSha: string,
  currentHeadSha: string,
  prPatch: Partial<Pick<TaskState, 'prNumber' | 'prUrl'>>,
  gitVerdict: GitVerdictPayload,
): Promise<void> {
  if (reviewedHeadSha !== currentHeadSha) {
    await emitIntervention(bus, task.projectId, task.agentId, task.id, {
      phase: 'stale-approval-head-mismatch',
      reviewedHeadSha,
      currentHeadSha,
      source: 'payload-self',
    });
    return;
  }

  if (task.failToken === undefined || task.signalToken === undefined) return;
  const provenance = {
    sourceKey: gitVerdict.carrier.sourceKey,
    id: gitVerdict.carrier.id,
    bodyDigest: gitVerdict.carrier.bodyDigest,
    token: gitVerdict.verdictToken,
    failToken: task.failToken,
    anchorSha: reviewedHeadSha,
  };
  const reviewedRound = Math.max(1, task.reviewRound + (task.reviewRoundPending === true ? 1 : 0));
  const transitioned = await manager.approveGitReviewPass(task.id, {
    expectedSignalToken: task.signalToken,
    headSha: reviewedHeadSha,
    reviewRound: reviewedRound,
    ...(prPatch.prNumber !== undefined ? { prNumber: prPatch.prNumber } : {}),
    ...(prPatch.prUrl !== undefined ? { prUrl: prPatch.prUrl } : {}),
    provenance,
  });
  if (!transitioned) return;

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

  await dispatchGitDevPostApproveCheck(bus, manager, transitioned, reviewedHeadSha);
}

function gitHeadPatch(task: TaskState, headSha: string | undefined): Partial<Pick<TaskState, 'latestHeadSha'>> {
  return headSha !== undefined && task.latestHeadSha !== headSha
    ? { latestHeadSha: headSha }
    : {};
}

async function handleReviewRequestChanges(
  bus: EventBus,
  manager: AgentManager,
  task: TaskState,
  reviewedHeadSha: string,
  currentHeadSha: string,
  prPatch: Partial<Pick<TaskState, 'prNumber' | 'prUrl'>>,
): Promise<void> {
  if (reviewedHeadSha !== currentHeadSha) {
    await emitIntervention(bus, task.projectId, task.agentId, task.id, {
      phase: 'stale-request-changes-head-mismatch',
      reviewedHeadSha,
      currentHeadSha,
      source: 'payload-self',
    });
    return;
  }

  const reviewedRound = Math.max(1, task.reviewRound + (task.reviewRoundPending === true ? 1 : 0));
  const nextRound = reviewedRound + 1;
  if (nextRound > manager.getConfig().review.rounds) {
    return handleMaxRounds(bus, manager, task, prPatch, reviewedRound);
  }

  const result = await manager.transitionTaskStatus(
    task.id,
    'fixing',
    {
      fromStatus: ['review'],
      expectSignalToken: task.signalToken,
    },
    {
      ...prPatch,
      ...gitHeadPatch(task, currentHeadSha),
      reviewRound: nextRound,
      reviewRoundPending: undefined,
      reviewDispatch: undefined,
      fixDispatchedAt: new Date().toISOString(),
    },
  );
  if (!result) return;
  const { task: transitioned } = result;
  await manager.clearPostApproveCompletion(transitioned.id);
  manager.stopPhaseSignalWatcher(transitioned.id);

  if (transitioned.qaAgentId) {
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

  const { token: fixToken, armed } = await manager.rotateAndSetupPhaseSignal(
    transitioned.id,
    transitioned.agentId,
    'pr-fixed',
    { expectedStatus: 'fixing', expectedToken: transitioned.signalToken },
  );

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
    resumed = await manager.continueSession(transitioned.id, transitioned.agentId, 'fix', {
      signalToken: fixToken,
      guardBeforeInject: async () => {
        const freshTask = await manager.getTask(transitioned.id);
        return freshTask?.status === 'fixing' && freshTask.signalToken === fixToken;
      },
    });
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
      const parked = await manager.markAgentWaiting(transitioned.agentId, transitioned.id)
        .catch(err => {
          console.error(
            `[EventHandler] REQUEST_CHANGES markAgentWaiting(dev=${transitioned.agentId}) rollback failed:`,
            err,
          );
          return false;
        });
      if (parked && (dispatchErr instanceof ReplNotReadyError || dispatchErr instanceof DirtyWorkdirError)) {
        // dev 回合在途（忙碌/未提交改动）是常态而非故障：登记待补派，回合结束后由对账 re-continue。
        // 停驻失败说明绑定/锁已不受控，pending 无法证明还有可承接的 session，必须走人工告警
        manager.registerPendingDispatchRetry(transitioned.id, {
          kind: 'dev-fix',
          agentId: transitioned.agentId,
          signalToken: fixToken,
        });
        console.warn(
          `[EventHandler] REQUEST_CHANGES fix deferred for task=${transitioned.id}: dev pane busy or workdir dirty ` +
          `(${dispatchErr.name}); reconciler will re-continue when idle`,
        );
      } else {
        await emitIntervention(bus, transitioned.projectId, transitioned.agentId, transitioned.id, {
          phase: 'fix-resume-failed',
          reviewRound: transitioned.reviewRound,
        });
      }
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
    {
      fromStatus: ['review'],
      expectSignalToken: task.signalToken,
    },
    {
      ...prPatch,
      reviewRound: reviewedRound,
      reviewRoundPending: undefined,
      reviewDispatch: undefined,
    },
  );
  if (!result) return;
  const { task: transitioned } = result;
  await manager.clearPostApproveCompletion(transitioned.id);
  manager.stopPhaseSignalWatcher(transitioned.id);

  if (transitioned.qaAgentId) {
    const qaState = await manager.getAgentState(transitioned.qaAgentId);
    if (qaState?.taskId === transitioned.id) {
      await manager
        .releaseAgentForTask(transitioned.qaAgentId, transitioned.id, 'idle', { allowAwaitingHuman: true })
        .catch(err => {
          console.error(
            `[EventHandler] max_rounds releaseAgentForTask(QA=${transitioned.qaAgentId}) failed:`,
            err,
          );
          return false;
        });
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
    if (!taskAtEntry) return;
    if (taskAtEntry.reviewMode === 'server') {
      const prNumber = event.data.prNumber;
      if (!Number.isInteger(prNumber) || (prNumber as number) < 1) return;
      const adopted = await manager.adoptServerPr(event.taskId, {
        prNumber: prNumber as number,
        ...(typeof event.data.prUrl === 'string' ? { prUrl: event.data.prUrl } : {}),
        ...(validHeadSha(event.data.headSha) !== undefined ? { headSha: validHeadSha(event.data.headSha)! } : {}),
        ...(typeof event.data.targetBranch === 'string' ? { targetBranch: event.data.targetBranch } : {}),
      });
      if (!adopted) {
        await emitIntervention(bus, taskAtEntry.projectId, taskAtEntry.agentId, taskAtEntry.id, {
          phase: 'server-pr-adoption-refused',
          prNumber,
        });
      }
      return;
    }
    if (isSpecStagePhase(taskAtEntry.phase)) {
      console.warn(`[EventHandler] pr.created ignored for task ${event.taskId}: task in spec phase`);
      return;
    }

    if (event.data.source === 'pane-signal'
      && taskAtEntry.prNumber !== undefined && taskAtEntry.prNumber === event.data.prNumber
      && taskAtEntry.status !== 'in_progress') {
      if (taskAtEntry.pendingPrSignalToken === undefined
        || event.data.token !== taskAtEntry.pendingPrSignalToken) {
        return;
      }
      if (taskAtEntry.replyActorStatus !== 'verified') {
        const actorId = typeof event.data.actorB64 === 'string'
          ? decodeSignalActorId(event.data.actorB64)
          : undefined;
        if (actorId === undefined) {
          await manager.rearmGitReconciliationWatcher(taskAtEntry.id, { skipSnapshot: true });
          await emitIntervention(bus, taskAtEntry.projectId, event.agentId, taskAtEntry.id, {
            phase: 'git-pr-created-actor-missing',
            claimedPrNumber: event.data.prNumber as number,
          });
          return;
        }
        await manager.updateTask(taskAtEntry.id, {
          replyActorId: actorId,
          replyActorStatus: 'verified',
          pendingPrSignalToken: undefined,
        });
      }
      if (taskAtEntry.status === 'review') {
        manager.stopPhaseSignalWatcherAgent(taskAtEntry.id, event.agentId);
      }
      return;
    }

    if (event.data.source !== 'pane-signal'
      && taskAtEntry.prNumber !== undefined && taskAtEntry.prNumber === event.data.prNumber
      && !['in_progress', 'fixing'].includes(taskAtEntry.status)) {
      return;
    }

    let paneVerifiedHeadSha: string | undefined;
    let reconciledBranch: string | undefined;
    let verifiedTargetBranch: string | undefined;
    if (event.data.source === 'pane-signal' && event.data.prNumber !== undefined) {
      const prNumber = event.data.prNumber as number;
      try {
        let verify = await manager.platformVerifyPrBinding(event.taskId, prNumber);
        if (!verify.ok && verify.reason === 'branch' && verify.prBranch !== undefined) {
          const taskNow = await manager.getTask(event.taskId);
          const prBranch = verify.prBranch;
          if (taskNow) {
            const ownBranch = BRANCH_PREFIX + event.taskId;
            const foreignBxBranch = prBranch.startsWith(BRANCH_PREFIX) && prBranch !== ownBranch;
            const bound = await manager.findTaskByBranch(prBranch, taskNow.projectId);
            if (!foreignBxBranch && isValidBranchName(prBranch)
              && (prBranch === ownBranch || bound?.id === taskNow.id)) {
              verify = await manager.platformVerifyPrBinding(event.taskId, prNumber, { branchOverride: prBranch });
              if (verify.ok) reconciledBranch = prBranch;
            }
          }
        }
        if (!verify.ok) {
          const taskNow = await manager.getTask(event.taskId);
          console.warn(
            `[EventHandler] pr.created REJECT pane prNumber=${prNumber} for git task ${event.taskId} (${verify.reason})`,
          );
          if (taskNow) {
            await reArmDevelopWatcher(manager, taskNow, event.agentId);
            await emitIntervention(bus, taskNow.projectId, event.agentId, event.taskId, {
              phase: 'pane-pr-created-branch-mismatch',
              claimedPrNumber: prNumber,
              taskBranch: taskNow.branch ?? '',
              reason: verify.reason,
            });
          }
          return;
        }
        paneVerifiedHeadSha = verify.headSha;
        verifiedTargetBranch = verify.targetBranch;
      } catch (err) {
        console.warn(`[EventHandler] pr.created: platformVerifyPrBinding failed for task ${event.taskId}:`, err);
        const taskNow = await manager.getTask(event.taskId);
        if (taskNow) {
          await reArmDevelopWatcher(manager, taskNow, event.agentId);
          await emitIntervention(bus, taskNow.projectId, event.agentId, event.taskId, {
            phase: 'pane-pr-created-verify-error',
            claimedPrNumber: prNumber,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
    }

    const task = await manager.getTask(event.taskId);
    if (!task || task.reviewMode !== 'git') return;
    if (event.data.source !== 'pane-signal'
      && task.branch !== BRANCH_PREFIX + event.taskId
      && task.prNumber !== event.data.prNumber) {
      console.warn(
        `[EventHandler] pr.created: ignoring poller-sourced PR ${event.data.prNumber} on custom branch ` +
        `for task ${event.taskId} (untracked; custom-branch PRs adopt via the pane signal)`,
      );
      return;
    }

    const adoption: Partial<Pick<TaskState,
      'baseBranch' | 'replyActorId' | 'replyActorStatus' | 'pendingPrSignalToken'>> = {};
    const target = event.data.source === 'pane-signal'
      ? verifiedTargetBranch
      : (typeof event.data.targetBranch === 'string' ? event.data.targetBranch : undefined);
    if (target !== undefined && task.baseBranch === undefined) adoption.baseBranch = target;
    if (event.data.source === 'pane-signal') {
      const actorId = typeof event.data.actorB64 === 'string'
        ? decodeSignalActorId(event.data.actorB64)
        : undefined;
      if (actorId !== undefined) {
        adoption.replyActorId = actorId;
        adoption.replyActorStatus = 'verified';
        adoption.pendingPrSignalToken = undefined;
      }
    } else if (typeof event.data.prAuthorId === 'string' && task.replyActorStatus !== 'verified') {
      adoption.replyActorId = event.data.prAuthorId;
      adoption.replyActorStatus = 'provisional';
    }

    let reviewHead = validHeadSha(event.data.headSha) ?? paneVerifiedHeadSha;
    if (reviewHead === undefined && typeof event.data.prNumber === 'number') {
      const verified = await manager.platformVerifyPrBinding(event.taskId, event.data.prNumber);
      if (verified.ok) reviewHead = validHeadSha(verified.headSha);
    }
    if (reviewHead === undefined) {
      await emitIntervention(bus, task.projectId, task.agentId, event.taskId, {
        phase: 'git-review-head-unavailable',
      });
      return;
    }

    if (task.status !== 'in_progress' && task.status !== 'fixing') return;
    const begun = await manager.beginGitReviewPass(event.taskId, {
      fromStatus: [task.status],
      headSha: reviewHead,
      bumpRound: task.status === 'in_progress',
      qaPhase: 'review',
      expectPhase: task.phase,
      expectSignalToken: task.signalToken,
      patch: {
        ...(event.data.prNumber !== undefined ? { prNumber: event.data.prNumber as number } : {}),
        ...(event.data.prUrl !== undefined ? { prUrl: event.data.prUrl as string } : {}),
        latestHeadSha: reviewHead,
        ...(reconciledBranch ? { branch: reconciledBranch } : {}),
        ...adoption,
      },
    });
    if (!begun?.task.reviewDispatch) {
      console.warn(`[EventHandler] pr.created: cannot begin git review pass for task ${event.taskId}`);
      if (event.data.source === 'pane-signal') {
        const current = await manager.getTask(event.taskId);
        if (current && ['in_progress', 'fixing'].includes(current.status)) {
          await reArmDevelopWatcher(manager, current, event.agentId);
          await emitIntervention(bus, current.projectId, event.agentId, event.taskId, {
            phase: 'pane-pr-created-transition-failed',
            claimedPrNumber: event.data.prNumber as number,
            taskBranch: current.branch ?? '',
          });
        }
      }
      return;
    }
    if (reconciledBranch) {
      console.log(
        `[EventHandler] pr.created reconciled branch for task ${event.taskId}: ${task.branch} → ${reconciledBranch}`,
      );
    }
    if (!begun.task.qaAgentId) {
      const parked = await manager.markAgentWaiting(event.agentId, begun.task.id);
      if (!parked) {
        await emitIntervention(bus, begun.task.projectId, begun.task.agentId, begun.task.id, {
          phase: 'dev-wait-gate-failed-no-qa',
        });
      }
      await emitIntervention(bus, begun.task.projectId, begun.task.agentId, begun.task.id, {
        phase: 'git-review-no-qa-partner',
      });
      return;
    }
    try {
      await manager.dispatchGitReviewLease(begun.task.id, {
        expectedGeneration: begun.task.reviewDispatch.generation,
      });
    } catch (err) {
      console.error(`[EventHandler] pr.created git review dispatch failed for task=${begun.task.id}:`, err);
      if (err instanceof DispatchTerminalError && err.reason === 'ack_unknown') {
        await emitIntervention(bus, begun.task.projectId, begun.task.agentId, begun.task.id, {
          phase: 'git-review-dispatch-uncertain',
          qaPhase: 'review',
          error: err.message,
        });
      } else if (err instanceof DispatchTerminalError) {
        await manager.failTaskForDispatchError(begun.task.id, 'review', begun.task.qaAgentId, err, {
          expectedReviewDispatch: begun.task.reviewDispatch,
        });
      } else {
        await emitIntervention(bus, begun.task.projectId, begun.task.agentId, begun.task.id, {
          phase: 'git-review-dispatch-failed',
          qaPhase: 'review',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });

  bus.on('pr.updated', async (event) => {
    if (!event.taskId) return;
    const taskAtEntry = await manager.getTask(event.taskId);

    const eventKind = event.data.kind as
      | 'push' | 'comment' | 'review-comment' | 'pr-merge-ready'
      | 'closed-unmerged' | 'reopened' | undefined;

    if (taskAtEntry && isSpecStagePhase(taskAtEntry.phase)) {
      console.warn(
        `[EventHandler] pr.updated (kind=${eventKind ?? 'push'}) ignored for task ${event.taskId}: task in spec phase`,
      );
      return;
    }

    if (eventKind === 'pr-merge-ready') return handlePrMergeReady(bus, manager, event);
    if (eventKind === 'closed-unmerged' || eventKind === 'reopened') {
      const prNumber = event.data.prNumber;
      if (typeof prNumber !== 'number') return;
      if (eventKind === 'closed-unmerged') await manager.recordClosedUnmergedAnchor(event.taskId, prNumber);
      else await manager.clearClosedUnmergedAnchor(event.taskId, prNumber);
      await manager.deliverTaskOutbox(event.taskId);
      return;
    }
    if (!event.agentId) return;
    if (taskAtEntry?.reviewMode === 'server') return;
    if (eventKind === 'comment' || eventKind === 'review-comment') {
      return handlePrFeedback(bus, manager, event);
    }
    if (eventKind === 'push' || eventKind === undefined) return handlePrCodePush(bus, manager, event);
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
    if (isSpecStagePhase(taskBefore.phase)) return;
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

    const task = await manager.getTask(event.taskId);
    if (!task) return;
    if (task.reviewMode === 'server') return;
    if (event.data.source === 'pane-signal') {
      console.log(
        `[EventHandler] review.submitted pane verdict ignored for task ${task.id} (comment-token protocol is the sole authority)`,
      );
      return;
    }
    const verdictTask = task;
    const rejectGitPayload = async (err: GitVerdictPayloadError): Promise<void> => {
      await emitIntervention(bus, verdictTask.projectId, verdictTask.agentId, verdictTask.id, {
        phase: 'git-verdict-payload-invalid',
        error: err.message,
        ...(typeof event.data.source === 'string' ? { source: event.data.source } : {}),
      });
    };
    let gitPayload: GitVerdictPayload;
    try {
      gitPayload = parseGitVerdictPayload(event.data);
    } catch (err) {
      if (!(err instanceof GitVerdictPayloadError)) throw err;
      await rejectGitPayload(err);
      return;
    }
    const action = gitPayload.action;
    if (task.signalToken === undefined || gitPayload.reviewPassToken !== task.signalToken) {
      if (task.status !== 'review') {
        await rejectGitPayload(new GitVerdictPayloadError('review pass token is not current'));
        return;
      }
      if (!(await redispatchReviewForStaleVerdict(manager, task))) {
        await emitIntervention(bus, task.projectId, task.agentId, task.id, {
          phase: 'stale-verdict-wrong-pass',
          action,
          verdictPassToken: gitPayload.reviewPassToken,
          currentToken: task.signalToken,
          source: 'poller',
        });
      }
      return;
    }
    const expectedVerdictToken = action === 'APPROVE' ? task.passToken : task.failToken;
    if (expectedVerdictToken === undefined || gitPayload.verdictToken !== expectedVerdictToken
      || task.failToken === undefined) {
      await rejectGitPayload(new GitVerdictPayloadError('verdict token is not current'));
      return;
    }

    if (isSpecStagePhase(task.phase)) {
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

    const prPatch: Partial<Pick<TaskState, 'prNumber' | 'prUrl'>> = {
      ...(gitPayload.prNumber !== task.prNumber ? { prNumber: gitPayload.prNumber } : {}),
      ...(gitPayload.prUrl !== task.prUrl ? { prUrl: gitPayload.prUrl } : {}),
    };
    const reviewedHeadSha = gitPayload.headSha;
    const currentHeadSha = gitPayload.currentHeadSha;

    if (task.status !== 'review') {
      await rejectGitPayload(new GitVerdictPayloadError(`task is ${task.status}, not review`));
      return;
    }

    if (action === 'APPROVE') {
      return handleReviewApproval(bus, manager, task, reviewedHeadSha, currentHeadSha, prPatch, gitPayload);
    }
    if (action === 'REQUEST_CHANGES') {
      return handleReviewRequestChanges(bus, manager, task, reviewedHeadSha, currentHeadSha, prPatch);
    }
  });

  bus.on('pr.fix.submitted', async (event) => {
    if (!event.taskId || !event.agentId) return;
    const task = await manager.getTask(event.taskId);
    if (!task || task.reviewMode === 'server' || task.status !== 'fixing' || isSpecStagePhase(task.phase)) return;
    const { projectId, agentId } = task;

    const stayFixing = async (data: { phase: string; [key: string]: unknown }): Promise<void> => {
      await emitIntervention(bus, projectId, agentId, task.id, data);
      const fresh = await manager.getTask(task.id);
      if (!fresh || fresh.status !== 'fixing' || fresh.signalToken !== task.signalToken) return;
      await manager.setupPhaseSignal(task.id, agentId, 'pr-fixed', {
        skipSnapshot: true,
        replaceScope: 'agent',
      });
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

    if (task.prNumber === undefined) {
      await stayFixing({ phase: 'fix-verify-no-anchor' });
      return;
    }
    let verify: Awaited<ReturnType<AgentManager['platformVerifyPrBinding']>>;
    try {
      verify = await manager.platformVerifyPrBinding(task.id, task.prNumber);
    } catch (err) {
      await stayFixing({
        phase: 'fix-verify-head-fetch-failed',
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (!verify.ok) {
      // PR 在修复期间被关闭/转 draft/retarget：推进 recheck 只会造出无裁决入口的评审轮
      await stayFixing({ phase: 'fix-verify-binding-mismatch', reason: verify.reason });
      return;
    }
    const headSha = verify.headSha;

    if (!task.reviewHeadAnchorSha) {
      await stayFixing({ phase: 'fix-verify-no-anchor', headSha });
      return;
    }

    if (headSha === task.reviewHeadAnchorSha) {
      let pendingCount: number;
      try {
        pendingCount = (await manager.platformPendingFeedback(task.id)).pending.size;
      } catch (err) {
        await stayFixing({
          phase: 'fix-verify-replies-fetch-failed',
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      if (pendingCount > 0) {
        await stayFixing({
          phase: 'fix-no-op-pending-feedback',
          pendingCount,
          note: 'Dev emitted pr-fixed on an unchanged head while feedback revisions still lack a valid ack. Inspect the PR replies.',
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
