import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type {
  StreamClientMsg,
  StreamServerMsg,
  StreamSubMode,
  TerminalInterventionPhase,
} from '../shared/index.js';
import {
  extractTokenFromProtocols,
  isAllowedOrigin,
  sanitizePtySize,
} from './ws-auth.js';
import { sanitizeWebInput } from './key-sanitizer.js';

let ptyModule: typeof import('node-pty') | null = null;
try {
  ptyModule = await import('node-pty');
} catch {
}

interface SubState {
  agentId: string;
  mode: StreamSubMode;
  phase: 'pending' | 'active' | 'released';
  releaseFullHold?: () => void;
}

interface AgentEntry {
  unsubscribe: () => void;
  refcount: number;
}

const NOOP_UNSUB = () => undefined;

export async function streamWsPlugin(app: FastifyInstance): Promise<void> {
  app.get(
    '/stream',
    {
      websocket: true,
      preValidation: async (request: FastifyRequest, reply: FastifyReply) => {
        const origin = request.headers.origin as string | undefined;
        const host = request.headers.host as string | undefined;
        if (!isAllowedOrigin(origin, host)) {
          return reply.status(403).send({ error: 'cross_origin_rejected' });
        }
        const configToken = app.ctx.config.server.token;
        if (configToken) {
          const protoHeader = request.headers['sec-websocket-protocol'] as
            | string
            | string[]
            | undefined;
          const supplied = extractTokenFromProtocols(protoHeader);
          if (supplied !== configToken) {
            return reply.status(401).send({ error: 'unauthorized' });
          }
        }
        if (!ptyModule) {
          return reply.status(503).send({ error: 'pty_unavailable' });
        }
      },
    },
    (socket, request) => handleConnection(app, socket, request),
  );
}

