import type { AgentConfig, HostConfig } from '../shared/index.js';
import type { CommandRunner } from './runner.js';
import { TmuxManager } from './tmux.js';
import {
  PaneStreamer,
  type PaneStreamerOptions,
} from './pane-streamer.js';

// Input chain is per-agent (not per-WS) — concurrent clients otherwise interleave bytes.
export interface PaneStreamerManagerOptions {
  runnerFactory: (agent: AgentConfig) => CommandRunner;
  // Resolves the agent's host ref against the current config (interactive attach needs port/password).
  hostResolver?: (agent: AgentConfig) => HostConfig | undefined;
  streamerDefaults?: PaneStreamerOptions;
  inputBatchMs?: number;
}

const DEFAULT_INPUT_BATCH_MS = 10;

interface InputBatch {
  data: string;
  timer: ReturnType<typeof setTimeout>;
  // destroy(agentId) calls this so callers awaiting enqueueInput don't hang.
  reject: (err: unknown) => void;
}

export class PaneStreamerManager {
  private readonly streamers = new Map<string, PaneStreamer>();
  private readonly tmuxByAgent = new Map<string, TmuxManager>();
  private readonly inputChains = new Map<string, Promise<void>>();
  private readonly pendingInput = new Map<string, InputBatch>();

  private readonly runnerFactory: (agent: AgentConfig) => CommandRunner;
  private readonly hostResolver?: (agent: AgentConfig) => HostConfig | undefined;
  private readonly streamerDefaults?: PaneStreamerOptions;
  private readonly inputBatchMs: number;

  constructor(opts: PaneStreamerManagerOptions) {
    this.runnerFactory = opts.runnerFactory;
    this.hostResolver = opts.hostResolver;
    this.streamerDefaults = opts.streamerDefaults;
    this.inputBatchMs = opts.inputBatchMs ?? DEFAULT_INPUT_BATCH_MS;
  }

  ensure(agent: AgentConfig): PaneStreamer {
    const existing = this.streamers.get(agent.id);
    if (existing && !existing.isDestroyed()) return existing;
    const runner = this.runnerFactory(agent);
    // Pass a resolver (not a captured host) so each attach re-reads the current config — a host
    // password/endpoint changed via PATCH /hosts is picked up on the next reconnect.
    const resolveHost = () => (this.hostResolver
      ? this.hostResolver(agent)
      : (typeof agent.host === 'object' ? agent.host : undefined));
    const tmux = new TmuxManager(runner);
    const streamer = new PaneStreamer(agent, tmux, runner, resolveHost, this.streamerDefaults);
    this.streamers.set(agent.id, streamer);
    this.tmuxByAgent.set(agent.id, tmux);
    return streamer;
  }

  has(agentId: string): boolean {
    const s = this.streamers.get(agentId);
    return !!s && !s.isDestroyed();
  }

  async destroy(agentId: string, opts: { silent?: boolean } = {}): Promise<void> {
    const streamer = this.streamers.get(agentId);
    // Settle pending flushPromise so enqueueInput callers don't hang forever.
    const pending = this.pendingInput.get(agentId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingInput.delete(agentId);
      this.windowFlush.delete(agentId);
      try {
        pending.reject(new Error(`pane_streamer_destroyed: agent ${agentId} streamer was destroyed mid-batch`));
      } catch {
        // caller may already be gone
      }
    }
    this.inputChains.delete(agentId);
    this.tmuxByAgent.delete(agentId);
    this.streamers.delete(agentId);
    if (streamer) streamer.destroy(opts);
  }

  // Shutdown teardown: kill every live streamer's PTY (local tmux attach / remote ssh -t) so signals
  // and /api/restart don't leave orphaned attach processes behind. silent=true so a planned shutdown
  // doesn't fire sessionGone → false signal-session-gone interventions for still-armed watchers.
  async destroyAll(): Promise<void> {
    const ids = [...this.streamers.keys()];
    await Promise.all(ids.map((id) => this.destroy(id, { silent: true }).catch((err) => {
      console.error(`[PaneStreamerManager] destroyAll: destroy ${id} failed:`, err);
    })));
  }

  private readonly windowFlush = new Map<string, Promise<void>>();

  enqueueInput(agentId: string, data: string): Promise<void> {
    if (data.length === 0) return Promise.resolve();
    const cur = this.pendingInput.get(agentId);
    if (cur) {
      // Append within the current window — don't reset the timer.
      cur.data += data;
      return this.windowFlush.get(agentId) ?? Promise.resolve();
    }
    let resolveFlush!: () => void;
    let rejectFlush!: (err: unknown) => void;
    const flushPromise = new Promise<void>((resolve, reject) => {
      resolveFlush = resolve;
      rejectFlush = reject;
    });
    this.windowFlush.set(agentId, flushPromise);
    const timer = setTimeout(() => {
      const entry = this.pendingInput.get(agentId);
      this.pendingInput.delete(agentId);
      this.windowFlush.delete(agentId);
      if (!entry) {
        resolveFlush();
        return;
      }
      // Chain always resolves; per-batch rejection routes through flushPromise.
      const prev = this.inputChains.get(agentId) ?? Promise.resolve();
      const next = prev
        .then(async () => {
          const streamer = this.streamers.get(agentId);
          if (!streamer || streamer.isDestroyed()) {
            resolveFlush();
            return;
          }
          try {
            await streamer.sendInput(entry.data);
            resolveFlush();
          } catch (err) {
            rejectFlush(err);
          }
        })
        .finally(() => {
          if (this.inputChains.get(agentId) === next) {
            this.inputChains.delete(agentId);
          }
        });
      this.inputChains.set(agentId, next);
      next.catch(() => undefined);
    }, this.inputBatchMs);
    this.pendingInput.set(agentId, { data, timer, reject: rejectFlush });
    return flushPromise;
  }
}
