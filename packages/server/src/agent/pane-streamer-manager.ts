import type { AgentConfig, HostConfig } from '../shared/index.js';
import type { CommandRunner } from './runner.js';
import {
  SessionAbsentError,
  TmuxManager,
  contentArea,
  type TmuxSessionRef,
  type TtySize,
  type WindowGeometry,
} from './tmux.js';
import {
  PaneStreamer,
  normalizeFollowIntervalMs,
  type PaneStreamerOptions,
  type ProbeHandle,
  type StreamerGeometryHooks,
} from './pane-streamer.js';

export interface PaneStreamerManagerOptions {
  runnerFactory: (agent: AgentConfig) => CommandRunner;
  hostResolver?: (agent: AgentConfig) => HostConfig | undefined;
  streamerDefaults?: PaneStreamerOptions;
  inputBatchMs?: number;
  geometryTimeoutMs?: number;
  maxPendingGeometryLiveness?: number;
  maxPendingGeometryPerAgent?: number;
}

const DEFAULT_INPUT_BATCH_MS = 10;
const DEFAULT_GEOMETRY_TIMEOUT_MS = 3000;
// Runner timeout only SIGTERMs; SIGKILL follows after a 2000ms grace and the
// promise settles on close. The geometry layer must not inherit that tail.
const GEOMETRY_SETTLE_SLACK_MS = 3000;
const DEFAULT_MAX_PENDING_GLOBAL = 16;
const DEFAULT_MAX_PENDING_PER_AGENT = 4;

export function raceDeadline<T>(p: Promise<T>, ms: number, onDeadline: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { onDeadline(); } catch {}
      reject(new Error(`geometry settle deadline (${ms}ms) exceeded`));
    }, ms);
    timer.unref?.();
    p.then(
      (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
      (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } },
    );
  });
}

interface InputBatch {
  data: string;
  timer: ReturnType<typeof setTimeout>;
  reject: (err: unknown) => void;
}

interface OwnerState {
  agent: AgentConfig;
  epoch: number;
  fullHolds: number;
  dirty: boolean;
  // A boot-time scan that could not complete (transient read failure, admission
  // backpressure) keeps its retry credential here until the round succeeds or the
  // session is provably absent.
  scanPending: boolean;
  gen: number;
  lastWrittenGen: number | null;
  fullTarget: TtySize | null;
  statusLines: number;
  identity: TmuxSessionRef | null;
  claim: string | null;
  ownerWriteCapability: 'full' | 'legacy' | null;
  legacyUnsettledWrites: number;
  timer: ReturnType<typeof setInterval> | null;
  inFlight: boolean;
  chain: Promise<void>;
  resizeWriteQueued: boolean;
  resizeWritePending: Promise<void> | null;
  readFailing: boolean;
  foreignWarned: boolean;
  tmux: TmuxManager | null;
}

export class PaneStreamerManager {
  private readonly streamers = new Map<string, PaneStreamer>();
  private readonly tmuxByAgent = new Map<string, TmuxManager>();
  private readonly inputChains = new Map<string, Promise<void>>();
  private readonly pendingInput = new Map<string, InputBatch>();
  private readonly owners = new Map<string, OwnerState>();
  // Epochs outlive owner-state deletion: a deleted-and-recreated agent id must
  // never validate closures/tasks captured against its previous life.
  private readonly ownerEpochs = new Map<string, number>();
  private pendingGlobal = 0;
  private readonly pendingByAgent = new Map<string, number>();

  private readonly runnerFactory: (agent: AgentConfig) => CommandRunner;
  private readonly hostResolver?: (agent: AgentConfig) => HostConfig | undefined;
  private readonly streamerDefaults?: PaneStreamerOptions;
  private readonly inputBatchMs: number;
  private readonly geometryTimeoutMs: number;
  private readonly followIntervalMs: number;
  private readonly maxPendingGlobal: number;
  private readonly maxPendingPerAgent: number;

