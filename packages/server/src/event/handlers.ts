import { createSignalToken, decodeSignalActorId, type PhaseSignalKind } from '../agent/phase-signal.js';
import { ackRevisionKey } from '../platform/markers.js';
import { SHA_HEX_SOURCE } from '../platform/types.js';
import {
  BRANCH_PREFIX,
  TASK_TERMINAL_STATUS_SET,
  isRecord,
  isSpecStagePhase,
  isValidBranchName,
  type BaxianEvent,
  type TaskState,
} from '../shared/index.js';
import type { EventBus } from './bus.js';
import { type AgentManager, DispatchTerminalError, EnsureSessionError, isRecoverableQaDispatchHold } from '../agent/manager.js';
import { ReplNotReadyError } from '../agent/tmux.js';
import { DirtyWorkdirError } from '../agent/branch.js';

type InterventionData = Record<string, unknown> & { phase: string };
// 平台 SHA 文法单点（spec §5.3：7-64 位 hex）；legacy github 值恒 40 位，放宽为 additive
const HEAD_SHA_RE = new RegExp(`^${SHA_HEX_SOURCE}$`);

function validHeadSha(value: unknown): string | undefined {
  return typeof value === 'string' && HEAD_SHA_RE.test(value) ? value : undefined;
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
    if (task.reviewMode === 'git') {
      // durable retry 锚：acquire 失败发生在 completion 安装前，无 pending 则 sweep 永远看不到
      await manager.updateTask(task.id, { pendingRedispatch: true }).catch(() => undefined);
    }
    await emitIntervention(bus, task.projectId, task.agentId, task.id, {
      phase: 'post-approve-dev-acquire-failed',
      devAgentId: task.agentId,
    });
    return;
  }

  // Persisted after acquire and only while still approved: a stale write would forge rebuild evidence.
  const headPersisted = await manager.updateTaskIfStatus(task.id, 'approved', {
    postApproveHeadSha: approvedHeadSha,
  }, { signalToken: task.signalToken, reviewRound: task.reviewRound });
  if (!headPersisted) {
    await manager.markAgentWaiting(task.agentId, task.id)
      .catch(err => {
        console.error(
          `[EventHandler] post-approve head persist refused for task=${task.id}; release failed:`,
          err,
        );
      });
    return;
  }

  const signalToken = createSignalToken();
  const installed = await manager.setPostApproveCompletion(
    task.id,
    {
      token: signalToken,
      approvedHeadSha,
      ...(typeof opts.redispatchCount === 'number' ? { redispatchCount: opts.redispatchCount } : {}),
      // 'git' 至少一次投递（spec §6）：pending 随安装保持，continueSession 确认后才清——
      // 安装与注入之间的崩溃由恢复扫描按 pending 补派
      ...(task.reviewMode === 'git' ? { pendingRedispatch: true } : {}),
    },
    // A fresh human verdict unlocks a standing revocation; automated redispatches never do.
    { clearRevocation: typeof opts.redispatchCount !== 'number' },
  );
  if (!installed) {
    await manager.markAgentWaiting(task.agentId, task.id)
      .catch(err => {
        console.error(
          `[EventHandler] post-approve install refused by revocation for task=${task.id}; release failed:`,
          err,
        );
      });
    return;
  }

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
  if (resumed) {
    if (task.reviewMode === 'git') await manager.confirmPostApprovePromptDelivered(task.id, signalToken);
    return;
  }

  // git：未确认送达的失败保留 installed+pending 交 sweep 补派（DispatchTerminalError 单独终结）；
  // legacy 维持清除语义
  if (task.reviewMode !== 'git' || dispatchErr instanceof DispatchTerminalError) {
    await manager.clearPostApproveCompletionIfMatches(task.id, signalToken);
  }

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

  const [freshTask, entryCompletion] = await Promise.all([
    manager.getTask(taskNow.id),
    manager.getPostApproveCompletion(taskNow.id),
  ]);
  if (
    !freshTask
    || freshTask.status !== 'approved'
    || freshTask.agentId !== taskNow.agentId
    || freshTask.postApproveRevoked !== undefined
    || entryCompletion?.token !== signalToken
    || freshTask.postApproveHeadSha === undefined
    || entryCompletion.approvedHeadSha !== freshTask.postApproveHeadSha
  ) {
    await emitIntervention(bus, taskNow.projectId, taskNow.agentId, taskNow.id, {
      phase: 'post-approve-merge-skipped-stale-task',
    });
    return;
  }

  // 'git' merge-ready 接收即 server 权威双复核（spec §6/§10：provenance + ack 完成集，同一次全源扫描）：
  // agent 自查是尽责而非授权
  let freshCompletion = entryCompletion;
  if (freshTask.reviewMode === 'git') {
    // 信号已消费（token 已验证）：durable 记录 signaled——瞬态复核失败时 dev 不会重发信号，
    // 恢复/sweep 凭此相位重派而不是等一个不会再来的信号
    await manager.markPostApproveSignalReceived(freshTask.id, signalToken);
    const scanFailedRetry = async (error: string): Promise<void> => {
      await manager.updatePostApproveCompletionIfToken(freshTask.id, signalToken, { pendingRedispatch: true });
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
    if (!verified.ok) {
      if (verified.reason === 'source scan incomplete') {
        await scanFailedRetry(verified.reason);
        return;
      }
      // pass 已被撤销/编辑（确定性失效）：拒绝迁移滞留 approved，交人工重派评审（spec §6 merge 条）
      await emitIntervention(bus, freshTask.projectId, freshTask.agentId, freshTask.id, {
        phase: 'post-approve-merge-skipped-provenance',
        reason: verified.reason,
      });
      return;
    }
    if (verified.pendingCount > 0 && !freshCompletion.pendingRedispatch) {
      if (await manager.updatePostApproveCompletionIfToken(freshTask.id, signalToken, { pendingRedispatch: true })) {
        freshCompletion = { ...freshCompletion, pendingRedispatch: true };
      }
    } else if (verified.pendingCount === 0 && freshCompletion.pendingRedispatch) {
      // 权威扫描为空即清 stale pending：dev 已在本轮内补齐 ack，不再白派一轮
      if (await manager.updatePostApproveCompletionIfToken(freshTask.id, signalToken, { pendingRedispatch: false })) {
        freshCompletion = { ...freshCompletion, pendingRedispatch: false };
      }
    }
  }
  // A pending flag landing between the check and the transition re-enters here instead of losing the feedback.
  for (;;) {
    if (freshCompletion.pendingRedispatch) {
      const nextCount = (freshCompletion.redispatchCount ?? 0) + 1;
      if (nextCount > POST_APPROVE_REDISPATCH_CAP) {
        const revoked = await manager.revokePostApproveCompletion(freshTask.id, 'redispatch-cap', {
          expectedToken: freshCompletion.token,
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
      await dispatchDevPostApproveCheck(
        bus,
        manager,
        freshTask,
        freshCompletion.approvedHeadSha,
        { redispatchCount: nextCount },
      );
      return;
    }

    const completed = await manager.completeApprovedPassToMergeReady(freshTask.id, signalToken);
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
  if (!taskNow) return;
  const eventPrNumber = event.data.prNumber as number | undefined;
  const eventPrUrl = event.data.prUrl as string | undefined;
  const eventKind = event.data.kind as string | undefined;
  const isNewFeedback = eventKind === 'comment' || eventKind === 'review-comment';
  const revision = taskNow.reviewMode === 'git' && isRecord(event.data.revision)
    ? event.data.revision as { sourceKey: string; id: string; bodyDigest: string; versionTime?: number }
    : undefined;
  const revisionKey = revision ? ackRevisionKey(revision.sourceKey, revision.id, revision.bodyDigest) : undefined;
  const revisionTime = typeof revision?.versionTime === 'number' ? revision.versionTime : Date.parse(event.timestamp);
  // 消费幂等（spec §6）：ledger 落盘前崩溃的重投在此收敛，redispatch 计数不重复生效
  if (revisionKey !== undefined && taskNow.consumedFeedback?.[revisionKey] !== undefined) return;
  const prPatch: Partial<Pick<TaskState, 'prNumber' | 'prUrl'>> = {
    ...(eventPrNumber !== undefined ? { prNumber: eventPrNumber } : {}),
    ...(eventPrUrl !== undefined ? { prUrl: eventPrUrl } : {}),
  };
  // 消费与效果由 manager 的单一锁内状态机决定（spec §6）：merge-ready→退回+pending、approved→
  // pending、其它→仅消费——入口快照与提交之间的并发迁移（completeApprovedPass 等）不再能让
  // revision 既被 poller 记 delivered 又不产生效果
  if (taskNow.reviewMode === 'git' && isNewFeedback && revisionKey !== undefined) {
    const outcome = await manager.consumeGitFeedbackRevision(
      taskId,
      { key: revisionKey, versionTime: revisionTime },
      { feedbackAt: event.timestamp },
    );
    if (outcome.kind !== 'pending' && outcome.kind !== 'returned') return;
    const effected = outcome.task;
    const completion = await manager.getPostApproveCompletion(effected.id);
    const devState = await manager.getAgentState(effected.agentId);
    if (outcome.kind === 'pending' && completion !== null && devState?.taskId === effected.id) {
      // 在途 pass 会经 merge-ready 循环消化 pending；无 completion 的 durable pending 由下方补派
      return;
    }
    const nextCount = (effected.redispatchCount ?? completion?.redispatchCount ?? 0) + 1;
    if (nextCount > POST_APPROVE_REDISPATCH_CAP) {
      await manager.revokePostApproveCompletion(effected.id, 'redispatch-cap');
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
    await dispatchDevPostApproveCheck(bus, manager, effected, approvedHead, { redispatchCount: nextCount });
    return;
  }
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

  let completion = await manager.getPostApproveCompletion(taskNow.id);
  if (!completion) {
    await emitIntervention(bus, taskNow.projectId, taskNow.agentId, taskNow.id, {
      phase: 'post-approve-approved-head-unavailable',
    });
    return;
  }
  // Rotated successors are installed under a head CAS, so only the entry snapshot needs this proof.
  if (
    taskNow.postApproveHeadSha === undefined
    || completion.approvedHeadSha !== taskNow.postApproveHeadSha
  ) {
    await emitIntervention(bus, taskNow.projectId, taskNow.agentId, taskNow.id, {
      phase: 'post-approve-completion-episode-mismatch',
    });
    return;
  }
  // Every CAS miss below means the completion rotated mid-flight; re-decide against the live pass so the feedback is never dropped.
  for (;;) {
    const devState = await manager.getAgentState(taskNow.agentId);
    if (devState?.taskId === taskNow.id) {
      if (completion.pendingRedispatch) {
        // pending 已立不改效果，但本条 revision 的消费键仍须落盘：崩溃后重投不得再计一轮
        if (revisionKey !== undefined) {
          await manager.updatePostApproveCompletionIfToken(taskNow.id, completion.token, {},
            { consumeRevision: { key: revisionKey, versionTime: revisionTime } });
        }
        const fresh = await manager.getPostApproveCompletion(taskNow.id);
        // Same token: the pending mark is already on the live pass.
        if (!fresh || fresh.token === completion.token) return;
        completion = fresh;
        continue;
      }
      if (await manager.updatePostApproveCompletionIfToken(taskNow.id, completion.token, {
        pendingRedispatch: true,
      }, revisionKey !== undefined ? { consumeRevision: { key: revisionKey, versionTime: revisionTime } } : {})) return;
      const fresh = await manager.getPostApproveCompletion(taskNow.id);
      // Same token: refused in place (revoked marker) — the successor fixing flow owns this feedback.
      if (!fresh || fresh.token === completion.token) return;
      completion = fresh;
      continue;
    }
    if (taskNow.reviewMode === 'git' && revisionKey !== undefined) {
      if (await manager.updatePostApproveCompletionIfToken(taskNow.id, completion.token, {
        pendingRedispatch: true,
      }, { consumeRevision: { key: revisionKey, versionTime: revisionTime } })) {
        completion = { ...completion, pendingRedispatch: true };
      } else {
        const fresh = await manager.getPostApproveCompletion(taskNow.id);
        if (!fresh || fresh.token === completion.token) return;
        completion = fresh;
        continue;
      }
    }
    const nextCount = (completion.redispatchCount ?? 0) + 1;
    if (nextCount > POST_APPROVE_REDISPATCH_CAP) {
      const revoked = await manager.revokePostApproveCompletion(taskNow.id, 'redispatch-cap', {
        expectedToken: completion.token,
      });
      if (!revoked) {
        const fresh = await manager.getPostApproveCompletion(taskNow.id);
        if (!fresh || fresh.token === completion.token) return;
        completion = fresh;
        continue;
      }
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
    return;
  }
}

// 恢复期消费 durable pendingRedispatch（spec §6 至少一次）：merge-ready 退回或 path C 的 CAS
// 落盘后、派发前崩溃的残局在此补派；dev 仍绑定任务时不派（其在途 pass 的 merge-ready 循环接手）。
export async function recoverGitPostApprovePending(bus: EventBus, manager: AgentManager): Promise<void> {
  const tasks = await manager.listActiveGitTasks();
  for (const task of tasks) {
    try {
      await recoverOneGitPendingTask(bus, manager, task);
    } catch (err) {
      // 单任务失败不得饿死其后的 durable pending（至少一次）：报告并继续
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
    if (task.status !== 'approved' || task.pendingRedispatch !== true) return;
    if (task.postApproveRevoked) return;
    if (task.postApprovePhase === 'delivered') {
      const devState = await manager.getAgentState(task.agentId);
      if (devState?.taskId === task.id) {
        // prompt 已送达且尚未回信号（dev 在跑）：补派会向运行中的会话注入第二个 prompt 并轮换
        // token——只重臂 watcher 等信号，pending 由 merge-ready 循环消化
        await manager.rearmPostApproveSignal(task.id).catch(() => false);
        return;
      }
    }
    const approvedHead = validHeadSha(task.postApproveHeadSha ?? task.latestHeadSha);
    if (!approvedHead) {
      await emitIntervention(bus, task.projectId, task.agentId, task.id, {
        phase: 'post-approve-approved-head-unavailable',
      });
      return;
    }
    const nextCount = (task.redispatchCount ?? 0) + 1;
    if (nextCount > POST_APPROVE_REDISPATCH_CAP) {
      await manager.revokePostApproveCompletion(task.id, 'redispatch-cap');
      await emitIntervention(bus, task.projectId, task.agentId, task.id, {
        phase: 'post-approve-redispatch-cap-exceeded',
        redispatchCount: task.redispatchCount ?? 0,
        cap: POST_APPROVE_REDISPATCH_CAP,
      });
      return;
    }
    await dispatchDevPostApproveCheck(bus, manager, task, approvedHead, { redispatchCount: nextCount });
  }
}

async function releaseQaAfterSkippedRollback(
  manager: AgentManager,
  taskId: string,
  qaId: string,
  logPrefix: string,
  ownAcquire: { expectedLockToken?: string } = {},
): Promise<void> {
  const now = await manager.getTask(taskId);
  if (now && !TASK_TERMINAL_STATUS_SET.has(now.status)) {
    // pass 被并发接管：QA 已被接管方 re-acquire，释放会误清其绑定；
    // 但本次派发的 arm 可能已顶掉接管方的 watcher（start 先 stop 同 task 旧 watcher），按当前 pass 重建
    console.warn(`${logPrefix} rollback skipped for task=${taskId}: pass superseded`);
    await manager.rearmPhaseSignalForCurrentPass(taskId);
    return;
  }
  // 终态/已删：没有接管方持有这只 QA，而 cancel 清理可能没见到刚写入的 qaAgentId。
  // 仍钉住本次 acquire 世代——本 handler 的每一条失败释放都只清自己那一代
  await manager.releaseAgentForTask(qaId, taskId, 'idle', ownAcquire).catch(err => {
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
  // 'git' push 重投收敛（spec §6 生命周期幂等）：同 head 的评审轮已派发过，重放在任何后继态
  // 都是有害动作（QA 释放/令牌轮换/计轮/撤销 approval），恰一次由 TaskState 锚判定。
  // pr-fixed 合成 push 豁免——no-code fix 的 recheck 派发正是靠同 head 重入（spec §7 同 head 复检）。
  if (taskBeforeTransition.reviewMode === 'git' && eventKind === 'push' && eventHeadSha
    && event.data.source !== 'pr-fixed'
    && taskBeforeTransition.reviewDispatchPending !== true
    && taskBeforeTransition.latestHeadSha === eventHeadSha
    && taskBeforeTransition.reviewHeadAnchorSha === eventHeadSha) {
    return;
  }
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
      // 这些起点的轮次在 prompt 确认送达后才计（consumeReviewRoundIntent）；持久化「未计」意图，
      // 供 busy pending/可恢复 hold/进程重启后的任何补派方恰好补计一次
      reviewRoundPending: (taskBeforeTransition.status === 'in_progress'
        || taskBeforeTransition.status === 'approved'
        || taskBeforeTransition.status === 'merge-ready') ? true
        : (taskBeforeTransition.status === 'review' ? taskBeforeTransition.reviewRoundPending : undefined),
      // pair 与新轮可见性原子（spec §7）：transition 后到 rotate 的窗口内旧 pair 不得授权本轮
      ...(taskBeforeTransition.reviewMode === 'git'
        ? { ...manager.mintReviewTokenPair(), reviewDispatchPending: true }
        : {}),
    },
  );
  if (!result) return;
  const { task: transitioned, previousStatus } = result;
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

  // review 起点且首评从未送达（round=0 + 未计轮 intent 在场）仍是首评：不得换成 recheck prompt/skill
  const deferredFirstReview = previousStatus === 'review'
    && taskBeforeTransition.reviewRound === 0
    && taskBeforeTransition.reviewRoundPending === true;
  const qaPhase: 'review' | 'recheck' =
    previousStatus === 'in_progress' || deferredFirstReview ? 'review' : 'recheck';

  if (previousStatus === 'review' && transitioned.qaAgentId) {
    const released = await manager
      .releaseAgentForTask(transitioned.qaAgentId, transitioned.id, 'idle', { deferWhenBusy: true })
      .catch(err => {
        console.error(
          `[EventHandler] pr.updated releaseAgentForTask(QA=${transitioned.qaAgentId}) for review→review push failed:`,
          err,
        );
        return false;
      });
    if (!released) {
      // 忙碌拒绝的形状：QA 仍绑定本任务且未落 hold（release 对 REPL 忙碌不再写 hold）。
      // 这是「欠一次投递」而非故障：登记 pending，由对账在 pane 空闲后按标准入口补派
      const qaAfter = await manager.getAgentState(transitioned.qaAgentId).catch(() => null);
      const deferrable = qaAfter?.taskId === transitioned.id && qaAfter.status !== 'awaiting_human';
      if (deferrable && transitioned.signalToken !== undefined) {
        manager.registerPendingDispatchRetry(transitioned.id, {
          kind: 'qa-recheck',
          agentId: transitioned.qaAgentId,
          signalToken: transitioned.signalToken,
          qaPhase,
        });
        console.warn(
          `[EventHandler] pr.updated QA ${qaPhase} deferred for task=${transitioned.id}: QA still busy on the ` +
          `previous turn; reconciler will redispatch when idle`,
        );
        return;
      }
      await emitIntervention(bus, transitioned.projectId, transitioned.agentId, transitioned.id, {
        phase: 'qa-release-failed-cannot-recheck',
        qaAgentId: transitioned.qaAgentId,
      });
      return;
    }
  }

  const qaId = transitioned.qaAgentId;
  if (!qaId) {
    if (!devAlreadyWaiting && !(await manager.markAgentWaiting(agentId, transitioned.id))) {
      await emitIntervention(bus, transitioned.projectId, transitioned.agentId, transitioned.id, {
        phase: 'dev-wait-gate-failed-no-qa',
      });
    }
    return;
  }
  const qa = manager.getAgentConfig(qaId);
  if (!qa || qa.role !== 'qa') {
    if (!devAlreadyWaiting) await manager.markAgentWaiting(agentId, transitioned.id).catch(() => false);
    await emitIntervention(bus, transitioned.projectId, transitioned.agentId, transitioned.id, {
      phase: 'qa-config-missing',
      qaAgentId: qaId,
    });
    return;
  }

  // 锁代由 acquire 原子交出（事后重读只会读到 successor 的代）：派发放弃时只释放自己这一代，
  // successor 若已重新 acquire 同一 QA（同 task 同 agent，绕过 release 的 taskId 校验）不得被误清
  let ownLockToken: string | undefined;
  const acquired = await manager.acquireAgentForTask(qa.id, transitioned.id, qaPhase, {
    onAcquired: (lockToken) => { ownLockToken = lockToken; },
  });
  if (!acquired) {
    await emitIntervention(bus, transitioned.projectId, transitioned.agentId, transitioned.id, {
      phase: 'qa-acquire-failed',
      qaAgentId: qa.id,
      qaPhase,
    });
    return;
  }
  const ownAcquire = ownLockToken !== undefined ? { expectedLockToken: ownLockToken } : {};

  const { token: dispatchToken, armed } = await manager.rotateAndSetupPhaseSignal(
    transitioned.id,
    qa.id,
    ['pr-approved', 'pr-changes-requested'] as const,
  );
  if (!armed) {
    console.warn(
      `[EventHandler] pr.updated verdict watcher failed to arm for task=${transitioned.id} (${qaPhase}); rolling back recheck dispatch`,
    );
    if (previousStatus === 'in_progress' || previousStatus === 'fixing'
      || (previousStatus === 'review' && taskBeforeTransition.reviewMode === 'git')) {
      const rolledBack = await manager.rollbackVerdictArmFailure(transitioned.id, {
        status: previousStatus,
        signalToken: taskBeforeTransition.signalToken,
        reviewHeadAnchorSha: taskBeforeTransition.reviewHeadAnchorSha,
        reviewDispatchedAt: taskBeforeTransition.reviewDispatchedAt,
        // git 回滚保留 durable pending 供 sweep 重试：计轮 intent 必须同持（transition 写入值），
        // 否则最终送达的首评按 stale intent 少计一轮
        reviewRoundPending: taskBeforeTransition.reviewMode === 'git'
          ? transitioned.reviewRoundPending
          : taskBeforeTransition.reviewRoundPending,
        ...(taskBeforeTransition.reviewMode === 'git'
          ? { restorePair: true, passToken: taskBeforeTransition.passToken, failToken: taskBeforeTransition.failToken }
          : {}),
      }, { expect: { status: 'review', signalToken: dispatchToken }, rearmSkipSnapshot });
      if (!rolledBack) {
        await releaseQaAfterSkippedRollback(manager, transitioned.id, qa.id, '[EventHandler] pr.updated arm-failure', ownAcquire);
        return;
      }
    }
    await manager.releaseAgentForTask(qa.id, transitioned.id, 'idle', ownAcquire).catch(err => {
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
    started = await manager.startSession(transitioned.id, qa.id, qaPhase, {
      dispatchPassToken: dispatchToken,
    });
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
    } else if (dispatchErr instanceof EnsureSessionError && dispatchErr.partial.busyPending) {
      // 遇忙不是故障：pass 保持 armed、QA 保持绑定，pending 登记已在 startSession 内完成，交对账补派
      console.warn(
        `[EventHandler] pr.updated QA ${qaPhase} deferred for task=${transitioned.id}: QA pane busy; ` +
        `reconciler will redispatch when idle`,
      );
    } else if (dispatchErr instanceof EnsureSessionError && dispatchErr.partial.handled) {
      // handled 不止代表可恢复派发 hold（checkout-cleanup-failed / dialog 等也走这里），指引须按实际相位分流
      const qaState = await manager.getAgentState(qa.id).catch((stateErr: unknown) => {
        console.warn(`[EventHandler] pr.updated could not read held QA state for ${qa.id}:`, stateErr);
        return null;
      });
      const heldPhase = qaState?.status === 'awaiting_human' ? qaState.awaitingPhase : undefined;
      const note = isRecoverableQaDispatchHold(qaState)
        ? 'QA dispatch was held awaiting human; the task keeps the rotated review pass. Resume the QA agent or POST /tasks/:id/review to redispatch.'
        : `QA dispatch was held awaiting human (${heldPhase ?? 'hold not persisted'}); this hold is not auto-redispatchable — inspect the QA agent's awaiting reason, resolve it, then redispatch via POST /tasks/:id/review.`;
      await emitIntervention(bus, transitioned.projectId, transitioned.agentId, transitioned.id, {
        phase: 'qa-dispatch-held-awaiting-human',
        qaAgentId: qa.id,
        qaPhase,
        ...(heldPhase !== undefined ? { awaitingPhase: heldPhase } : {}),
        note,
      });
    } else if (previousStatus === 'in_progress' || previousStatus === 'fixing'
      || (previousStatus === 'review' && taskBeforeTransition.reviewMode === 'git')) {
      // 仅回滚 status 会留下 transition 轮换后的 token，dev 在途 pass 的完成信号将永久失配；
      // startSession 窗口内 pass 可能已被并发接管，此时回滚与 QA 释放都要让位于接管方
      const rolledBack = await manager.rollbackVerdictArmFailure(transitioned.id, {
        status: previousStatus,
        signalToken: taskBeforeTransition.signalToken,
        reviewHeadAnchorSha: taskBeforeTransition.reviewHeadAnchorSha,
        reviewDispatchedAt: taskBeforeTransition.reviewDispatchedAt,
        // git 保留 durable pending 即保留计轮 intent（同 arm-failure 站点）
        reviewRoundPending: taskBeforeTransition.reviewMode === 'git'
          ? transitioned.reviewRoundPending
          : taskBeforeTransition.reviewRoundPending,
        ...(taskBeforeTransition.reviewMode === 'git'
          ? { restorePair: true, passToken: taskBeforeTransition.passToken, failToken: taskBeforeTransition.failToken }
          : {}),
      }, { expect: { status: 'review', signalToken: dispatchToken }, rearmSkipSnapshot });
      if (rolledBack) {
        await manager.releaseAgentForTask(qa.id, transitioned.id, 'idle', ownAcquire)
          .catch(err => {
            console.error(
              `[EventHandler] pr.updated releaseAgentForTask(QA=${qa.id}) after start-not-true failed:`,
              err,
            );
            return false;
          });
      } else {
        await releaseQaAfterSkippedRollback(manager, transitioned.id, qa.id, '[EventHandler] pr.updated recheck', ownAcquire);
      }
    } else {
      await manager.releaseAgentForTask(qa.id, transitioned.id, 'idle', ownAcquire)
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

  if (taskBeforeTransition.reviewMode === 'git') {
    await manager.clearReviewDispatchPending(transitioned.id, dispatchToken);
  }
  // 送达确认后按本次 pass CAS 消费未计轮 intent：flag 本身已编码「哪些起点开新轮」
  // （review→review 的既计轮 recheck 无 flag 即天然 no-op），successor 换代则留给它自己消费
  await manager.consumeReviewRoundIntent(transitioned.id, dispatchToken);

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
  reviewedHeadSha: string | undefined,
  currentHeadSha: string | undefined,
  prPatch: Partial<Pick<TaskState, 'prNumber' | 'prUrl'>>,
  gitVerdict?: { token: string; carrier: { sourceKey: string; id: string; bodyDigest: string } },
): Promise<void> {
  if (!reviewedHeadSha) {
    await emitIntervention(bus, task.projectId, task.agentId, task.id, {
      phase: 'approval-reviewed-head-unavailable',
    });
    return;
  }

  // 'git' 载荷已经 engine 端 fresh prView 复核（spec §7 handler 收紧）：二次解析的缓存回退
  // 链会重新打开 engine 已关闭的竞态，跳过
  const anchor = task.reviewMode === 'git'
    ? { headSha: currentHeadSha ?? reviewedHeadSha, source: 'payload-self' as const }
    : await resolveAuthoritativeHead(manager, task, { payloadCurrentHeadSha: currentHeadSha });
  // git 的 head 更新并入下方带 expectSignalToken 的 transition：入口校验后并发 push 换代时，
  // 旧 verdict 的裸 updateTask 会把 successor 的 latestHeadSha 覆写回旧值
  if (anchor.source === 'fetch' && anchor.headSha && task.latestHeadSha !== anchor.headSha) {
    await manager.updateTask(task.id, { latestHeadSha: anchor.headSha });
  }
  if (anchor.headSha && reviewedHeadSha !== anchor.headSha) {
    await emitIntervention(bus, task.projectId, task.agentId, task.id, {
      phase: 'stale-approval-head-mismatch',
      reviewedHeadSha,
      currentHeadSha: anchor.headSha,
      source: anchor.source,
      ...('fetchError' in anchor && anchor.fetchError ? { fetchError: anchor.fetchError } : {}),
    });
    return;
  }

  const provenanceFields: Partial<TaskState> =
    task.reviewMode === 'git' && gitVerdict !== undefined && task.failToken !== undefined
      ? {
          passProvenance: {
            sourceKey: gitVerdict.carrier.sourceKey,
            id: gitVerdict.carrier.id,
            bodyDigest: gitVerdict.carrier.bodyDigest,
            token: gitVerdict.token,
            failToken: task.failToken,
            anchorSha: reviewedHeadSha,
          },
        }
      : {};
  const result = await manager.transitionTaskStatus(
    task.id,
    'approved',
    {
      fromStatus: ['review'],
      // 校验后提交前的并发换代（push/重派轮换 token+pair）使旧 APPROVE 失效（spec §7）
      ...(task.reviewMode === 'git' ? { expectSignalToken: task.signalToken } : {}),
    },
    {
      ...prPatch,
      ...provenanceFields,
      ...gitHeadPatch(task, anchor.headSha),
      // 崩溃在「prompt 已送达、bump 未落盘」窗口时 pending 轮次由 verdict 消费补计
      reviewRound: Math.max(1, task.reviewRound + (task.reviewRoundPending === true ? 1 : 0)),
      reviewRoundPending: undefined,
      // verdict 即送达证据：durable pending 随 transition 原子消费，封死「送达后 verdict 抢先、
      // startSession 的 clear 因 status/token 已变而拒绝」留下 stale 凭据的竞态
      reviewDispatchPending: undefined,
    },
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

function gitHeadPatch(task: TaskState, headSha: string | undefined): Partial<Pick<TaskState, 'latestHeadSha'>> {
  return task.reviewMode === 'git' && headSha !== undefined && task.latestHeadSha !== headSha
    ? { latestHeadSha: headSha }
    : {};
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
  const anchor = task.reviewMode === 'git'
    ? { headSha: currentHeadSha ?? reviewedHeadSha, source: 'payload-self' as const }
    : await resolveAuthoritativeHead(manager, task, {
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
      ...('fetchError' in anchor && anchor.fetchError ? { fetchError: anchor.fetchError } : {}),
    });
    return;
  }

  const reviewedRound = Math.max(1, task.reviewRound + (task.reviewRoundPending === true ? 1 : 0));
  const nextRound = reviewedRound + 1;
  if (task.status === 'approved' && nextRound <= manager.getConfig().review.rounds) {
    const devState = await manager.getAgentState(task.agentId);
    const postApproveActive = await manager.getPostApproveCompletion(task.id);
    if (devState?.taskId === task.id && postApproveActive) {
      let revoked = await manager.revokePostApproveCompletion(task.id, 'request-changes', {
        expectedToken: postApproveActive.token,
      });
      if (!revoked) {
        // Token rotation within the episode still gets blocked; a successor approved episode (fresh head) must not.
        revoked = await manager.revokePostApproveCompletion(task.id, 'request-changes', {
          expectedHeadSha: postApproveActive.approvedHeadSha,
        });
      }
      await emitIntervention(bus, task.projectId, task.agentId, task.id, {
        phase: 'request-changes-during-post-approve',
        devAgentId: task.agentId,
        note: revoked
          ? 'Dev is still running post-approve check; fix dispatch deferred to avoid prompt collision. PostApproveCompletion cleared to block auto-merge. Operator: wait for post-approve signal to complete, then re-trigger REQUEST_CHANGES manually or cancel the task.'
          : 'Dev is still running post-approve check and the task moved past the reviewed approved episode before the block could apply; the verdict belongs to a superseded pass. Re-trigger REQUEST_CHANGES if it still applies, or cancel the task.',
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
    {
      fromStatus: ['review', 'approved', 'merge-ready'],
      // fail 方向同样按入口代际 CAS（spec §7）：await 窗口内 push/重派换代后旧 RC 不得推进新轮
      ...(task.reviewMode === 'git' ? { expectSignalToken: task.signalToken } : {}),
    },
    {
      ...prPatch,
      ...gitHeadPatch(task, anchor.headSha),
      reviewRound: nextRound,
      reviewRoundPending: undefined,
      // verdict 即送达证据（同 APPROVE）：不消费会让 sweep 在 fixing 态按 stale pending 把任务拽回 review
      reviewDispatchPending: undefined,
      fixDispatchedAt: new Date().toISOString(),
    },
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

  const { token: fixToken, armed } = await manager.rotateAndSetupPhaseSignal(transitioned.id, transitioned.agentId, 'pr-fixed');

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
      fromStatus: ['review', 'approved', 'merge-ready'],
      ...(task.reviewMode === 'git' ? { expectSignalToken: task.signalToken } : {}),
    },
    { ...prPatch, reviewRound: reviewedRound, reviewRoundPending: undefined, reviewDispatchPending: undefined },
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
    if (taskAtEntry?.reviewMode === 'server') return;
    if (taskAtEntry && isSpecStagePhase(taskAtEntry.phase)) {
      console.warn(
        `[EventHandler] pr.created ignored for task ${event.taskId}: task in spec phase`,
      );
      return;
    }

    const isGit = taskAtEntry?.reviewMode === 'git';

    // 迟到 publish 信号只做 actor reconciliation（spec §5.3 ④）：poller 已抢先收编、任务不在
    // 可收编态时，同 prNumber + reconciliation token 归位 replyActor，随后拆 dev 侧条目、不动 QA。
    // fixing 也归 reconciliation：同 prNumber 的迟到信号在 fix 轮重收编会把任务拽回 review、
    // 孤儿化 dev 的 fix 会话——非 in_progress 的同号信号只承载 actor 归位（spec §5.3 ④）
    if (isGit && taskAtEntry && event.data.source === 'pane-signal'
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
          // watcher 单发已被本事件消费：不重臂就永失 reconciliation 入口。skipSnapshot=true
          // 只等待后续正确的五段信号，避免滚动区里同一条三段残文立即重触发成环
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
      // fixing 态同键 watcher 已是 pr-fixed：拆掉会吞掉本轮完成信号，reconciliation 条目只存在于 review
      if (taskAtEntry.status === 'review') {
        manager.stopPhaseSignalWatcherAgent(taskAtEntry.id, event.agentId);
      }
      return;
    }

    if (isGit && taskAtEntry && event.data.source !== 'pane-signal'
      && taskAtEntry.prNumber !== undefined && taskAtEntry.prNumber === event.data.prNumber
      && taskAtEntry.reviewDispatchPending !== true
      && !['in_progress', 'fixing'].includes(taskAtEntry.status)) {
      // in_progress/fixing 或派发未完成（pending）的同号重放走完整收编重试（至少一次）
      return;
    }

    let paneVerifiedHeadSha: string | undefined;
    let reconciledBranch: string | undefined;
    let gitVerifiedTargetBranch: string | undefined;
    if (isGit && event.data.source === 'pane-signal' && event.data.prNumber !== undefined) {
      const prNumber = event.data.prNumber as number;
      try {
        let verify = await manager.platformVerifyPrBinding(event.taskId, prNumber);
        if (!verify.ok && verify.reason === 'branch' && verify.prBranch !== undefined) {
          const taskNow = await manager.getTask(event.taskId);
          const prBranch = verify.prBranch;
          if (taskNow) {
            const ownPrefix = BRANCH_PREFIX + event.taskId;
            const isForeignBxBranch = prBranch.startsWith(BRANCH_PREFIX) && prBranch !== ownPrefix;
            const bound = await manager.findTaskByBranch(prBranch, taskNow.projectId);
            if (!isForeignBxBranch && isValidBranchName(prBranch)
              && (prBranch === ownPrefix || (!!bound && bound.id === taskNow.id))) {
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
        gitVerifiedTargetBranch = verify.targetBranch;
      } catch (err) {
        console.warn(
          `[EventHandler] pr.created: platformVerifyPrBinding failed for task ${event.taskId}:`,
          err,
        );
        const taskNow = await manager.getTask(event.taskId);
        if (taskNow) {
          // skipSnapshot 缺省 true：滚动区里刚消费的信号残文在平台持续失败时会形成无退避热循环
          await reArmDevelopWatcher(manager, taskNow, event.agentId);
          await emitIntervention(bus, taskNow.projectId, event.agentId, event.taskId, {
            phase: 'pane-pr-created-verify-error',
            claimedPrNumber: prNumber,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
    } else if (event.data.source === 'pane-signal' && event.data.prNumber !== undefined) {
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
    const gitAdoptionFields: Partial<TaskState> = {};
    if (isGit) {
      const target = event.data.source === 'pane-signal'
        ? gitVerifiedTargetBranch
        : (typeof event.data.targetBranch === 'string' ? event.data.targetBranch : undefined);
      // baseBranch 快照一经写入不可变（spec §6）：默认分支后续改名不影响既有任务
      if (target !== undefined && taskBeforeTransition?.baseBranch === undefined) {
        gitAdoptionFields.baseBranch = target;
      }
      if (event.data.source === 'pane-signal') {
        const actorId = typeof event.data.actorB64 === 'string'
          ? decodeSignalActorId(event.data.actorB64)
          : undefined;
        if (actorId !== undefined) {
          gitAdoptionFields.replyActorId = actorId;
          gitAdoptionFields.replyActorStatus = 'verified';
          gitAdoptionFields.pendingPrSignalToken = undefined;
        }
      } else if (typeof event.data.prAuthorId === 'string'
        && taskBeforeTransition?.replyActorStatus !== 'verified') {
        // 自动收编只落 provisional：PR 作者可能是对已推送 head 抢建 PR 的第三方（spec §5.3 ④）
        gitAdoptionFields.replyActorId = event.data.prAuthorId;
        gitAdoptionFields.replyActorStatus = 'provisional';
      }
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
        ...gitAdoptionFields,
        reviewDispatchedAt: new Date().toISOString(),
        reviewRoundPending: taskBeforeTransition?.status === 'in_progress' ? true : undefined,
        signalToken: createSignalToken(),
        ...(isGit ? { ...manager.mintReviewTokenPair(), reviewDispatchPending: true } : {}),
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
    const qaId = transitioned.qaAgentId;
    if (!qaId) {
      const ok = await manager.markAgentWaiting(event.agentId, transitioned.id);
      if (!ok) {
        await emitIntervention(bus, transitioned.projectId, transitioned.agentId, transitioned.id, {
          phase: 'dev-wait-gate-failed-no-qa',
        });
      }
      return;
    }
    const qa = manager.getAgentConfig(qaId);
    if (!qa || qa.role !== 'qa') {
      await manager.markAgentWaiting(event.agentId, transitioned.id).catch(() => false);
      await emitIntervention(bus, transitioned.projectId, transitioned.agentId, transitioned.id, {
        phase: 'qa-config-missing',
        qaAgentId: qaId,
      });
      return;
    }

    let ownLockToken: string | undefined;
    const acquired = await manager.acquireAgentForTask(qa.id, transitioned.id, 'review', {
      onAcquired: (lockToken) => { ownLockToken = lockToken; },
    });
    if (!acquired) {
      await emitIntervention(bus, transitioned.projectId, transitioned.agentId, transitioned.id, {
        phase: 'qa-acquire-failed',
        qaAgentId: qa.id,
      });
      return;
    }
    const ownAcquire = ownLockToken !== undefined ? { expectedLockToken: ownLockToken } : {};

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
        // git 保留 durable pending 即保留计轮 intent（同 pr.updated 回滚站点）
        reviewRoundPending: taskBeforeTransition?.reviewMode === 'git'
          ? transitioned.reviewRoundPending
          : taskBeforeTransition?.reviewRoundPending,
        ...(taskBeforeTransition?.reviewMode === 'git'
          ? { restorePair: true, passToken: taskBeforeTransition.passToken, failToken: taskBeforeTransition.failToken }
          : {}),
      }, { expect: { status: 'review', signalToken: dispatchToken } });
      if (!rolledBack) {
        await releaseQaAfterSkippedRollback(manager, transitioned.id, qa.id, '[EventHandler] pr.created arm-failure', ownAcquire);
        return;
      }
      await manager.releaseAgentForTask(qa.id, transitioned.id, 'idle', ownAcquire).catch(err => {
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
      started = await manager.startSession(transitioned.id, qa.id, 'review', {
        dispatchPassToken: dispatchToken,
      });
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
        await manager.releaseAgentForTask(qa.id, transitioned.id, 'idle', ownAcquire)
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

    if (taskBeforeTransition?.reviewMode === 'git') {
      await manager.clearReviewDispatchPending(transitioned.id, dispatchToken);
    }
    await manager.consumeReviewRoundIntent(transitioned.id, dispatchToken);

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
      | 'push' | 'comment' | 'review-comment' | 'pr-edit' | 'pr-merge-ready'
      | 'closed-unmerged' | 'reopened' | undefined;

    if (taskAtEntry && isSpecStagePhase(taskAtEntry.phase)) {
      console.warn(
        `[EventHandler] pr.updated (kind=${eventKind ?? 'push'}) ignored for task ${event.taskId}: task in spec phase`,
      );
      return;
    }

    if (eventKind === 'pr-merge-ready') return handlePrMergeReady(bus, manager, event);
    // closed-unmerged/reopened 只由 PlatformPoller 对 'git' 任务合成（spec §6 outbox 协议）
    if (eventKind === 'closed-unmerged' || eventKind === 'reopened') {
      const prNumber = event.data.prNumber;
      if (typeof prNumber !== 'number') return;
      if (eventKind === 'closed-unmerged') await manager.recordClosedUnmergedAnchor(event.taskId, prNumber);
      else await manager.clearClosedUnmergedAnchor(event.taskId, prNumber);
      // 无条件投递：滞留的 outbox 条目借重复观察重试，而不是等到重启（spec §6 至少一次）
      await manager.deliverTaskOutbox(event.taskId);
      return;
    }
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

    const action = event.data.action as 'APPROVE' | 'REQUEST_CHANGES' | string;
    let task = await manager.getTask(event.taskId);
    if (!task) return;
    if (task.reviewMode === 'server') return;
    // 'git' 唯一裁决授权是评论配对令牌（spec §7）：pane verdict 恒拒绝，命中只记日志
    if (task.reviewMode === 'git' && event.data.source === 'pane-signal') {
      console.log(
        `[EventHandler] review.submitted pane verdict ignored for git task ${task.id} (comment-token protocol is the sole authority)`,
      );
      return;
    }

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

    const carrier = event.data.verdictCarrier as { sourceKey: string; id: string; bodyDigest: string } | undefined;
    const gitVerdict = task.reviewMode === 'git'
      && typeof event.data.verdictToken === 'string' && carrier !== undefined
      ? { token: event.data.verdictToken, carrier }
      : undefined;
    // 'git' 的裁决只信任 engine 载荷：reviewPassToken（评审轮绑定）与 verdict 令牌（评论对绑定）
    // 都必须在场且属当前轮——缺失即绕过 signalToken 门的 malformed 事件，fail closed
    if (task.reviewMode === 'git' && (action === 'APPROVE' || action === 'REQUEST_CHANGES')) {
      const expectedToken = action === 'APPROVE' ? task.passToken : task.failToken;
      const roundToken = typeof event.data.reviewPassToken === 'string' ? event.data.reviewPassToken : undefined;
      if (gitVerdict === undefined || expectedToken === undefined || task.failToken === undefined
        || gitVerdict.token !== expectedToken
        || roundToken === undefined || task.signalToken === undefined || roundToken !== task.signalToken) {
        console.warn(
          `[EventHandler] review.submitted ${action} rejected for git task ${task.id}: verdict payload missing or not the current round token`,
        );
        await emitIntervention(bus, task.projectId, task.agentId, task.id, {
          phase: 'git-verdict-payload-invalid',
          action,
          hasCarrier: gitVerdict !== undefined,
        });
        return;
      }
    }
    if (action === 'APPROVE') {
      return handleReviewApproval(bus, manager, task, reviewedHeadSha, currentHeadSha, prPatch, gitVerdict);
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
      // 同代 fence：平台查询等待期间任务可能已被手动重派进 review——旧失败分支不得覆盖
      // successor 的 QA/reconciliation watcher
      const fresh = await manager.getTask(task.id);
      if (!fresh || fresh.status !== 'fixing' || fresh.signalToken !== task.signalToken) return;
      await manager.setupPhaseSignal(task.id, agentId, 'pr-fixed', {
        skipSnapshot: true,
        ...(fresh.reviewMode === 'git' ? { replaceScope: 'agent' as const } : {}),
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

    let headSha: string;
    if (task.reviewMode === 'git') {
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
      headSha = verify.headSha;
    } else {
      try {
        headSha = await fetchVerifiedHeadSha(manager, task.id);
      } catch (err) {
        await stayFixing({
          phase: 'fix-verify-head-fetch-failed',
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
    }

    if (!task.reviewHeadAnchorSha) {
      await stayFixing({ phase: 'fix-verify-no-anchor', headSha });
      return;
    }

    if (headSha === task.reviewHeadAnchorSha) {
      if (task.reviewMode === 'git') {
        // no-op fix 通过条件 = 无未 ack 的待处理反馈 revision 且全源拉取成功（spec §6/§8）；
        // 墙钟比较与「任意评论计回复」在 'git' 均废除
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
      } else {
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