function handleConnection(
  app: FastifyInstance,
  socket: import('@fastify/websocket').WebSocket,
  request: FastifyRequest,
): void {
  const subs = new Map<string, SubState>();
  const agentSubs = new Map<string, AgentEntry>();

  function safeSend(msg: StreamServerMsg): void {
    if (socket.readyState !== socket.OPEN) return;
    try {
      socket.send(JSON.stringify(msg));
    } catch (err) {
      console.warn('[stream-ws] send failed (likely client closed):', err);
    }
  }

  function releaseSub(subscriberId: string): void {
    const s = subs.get(subscriberId);
    if (!s || s.phase === 'released') return;
    s.phase = 'released';
    subs.delete(subscriberId);
    try {
      s.releaseFullHold?.();
    } catch (err) {
      console.warn('[stream-ws] releaseFullHold failed:', err);
    }
    s.releaseFullHold = undefined;
    const entry = agentSubs.get(s.agentId);
    if (entry && --entry.refcount <= 0) {
      try {
        entry.unsubscribe();
      } catch (err) {
        console.warn('[stream-ws] streamer.unsubscribe failed:', err);
      }
      agentSubs.delete(s.agentId);
    }
  }

  async function handleSubscribe(
    subscriberId: string,
    agentId: string,
    mode: StreamSubMode,
  ): Promise<void> {
    if (subs.has(subscriberId)) {
      safeSend({
        type: 'error',
        subscriberId,
        code: 'duplicate_subscriber_id',
        message: `subscriberId ${subscriberId} already exists; client must keep ids unique`,
      });
      return;
    }
    if (!app.ctx.agentManager.getAgentConfig(agentId)) {
      safeSend({
        type: 'error',
        subscriberId,
        code: 'unknown_agent',
        message: `agent ${agentId} not found in current config`,
      });
      return;
    }

    const subState: SubState = { agentId, mode, phase: 'pending' };
    subs.set(subscriberId, subState);

    let agentEntry = agentSubs.get(agentId);
    let isCreator = false;
    if (!agentEntry) {
      agentEntry = { unsubscribe: NOOP_UNSUB, refcount: 1 };
      agentSubs.set(agentId, agentEntry);
      isCreator = true;
    } else {
      agentEntry.refcount++;
    }

    try {
      const psm = app.ctx.paneStreamerManager;
      if (!psm) {
        releaseSub(subscriberId);
        safeSend({
          type: 'error',
          subscriberId,
          code: 'streamer_unavailable',
          message: 'PaneStreamerManager not configured on this server',
        });
        return;
      }
      const agent = app.ctx.agentManager.getAgentConfig(agentId)!;
      const streamer = psm.ensure(agent);

      let snapshot: { cols: number; rows: number; data: string };
      let snapshotSeq: number;
      let installUnsub: (() => void) | null = null;

      if (isCreator) {
        const result = await streamer.subscribeAtomic({
          onLive: (data, seq) =>
            safeSend({ type: 'data', agentId, data, seq }),
          onSessionGone: () => {
            safeSend({ type: 'session_gone', agentId });
            for (const [sid, s] of [...subs]) {
              if (s.agentId === agentId) releaseSub(sid);
            }
          },
          // Server-side geometry changes (external attach follow, spawn baseline,
          // mixed full+preview resize) re-baseline previews; full subscribers keep
          // their own resize/ack contract and must not receive these.
          onSnapshotRefresh: (snapshot, seq) => {
            for (const [sid, s] of subs) {
              if (s.agentId !== agentId || s.mode !== 'preview' || s.phase !== 'active') continue;
              safeSend({
                type: 'snapshot',
                subscriberId: sid,
                cols: snapshot.cols,
                rows: snapshot.rows,
                data: snapshot.data,
                snapshotSeq: seq,
              });
            }
          },
        });
        snapshot = result.snapshot;
        snapshotSeq = result.snapshotSeq;
        installUnsub = result.unsubscribe;
      } else {
        const result = await streamer.getSnapshotAtomic();
        snapshot = result.snapshot;
        snapshotSeq = result.snapshotSeq;
      }

      if (subState.phase === 'released') {
        if (isCreator && installUnsub) {
          const live = agentSubs.get(agentId);
          if (live === agentEntry && agentEntry.refcount > 0) {
            agentEntry.unsubscribe = installUnsub;
          } else {
            try {
              installUnsub();
            } catch (err) {
              console.warn('[stream-ws] post-cancel unsub failed:', err);
            }
          }
        }
        return;
      }

      if (isCreator && installUnsub) {
        agentEntry.unsubscribe = installUnsub;
      }
      subState.phase = 'active';
      if (mode === 'full') {
        subState.releaseFullHold = streamer.acquireFullHold();
      }
      safeSend({
        type: 'snapshot',
        subscriberId,
        cols: snapshot.cols,
        rows: snapshot.rows,
        data: snapshot.data,
        snapshotSeq,
      });
      safeSend({
        type: 'subscribed',
        subscriberId,
        agentId,
        cols: snapshot.cols,
        rows: snapshot.rows,
        snapshotSeq,
      });
      if (mode === 'full') {
        void emitIntervention(app, agentId, 'attach');
      }
    } catch (err) {
      releaseSub(subscriberId);
      let code = 'subscribe_failed';
      if (err instanceof Error) {
        const msg = err.message.toLowerCase();
        if (msg.includes('tmux_too_old')) code = 'tmux_too_old';
        else if (
          msg.includes("can't find session") ||
          msg.includes('session not found') ||
          msg.includes('no such session') ||
          msg.includes('session_not_found') ||
          msg.includes('no session')
        ) {
          code = 'session_not_found';
        }
      }
      safeSend({
        type: 'error',
        subscriberId,
        code,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function handleInput(subscriberId: string, data: string): void {
    const sub = subs.get(subscriberId);
    if (!sub) {
      safeSend({
        type: 'error',
        subscriberId,
        code: 'unknown_subscriber',
        message: 'no active subscription with this subscriberId',
      });
      return;
    }
    if (sub.phase !== 'active') {
      safeSend({
        type: 'error',
        subscriberId,
        code: 'subscriber_not_ready',
        message: `subscriber ${subscriberId} not yet active (phase=${sub.phase}); wait for 'subscribed' ack before sending input`,
      });
      return;
    }
    if (sub.mode !== 'full') {
      safeSend({
        type: 'error',
        subscriberId,
        code: 'input_not_allowed_in_preview',
        message: 'input is only allowed for mode=full subscriptions',
      });
      return;
    }
    const psm = app.ctx.paneStreamerManager;
    if (!psm) {
      safeSend({
        type: 'error',
        subscriberId,
        code: 'streamer_unavailable',
        message: 'PaneStreamerManager not configured',
      });
      return;
    }
    const safeData = sanitizeWebInput(data);
    if (safeData.length === 0) return;
    const submitted = safeData.includes('\r') || safeData.includes('\n');
    if (submitted) {
      void emitIntervention(app, sub.agentId, 'input');
    }
    psm.enqueueInput(sub.agentId, safeData).then(() => {
      // Clear the need-input badge only once the answer actually reached the pane;
      // a failed write must keep telling the user the question is still open.
      if (!submitted) return;
      app.ctx.agentManager.notifyHumanTerminalInput(sub.agentId).catch((err: unknown) => {
        console.warn(`[stream-ws] notifyHumanTerminalInput(${sub.agentId}) failed:`, err);
      });
    }).catch((err) => {
      console.warn(
        `[stream-ws] enqueueInput(${sub.agentId}) failed:`,
        err,
      );
      safeSend({
        type: 'error',
        subscriberId,
        agentId: sub.agentId,
        code: 'input_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    });
  }

  async function handleResize(
    subscriberId: string,
    rawCols: unknown,
    rawRows: unknown,
  ): Promise<void> {
    const sub = subs.get(subscriberId);
    if (!sub) return;
    if (sub.phase !== 'active') {
      safeSend({
        type: 'error',
        subscriberId,
        code: 'subscriber_not_ready',
        message: `subscriber ${subscriberId} not yet active (phase=${sub.phase}); wait for 'subscribed' ack before sending resize`,
      });
      return;
    }
    if (sub.mode !== 'full') {
      safeSend({
        type: 'error',
        subscriberId,
        code: 'resize_not_allowed_in_preview',
        message: 'resize is only allowed for mode=full subscriptions',
      });
      return;
    }
    const cols = sanitizePtySize(rawCols);
    const rows = sanitizePtySize(rawRows);
    if (cols === null || rows === null) {
      safeSend({
        type: 'error',
        subscriberId,
        code: 'invalid_size',
        message: `cols/rows must be positive integers <= 65535 (got cols=${String(rawCols)}, rows=${String(rawRows)})`,
      });
      return;
    }
    const psm = app.ctx.paneStreamerManager;
    if (!psm || !psm.has(sub.agentId)) {
      safeSend({
        type: 'error',
        subscriberId,
        agentId: sub.agentId,
        code: 'streamer_unavailable',
        message: 'no active streamer for this agent',
      });
      return;
    }
    try {
      const agent = app.ctx.agentManager.getAgentConfig(sub.agentId)!;
      const streamer = psm.ensure(agent);
      await streamer.resize(cols, rows);
    } catch (err) {
      safeSend({
        type: 'error',
        subscriberId,
        code: 'resize_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  socket.on('message', async (raw: { toString(): string }) => {
    let msg: StreamClientMsg;
    try {
      msg = JSON.parse(raw.toString()) as StreamClientMsg;
    } catch {
      safeSend({
        type: 'error',
        code: 'invalid_message',
        message: 'failed to parse JSON',
      });
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof (msg as { op?: unknown }).op !== 'string') {
      safeSend({
        type: 'error',
        code: 'invalid_message',
        message: 'message must be an object with `op: string`',
      });
      return;
    }
    const m = msg as unknown as Record<string, unknown>;
    const isStr = (v: unknown): v is string => typeof v === 'string';
    const isNum = (v: unknown): v is number => typeof v === 'number';
    switch (msg.op) {
      case 'subscribe': {
        if (!isStr(m.subscriberId) || !isStr(m.agentId) || (m.mode !== 'preview' && m.mode !== 'full')) {
          safeSend({ type: 'error', code: 'invalid_message', message: 'subscribe requires { subscriberId: string, agentId: string, mode: "preview"|"full" }' });
          return;
        }
        await handleSubscribe(m.subscriberId, m.agentId, m.mode);
        break;
      }
      case 'unsubscribe': {
        if (!isStr(m.subscriberId)) {
          safeSend({ type: 'error', code: 'invalid_message', message: 'unsubscribe requires { subscriberId: string }' });
          return;
        }
        const sub = subs.get(m.subscriberId);
        const shouldEmitDetach = sub?.mode === 'full' && sub.phase === 'active';
        const agentId = sub?.agentId;
        releaseSub(m.subscriberId);
        if (shouldEmitDetach && agentId) void emitIntervention(app, agentId, 'detach');
        break;
      }
      case 'input': {
        if (!isStr(m.subscriberId) || !isStr(m.data)) {
          safeSend({ type: 'error', code: 'invalid_message', message: 'input requires { subscriberId: string, data: string }' });
          return;
        }
        handleInput(m.subscriberId, m.data);
        break;
      }
      case 'resize': {
        if (!isStr(m.subscriberId) || !isNum(m.cols) || !isNum(m.rows)) {
          safeSend({ type: 'error', code: 'invalid_message', message: 'resize requires { subscriberId: string, cols: number, rows: number }' });
          return;
        }
        await handleResize(m.subscriberId, m.cols, m.rows);
        break;
      }
      case 'ping':
        safeSend({ type: 'pong' });
        break;
      default:
        safeSend({
          type: 'error',
          code: 'unknown_op',
          message: `unknown op: ${(msg as { op: string }).op}`,
        });
    }
  });

  socket.on('close', () => {
    for (const [sid, s] of [...subs]) {
      if (s.mode === 'full' && s.phase === 'active') {
        void emitIntervention(app, s.agentId, 'close');
      }
      releaseSub(sid);
    }
  });

  socket.on('error', (err: unknown) => {
    console.warn('[stream-ws] socket error:', err);
  });

  void request;
}

async function emitIntervention(
  app: FastifyInstance,
  agentId: string,
  phase: TerminalInterventionPhase,
): Promise<void> {
  const agent = app.ctx.agentManager.getAgentConfig(agentId);
  if (!agent) return;
  let taskId: string | undefined;
  try {
    const state = await app.ctx.agentStore.get(agentId);
    if (state?.taskId) taskId = state.taskId;
  } catch {}
  try {
    await app.ctx.eventBus.emit({
      id: '',
      type: 'human.intervention',
      timestamp: new Date().toISOString(),
      projectId: agent.projectId,
      agentId,
      ...(taskId ? { taskId } : {}),
      data: { phase },
    });
  } catch (err) {
    console.error(
      `[stream-ws] failed to emit human.intervention(${agentId}, ${phase}):`,
      err,
    );
  }
}