  constructor(opts: PaneStreamerManagerOptions) {
    this.runnerFactory = opts.runnerFactory;
    this.hostResolver = opts.hostResolver;
    this.streamerDefaults = opts.streamerDefaults;
    this.inputBatchMs = opts.inputBatchMs ?? DEFAULT_INPUT_BATCH_MS;
    this.geometryTimeoutMs = opts.geometryTimeoutMs ?? DEFAULT_GEOMETRY_TIMEOUT_MS;
    this.followIntervalMs = normalizeFollowIntervalMs(opts.streamerDefaults?.windowFollowIntervalMs);
    this.maxPendingGlobal = opts.maxPendingGeometryLiveness ?? DEFAULT_MAX_PENDING_GLOBAL;
    this.maxPendingPerAgent = opts.maxPendingGeometryPerAgent ?? DEFAULT_MAX_PENDING_PER_AGENT;
  }

  private get settleDeadlineMs(): number {
    return this.geometryTimeoutMs + GEOMETRY_SETTLE_SLACK_MS;
  }

  ensure(agent: AgentConfig): PaneStreamer {
    const existing = this.streamers.get(agent.id);
    if (existing && !existing.isDestroyed()) return existing;
    const runner = this.runnerFactory(agent);
    const resolveHost = () => (this.hostResolver
      ? this.hostResolver(agent)
      : (typeof agent.host === 'object' ? agent.host : undefined));
    const tmux = new TmuxManager(runner);
    const owner = this.ownerOf(agent);
    const streamer = new PaneStreamer(agent, tmux, resolveHost, {
      ...this.streamerDefaults,
      geometry: this.geometryHooksFor(owner),
    });
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
    const pending = this.pendingInput.get(agentId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingInput.delete(agentId);
      this.windowFlush.delete(agentId);
      try {
        pending.reject(new Error(`pane_streamer_destroyed: agent ${agentId} streamer was destroyed mid-batch`));
      } catch {
      }
    }
    this.inputChains.delete(agentId);
    this.tmuxByAgent.delete(agentId);
    this.streamers.delete(agentId);
    if (streamer) streamer.destroy(opts);
    // Agent removal discards functional owner state; any queued/in-flight geometry
    // task or hold-release closure from the old epoch lands as a no-op, and remote
    // residue stays inert behind the session-identity fence. Raw liveness entries
    // in the global registry survive until their own settle.
    const owner = this.owners.get(agentId);
    if (owner) {
      owner.epoch++;
      this.ownerEpochs.set(agentId, owner.epoch);
      if (owner.timer) {
        clearInterval(owner.timer);
        owner.timer = null;
      }
      // silent = planned shutdown (destroyAll): boot-time startupScan owns any
      // leftover reconciliation, so a dirty owner is not worth a warning there.
      if (owner.dirty && !opts.silent) {
        console.warn(`[pane-streamer-manager] ${agentId} removed while owner state dirty; a rebuilt agent starts clean`);
      }
      this.owners.delete(agentId);
    }
  }

  async destroyAll(): Promise<void> {
    const ids = new Set([...this.streamers.keys(), ...this.owners.keys()]);
    await Promise.all([...ids].map((id) => this.destroy(id, { silent: true }).catch((err) => {
      console.error(`[PaneStreamerManager] destroyAll: destroy ${id} failed:`, err);
    })));
  }

  // Boot-time pass: process restarts lose in-memory owner state; one reconcile
  // round per configured agent heals any manual left behind by a prior life.
  // Sequential (bounded queue): a parallel fan-out would eat the global admission
  // budget and deterministically starve agents past the cap. scanPending is the
  // retry credential — a transient/backpressured round keeps it, the per-owner
  // timer retries until the round succeeds or the session is provably absent.
  startupScan(agents: AgentConfig[]): void {
    const queue: OwnerState[] = [];
    for (const agent of agents) {
      const owner = this.ownerOf(agent);
      owner.scanPending = true;
      this.syncReconcilerTimer(owner);
      queue.push(owner);
    }
    void (async () => {
      for (const owner of queue) {
        try {
          await this.reconcileOnce(owner);
        } catch (err) {
          console.warn(`[pane-streamer-manager] startup scan round failed for ${owner.agent.id}:`, err);
        }
      }
    })();
  }

  private ownerOf(agent: AgentConfig): OwnerState {
    const existing = this.owners.get(agent.id);
    if (existing) {
      existing.agent = agent;
      return existing;
    }
    const owner: OwnerState = {
      agent,
      epoch: this.ownerEpochs.get(agent.id) ?? 0,
      fullHolds: 0,
      dirty: false,
      scanPending: false,
      gen: 0,
      lastWrittenGen: null,
      fullTarget: null,
      statusLines: 1,
      identity: null,
      claim: null,
      ownerWriteCapability: null,
      legacyUnsettledWrites: 0,
      timer: null,
      inFlight: false,
      chain: Promise.resolve(),
      resizeWriteQueued: false,
      resizeWritePending: null,
      readFailing: false,
      foreignWarned: false,
      tmux: null,
    };
    this.owners.set(agent.id, owner);
    return owner;
  }

  private ownerTmux(owner: OwnerState): TmuxManager {
    const live = this.tmuxByAgent.get(owner.agent.id);
    if (live) return live;
    if (!owner.tmux) owner.tmux = new TmuxManager(this.runnerFactory(owner.agent));
    return owner.tmux;
  }

  private geometryHooksFor(owner: OwnerState): StreamerGeometryHooks {
    const epoch = owner.epoch;
    const agentId = owner.agent.id;
    const current = (): OwnerState | null => {
      const cur = this.owners.get(agentId);
      return cur && cur.epoch === epoch ? cur : null;
    };
    return {
      fullHolds: () => current()?.fullHolds ?? 0,
      acquireFullHold: () => {
        const cur = current();
        if (!cur) return () => undefined;
        return this.acquireFullHold(cur);
      },
      readGeometry: async () => {
        const cur = current();
        if (!cur) throw new Error(`agent ${agentId} owner state replaced`);
        return this.readGeometryAdmitted(cur);
      },
      raceProbe: <T>(start: () => ProbeHandle<T>) => this.raceProbeStart(agentId, start),
      noteManualSeen: () => {
        const cur = current();
        if (!cur || cur.fullHolds > 0) return;
        cur.dirty = true;
        this.syncReconcilerTimer(cur);
        void this.reconcileOnce(cur);
      },
      recordFullTarget: (size: TtySize) => {
        const cur = current();
        if (cur) cur.fullTarget = size;
      },
      commitOwnerResize: () => {
        const cur = current();
        if (!cur) return Promise.reject(new Error(`agent ${agentId} owner state replaced; resize dropped`));
        return this.commitOwnerResize(cur);
      },
    };
  }

  private acquireFullHold(owner: OwnerState): () => void {
    owner.fullHolds++;
    if (owner.fullHolds === 1) {
      owner.dirty = true;
      this.syncReconcilerTimer(owner);
      void this.reconcileOnce(owner);
    }
    const epoch = owner.epoch;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const cur = this.owners.get(owner.agent.id);
      if (!cur || cur.epoch !== epoch) return;
      cur.fullHolds = Math.max(0, cur.fullHolds - 1);
      if (cur.fullHolds === 0) {
        cur.fullTarget = null;
        cur.dirty = true;
        this.syncReconcilerTimer(cur);
        void this.reconcileOnce(cur);
      }
    };
  }

  private syncReconcilerTimer(owner: OwnerState): void {
    const needed = this.owners.get(owner.agent.id) === owner
      && (owner.dirty || owner.fullHolds > 0 || owner.scanPending);
    if (needed && !owner.timer) {
      owner.timer = setInterval(() => { void this.reconcileOnce(owner); }, this.followIntervalMs);
      owner.timer.unref?.();
    } else if (!needed && owner.timer) {
      clearInterval(owner.timer);
      owner.timer = null;
    }
  }

  private admitLiveness(agentId: string): boolean {
    const per = this.pendingByAgent.get(agentId) ?? 0;
    return this.pendingGlobal < this.maxPendingGlobal && per < this.maxPendingPerAgent;
  }

  private registerLiveness(agentId: string, settled: Promise<unknown>): void {
    this.pendingGlobal++;
    this.pendingByAgent.set(agentId, (this.pendingByAgent.get(agentId) ?? 0) + 1);
    const release = () => {
      this.pendingGlobal = Math.max(0, this.pendingGlobal - 1);
      const next = (this.pendingByAgent.get(agentId) ?? 1) - 1;
      if (next <= 0) this.pendingByAgent.delete(agentId);
      else this.pendingByAgent.set(agentId, next);
    };
    settled.then(release, release);
  }

  private async raceGeometryExec<T>(agentId: string, start: () => Promise<T>): Promise<T> {
    if (!this.admitLiveness(agentId)) {
      throw new Error(`geometry liveness capacity reached (${agentId}); backing off`);
    }
    const raw = start();
    this.registerLiveness(agentId, raw.then(() => undefined, () => undefined));
    return raceDeadline(raw, this.settleDeadlineMs, () => undefined);
  }

  // Admission is reserved BEFORE the probe live-body exists (lazy start): a
  // capacity-refused probe creates nothing, and a created probe is registered
  // before it can race — no PTY ever lives outside the global registry.
  private raceProbeStart<T>(agentId: string, start: () => ProbeHandle<T>): Promise<T> {
    if (!this.admitLiveness(agentId)) {
      return Promise.reject(new Error(`geometry liveness capacity reached (${agentId}); probe not admitted`));
    }
    const handle = start();
    this.registerLiveness(agentId, handle.settled.then(() => undefined, () => undefined));
    return raceDeadline(handle.result, this.settleDeadlineMs, () => {
      try {
        handle.onDeadline();
      } catch (err) {
        // The registry entry stays until the probe's own exit is observed — the
        // occupied slot IS the retry credential; the operator just needs to know.
        console.warn(`[pane-streamer-manager] ${agentId} capability probe kill failed (slot stays occupied until it exits):`, err);
      }
    });
  }

  private async readGeometryAdmitted(owner: OwnerState): Promise<WindowGeometry> {
    const tmux = this.ownerTmux(owner);
    const geom = await this.raceGeometryExec(owner.agent.id, () =>
      tmux.getWindowGeometry(owner.agent.id, { timeout: this.geometryTimeoutMs }));
    owner.statusLines = geom.statusLines;
    if (owner.identity && (
      owner.identity.sessionId !== geom.ref.sessionId
      || owner.identity.serverPid !== geom.ref.serverPid
      || owner.identity.serverStart !== geom.ref.serverStart
    )) {
      // A rebuilt session has no relation to the previous full target or writes.
      owner.fullTarget = null;
      owner.lastWrittenGen = null;
    }
    owner.identity = geom.ref;
    owner.claim = geom.claim;
    owner.ownerWriteCapability = geom.ownerWriteCapability;
    if (geom.ownerGen !== null && geom.ownerGen > owner.gen) owner.gen = geom.ownerGen;
    return geom;
  }

  private enqueueGeometry<T>(owner: OwnerState, epoch: number, task: () => Promise<T>): Promise<T> {
    const run = owner.chain.then(async () => {
      const cur = this.owners.get(owner.agent.id);
      if (cur !== owner || owner.epoch !== epoch) {
        throw new Error(`agent ${owner.agent.id} owner state replaced; geometry task dropped`);
      }
      return task();
    });
    owner.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  // Every owner write is server-side guarded by session triple ∧ claim; 'full'
  // capability adds the numeric generation compare. 'null' capability (unproven
  // either way) issues NOTHING — fail closed, retry after the next read.
  private async issueOwnerWrite(
    owner: OwnerState,
    mode: 'manual' | 'latest',
    resizeTo: TtySize | undefined,
  ): Promise<void> {
    if (owner.identity === null) {
      throw new Error(`agent ${owner.agent.id} owner identity unknown; no write issued`);
    }
    if (owner.claim !== owner.agent.id) {
      throw new Error(
        `agent ${owner.agent.id} session claim is ${JSON.stringify(owner.claim)}; refusing to write to a foreign/unclaimed session`,
      );
    }
    const capability = owner.ownerWriteCapability;
    if (capability === null) {
      throw new Error(`agent ${owner.agent.id} owner write capability unproven; no write issued`);
    }
    const tmux = this.ownerTmux(owner);
    const opts = { timeout: this.geometryTimeoutMs };
    if (capability === 'full') {
      const gen = owner.gen = Math.max(Date.now(), owner.gen + 1);
      await this.raceGeometryExec(owner.agent.id, () =>
        tmux.ownerWrite(owner.agent.id, owner.identity!, owner.agent.id, gen, mode, resizeTo, opts));
      owner.lastWrittenGen = gen;
      return;
    }
    // Legacy server (<3.2, no format arithmetic): triple ∧ claim guard still holds;
    // only the generation compare is unavailable, so same-session out-of-order
    // writes remain possible. dirty must not clear while one is unsettled.
    await this.raceGeometryExec(owner.agent.id, () => {
      owner.legacyUnsettledWrites++;
      const raw = tmux.ownerWrite(owner.agent.id, owner.identity!, owner.agent.id, null, mode, resizeTo, opts);
      const dec = () => { owner.legacyUnsettledWrites = Math.max(0, owner.legacyUnsettledWrites - 1); };
      raw.then(dec, dec);
      return raw;
    });
    owner.lastWrittenGen = null;
  }

  private fullBasis(owner: OwnerState): TtySize | null {
    if (owner.fullTarget) return owner.fullTarget;
    const streamer = this.streamers.get(owner.agent.id);
    if (streamer && !streamer.isDestroyed()) return streamer.size;
    return null;
  }

  async reconcileOnce(owner: OwnerState): Promise<void> {
    if (owner.inFlight) return;
    owner.inFlight = true;
    try {
      if (this.owners.get(owner.agent.id) !== owner) return;
      if (!owner.dirty && owner.fullHolds === 0 && !owner.scanPending) return;
      const epoch = owner.epoch;
      let geom: WindowGeometry;
      try {
        geom = await this.readGeometryAdmitted(owner);
        if (owner.readFailing) {
          owner.readFailing = false;
          console.log(`[pane-streamer-manager] ${owner.agent.id} owner geometry read recovered`);
        }
      } catch (err) {
        if (err instanceof SessionAbsentError) {
          // A PROVEN-absent session has nothing to reconcile; a rebuilt one starts
          // at tmux defaults and is re-armed by ensure()/startupScan(). Transient
          // failures (SSH flake, exit 255, admission backpressure) land in the
          // other branch and keep every retry credential.
          owner.scanPending = false;
          if (owner.fullHolds === 0 && owner.dirty) owner.dirty = false;
          this.syncReconcilerTimer(owner);
          return;
        }
        if (!owner.readFailing) {
          owner.readFailing = true;
          const detail = err instanceof Error ? err.message : String(err);
          console.warn(`[pane-streamer-manager] ${owner.agent.id} owner geometry read failing: ${detail}`);
        }
        return;
      }
      if (owner.epoch !== epoch || this.owners.get(owner.agent.id) !== owner) return;
      // The read succeeded: the boot-scan credential is spent regardless of what
      // the state machine decides next (dirty carries any follow-up work).
      owner.scanPending = false;

      if (geom.claim !== owner.agent.id) {
        if (!owner.foreignWarned) {
          owner.foreignWarned = true;
          console.warn(
            `[pane-streamer-manager] ${owner.agent.id} same-name session is claimed by ${JSON.stringify(geom.claim)}; owner writes withheld`,
          );
        }
        this.syncReconcilerTimer(owner);
        return;
      }
      if (owner.foreignWarned) {
        owner.foreignWarned = false;
        console.log(`[pane-streamer-manager] ${owner.agent.id} session claim recovered`);
      }

      const desired: 'manual' | 'latest' = owner.fullHolds > 0 ? 'manual' : 'latest';
      const basis = desired === 'manual' ? this.fullBasis(owner) : null;
      const wantArea = basis ? contentArea(basis, owner.statusLines) : null;
      const modeOk = geom.sizeMode === desired;
      const genOk = owner.ownerWriteCapability === 'full'
        ? (owner.lastWrittenGen === null || geom.ownerGen === owner.lastWrittenGen)
        : true;
      const sizeOk = desired === 'latest' || wantArea === null
        || (geom.width === wantArea.cols && geom.height === wantArea.rows);
      if (modeOk && genOk && sizeOk) {
        if (owner.legacyUnsettledWrites === 0 && owner.dirty) {
          owner.dirty = false;
        }
        this.syncReconcilerTimer(owner);
        return;
      }

      owner.dirty = true;
      this.syncReconcilerTimer(owner);
      try {
        await this.enqueueGeometry(owner, epoch, async () => {
          const mode: 'manual' | 'latest' = owner.fullHolds > 0 ? 'manual' : 'latest';
          const commitBasis = mode === 'manual' ? this.fullBasis(owner) : null;
          const resizeTo = mode === 'manual' && commitBasis
            ? contentArea(commitBasis, owner.statusLines)
            : undefined;
          if (mode === 'manual' && !commitBasis && geom.sizeMode === 'manual') return;
          await this.issueOwnerWrite(owner, mode, resizeTo);
        });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.warn(`[pane-streamer-manager] ${owner.agent.id} owner write failed (will retry): ${detail}`);
      }
    } finally {
      owner.inFlight = false;
    }
  }

  private async commitOwnerResize(owner: OwnerState): Promise<void> {
    owner.dirty = true;
    this.syncReconcilerTimer(owner);
    const epoch = owner.epoch;
    if (owner.identity === null || owner.ownerWriteCapability === null) {
      await this.readGeometryAdmitted(owner);
      if (owner.epoch !== epoch || this.owners.get(owner.agent.id) !== owner) {
        throw new Error(`agent ${owner.agent.id} owner state replaced; resize dropped`);
      }
    }
    if (owner.resizeWriteQueued && owner.resizeWritePending) return owner.resizeWritePending;
    owner.resizeWriteQueued = true;
    const run = this.enqueueGeometry(owner, epoch, async () => {
      owner.resizeWriteQueued = false;
      // Released or retargeted while queued: the reconciler owns 'latest'; a newer
      // resize target is picked up here because we read fullTarget at run time.
      if (owner.fullHolds === 0) return;
      const target = owner.fullTarget;
      if (!target) return;
      await this.issueOwnerWrite(owner, 'manual', contentArea(target, owner.statusLines));
    });
    const shared: Promise<void> = run.finally(() => {
      if (owner.resizeWritePending === shared) owner.resizeWritePending = null;
    });
    owner.resizeWritePending = shared;
    return shared;
  }

  _geometryPendingForTest(): { global: number; byAgent: Map<string, number> } {
    return { global: this.pendingGlobal, byAgent: new Map(this.pendingByAgent) };
  }

  _ownerForTest(agentId: string): {
    fullHolds: number; dirty: boolean; gen: number; fullTarget: TtySize | null;
    ownerWriteCapability: 'full' | 'legacy' | null; claim: string | null;
    scanPending: boolean; timerActive: boolean; epoch: number;
  } | null {
    const o = this.owners.get(agentId);
    if (!o) return null;
    return {
      fullHolds: o.fullHolds,
      dirty: o.dirty,
      gen: o.gen,
      fullTarget: o.fullTarget,
      ownerWriteCapability: o.ownerWriteCapability,
      claim: o.claim,
      scanPending: o.scanPending,
      timerActive: o.timer !== null,
      epoch: o.epoch,
    };
  }

  _reconcileNowForTest(agentId: string): Promise<void> {
    const owner = this.owners.get(agentId);
    if (!owner) return Promise.resolve();
    owner.scanPending = true;
    return this.reconcileOnce(owner);
  }

  private readonly windowFlush = new Map<string, Promise<void>>();

  enqueueInput(agentId: string, data: string): Promise<void> {
    if (data.length === 0) return Promise.resolve();
    const cur = this.pendingInput.get(agentId);
    if (cur) {
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
