import { accessSync, chmodSync, constants, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { AgentConfig, HostConfig } from '../shared/index.js';
import xterm from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import {
  buildAttachInteractiveCommand,
  buildAttachProbeCommand,
  type AttachCommand,
} from '../terminal/attach.js';
import { sshEnv } from './runner.js';
import { TmuxManager, desiredTty, type TmuxSessionRef, type TtySize, type WindowGeometry } from './tmux.js';
import { computeBackoffMs } from '../timing/backoff.js';

export interface PaneStreamerOptions {
  scrollbackLines?: number;
  idleGraceMs?: number;
  reattachDelayMs?: number;
  reattachMaxDelayMs?: number;
  reattachJitter?: number;
  reattachStableAfterMs?: number;
  sessionProbeTimeoutMs?: number;
  initialCols?: number;
  initialRows?: number;
  windowFollowIntervalMs?: number;
  ptyFactory?: PtyFactory;
  random?: () => number;
  geometry?: StreamerGeometryHooks;
}

export interface ProbeHandle<T> {
  result: Promise<T>;
  settled: Promise<unknown>;
  onDeadline: () => void;
}

// Injected by PaneStreamerManager: owner state, admission-capped geometry reads,
// and the per-agent geometry chain all live at manager level so they survive
// streamer idle-destroy and instance replacement.
export interface StreamerGeometryHooks {
  fullHolds(): number;
  acquireFullHold(): () => void;
  readGeometry(): Promise<WindowGeometry>;
  raceProbe<T>(start: () => ProbeHandle<T>): Promise<T>;
  noteManualSeen(): void;
  recordFullTarget(size: TtySize): void;
  commitOwnerResize(): Promise<void>;
}

interface PaneSnapshot {
  cols: number;
  rows: number;
  data: string;
}

export interface SubscribeResult {
  unsubscribe: () => void;
  snapshot: PaneSnapshot;
  snapshotSeq: number;
}

export interface GetSnapshotResult {
  snapshot: PaneSnapshot;
  snapshotSeq: number;
}

export interface SubscriberCallbacks {
  onLive: (data: string, seq: number) => void;
  onSessionGone: () => void;
  onSnapshotRefresh?: (snapshot: { cols: number; rows: number; data: string }, seq: number) => void;
}

export interface MinimalPty {
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (e: { exitCode: number; signal?: number | undefined }) => void): { dispose(): void };
  resize(cols: number, rows: number): void;
  write(data: string): void;
  kill(signal?: string): void;
}

export type PtyFactory = (cmd: AttachCommand, cols: number, rows: number) => MinimalPty;

const DEFAULT_SCROLLBACK_LINES = 1000;
const DEFAULT_IDLE_GRACE_MS = 5000;
const MIN_REATTACH_DELAY_MS = 1000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DEFAULT_REATTACH_DELAY_MS = MIN_REATTACH_DELAY_MS;
const DEFAULT_REATTACH_MAX_DELAY_MS = 15_000;
const DEFAULT_REATTACH_JITTER = 0.2;
const DEFAULT_REATTACH_STABLE_AFTER_MS = 5000;
const DEFAULT_SESSION_PROBE_TIMEOUT_MS = 3000;
const DEFAULT_COLS = 200;
const DEFAULT_ROWS = 50;
const DEFAULT_FOLLOW_INTERVAL_MS = 1500;
const MIN_FOLLOW_INTERVAL_MS = 200;

// The follow interval has no disable value: the owner reconciler shares this
// cadence and must never be configured off (invariant 6).
export function normalizeFollowIntervalMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return DEFAULT_FOLLOW_INTERVAL_MS;
  return Math.min(Math.max(Math.trunc(value), MIN_FOLLOW_INTERVAL_MS), MAX_TIMER_DELAY_MS);
}

const ATTACH_VERSION_RE = /tmux\s+(?:next-)?(\d+)\.(\d+)/;

export function parseAttachFlagCapability(output: string): boolean | null {
  const m = ATTACH_VERSION_RE.exec(output);
  if (!m) return null;
  const major = parseInt(m[1], 10);
  const minor = parseInt(m[2], 10);
  return major > 3 || (major === 3 && minor >= 2);
}

let cachedPtyFactory: PtyFactory | null = null;

const EXEC_BITS = 0o111;

const moduleRequire = createRequire(import.meta.url);

type ModuleLoader = (modulePath: string) => void;

export function ensureSpawnHelperExecutable(
  packageDir = resolveNodePtyDir(),
  deps: {
    chmod?: (path: string, mode: number) => void;
    load?: ModuleLoader;
    canExecute?: (path: string) => boolean;
  } = {},
): void {
  const chmod = deps.chmod ?? chmodSync;
  const load = deps.load ?? moduleRequire;
  const canExecute = deps.canExecute ?? defaultCanExecute;
  const helper = packageDir ? resolveActiveSpawnHelper(packageDir, load) : undefined;
  if (!helper) return;
  let mode: number;
  try {
    mode = statSync(helper).mode;
  } catch {
    return;
  }
  if (canExecute(helper)) return;
  try {
    chmod(helper, mode | EXEC_BITS);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `node-pty spawn-helper is not executable and could not be fixed (${detail}): ${helper}. ` +
        `A root-owned global install run as a non-root user hits this — fix with: chmod +x ${helper}`,
    );
  }
}

function defaultCanExecute(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveActiveSpawnHelper(packageDir: string, load: ModuleLoader): string | undefined {
  const dirs = ['build/Release', 'build/Debug', `prebuilds/${process.platform}-${process.arch}`];
  for (const dir of dirs) {
    try {
      load(join(packageDir, dir, 'pty.node'));
    } catch {
      continue;
    }
    return join(packageDir, dir, 'spawn-helper');
  }
  return undefined;
}

function resolveNodePtyDir(): string | undefined {
  try {
    return dirname(moduleRequire.resolve('node-pty/package.json'));
  } catch {
    return undefined;
  }
}

async function defaultPtyFactory(): Promise<PtyFactory> {
  if (cachedPtyFactory) return cachedPtyFactory;
  const nodePty = await import('node-pty');
  ensureSpawnHelperExecutable();
  cachedPtyFactory = (cmd, cols, rows) =>
    nodePty.spawn(cmd.file, cmd.args, {
      name: 'xterm-256color',
      cols,
      rows,
      env: { ...(process.env as Record<string, string>), ...(cmd.env ?? {}) },
    });
  return cachedPtyFactory;
}

function normalizeReattachDelayMs(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_REATTACH_DELAY_MS;
  return Math.min(Math.max(Math.trunc(value), MIN_REATTACH_DELAY_MS), MAX_TIMER_DELAY_MS);
}

function normalizeSessionProbeTimeoutMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_SESSION_PROBE_TIMEOUT_MS;
  return Math.min(Math.trunc(value), MAX_TIMER_DELAY_MS);
}

export class PaneStreamer {
  private pty: MinimalPty | null = null;
  private headless: xterm.Terminal;
  private serialize: SerializeAddon;
  private onPtyDataChain: Promise<void> = Promise.resolve();
  private nextSeq = 0;
  private lastBroadcastSeq = -1;
  private live = new Set<SubscriberCallbacks['onLive']>();
  private sessionGoneCbs = new Set<SubscriberCallbacks['onSessionGone']>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private reattachTimer: ReturnType<typeof setTimeout> | null = null;
  private reattaching: Promise<void> | null = null;
  private reattachAttempts = 0;
  private outageActive = false;
  private stabilityTimer: ReturnType<typeof setTimeout> | null = null;
  private ptyGeneration = 0;
  // Just-attached PTY output is held here until the post-attach handshake proves the generation (flushed on 'owned', dropped otherwise) — the browser must never see bytes from an unverified session.
  private attachQuarantined = false;
  private quarantineBuffer: string[] = [];
  // The tmux generation this streamer is bound to (pinned on first attach); a reissued generation is treated as gone so the manager rebuilds the streamer.
  private expectedRef: TmuxSessionRef | null = null;
  private destroyed = false;
  private starting: Promise<void> | null = null;
  private started = false;
  private followTimer: ReturnType<typeof setInterval> | null = null;
  private followInFlight = false;
  private followReadFailing = false;
  private refreshPending = false;
  private refreshCbs = new Set<NonNullable<SubscriberCallbacks['onSnapshotRefresh']>>();
  // null = capability unknown (probe failed/hung/unparseable): never cached, re-probed next spawn.
  private attachFlagged: boolean | null = null;
  private currentPtyFlagged = false;

  private readonly scrollbackLines: number;
  private readonly idleGraceMs: number;
  private readonly reattachDelayMs: number;
  private readonly reattachMaxDelayMs: number;
  private readonly reattachJitter: number;
  private readonly reattachStableAfterMs: number;
  private readonly sessionProbeTimeoutMs: number;
  private readonly initialCols: number;
  private readonly initialRows: number;
  private readonly windowFollowIntervalMs: number;
  private readonly ptyFactoryProvided: PtyFactory | undefined;
  private readonly random: () => number;
  private readonly geometry: StreamerGeometryHooks | undefined;

  constructor(
    private readonly agent: AgentConfig,
    private readonly tmux: TmuxManager,
    private readonly resolveHost: () => HostConfig | undefined,
    opts: PaneStreamerOptions = {},
  ) {
    this.scrollbackLines = opts.scrollbackLines ?? DEFAULT_SCROLLBACK_LINES;
    this.idleGraceMs = opts.idleGraceMs ?? DEFAULT_IDLE_GRACE_MS;
    this.reattachDelayMs = normalizeReattachDelayMs(opts.reattachDelayMs ?? DEFAULT_REATTACH_DELAY_MS);
    this.reattachMaxDelayMs = Math.max(
      this.reattachDelayMs,
      normalizeReattachDelayMs(opts.reattachMaxDelayMs ?? DEFAULT_REATTACH_MAX_DELAY_MS),
    );
    this.reattachJitter = opts.reattachJitter ?? DEFAULT_REATTACH_JITTER;
    this.reattachStableAfterMs = Math.max(1, Math.trunc(opts.reattachStableAfterMs ?? DEFAULT_REATTACH_STABLE_AFTER_MS));
    this.random = opts.random ?? Math.random;
    this.sessionProbeTimeoutMs = normalizeSessionProbeTimeoutMs(
      opts.sessionProbeTimeoutMs ?? DEFAULT_SESSION_PROBE_TIMEOUT_MS,
    );
    this.initialCols = opts.initialCols ?? DEFAULT_COLS;
    this.initialRows = opts.initialRows ?? DEFAULT_ROWS;
    this.windowFollowIntervalMs = normalizeFollowIntervalMs(opts.windowFollowIntervalMs);
    this.geometry = opts.geometry;
    this.ptyFactoryProvided = opts.ptyFactory;
    this.headless = new xterm.Terminal({
      cols: this.initialCols,
      rows: this.initialRows,
      scrollback: this.scrollbackLines,
      allowProposedApi: true,
    });
    this.serialize = new SerializeAddon();
    this.headless.loadAddon(this.serialize);
  }

  private async ensureStarted(): Promise<void> {
    if (this.destroyed) throw new Error('PaneStreamer is destroyed');
    if (this.started) {
      if (!this.pty) await this.ensureAttachPty();
      return;
    }
    if (this.starting) return this.starting;
    this.starting = this.startInner();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async startInner(): Promise<void> {
    await this.ensureAttachPty();
    this.started = true;
  }

  private async ensureAttachPty(): Promise<void> {
    if (this.destroyed) throw new Error('PaneStreamer is destroyed');
    if (this.pty) return;
    if (this.reattachTimer) {
      clearTimeout(this.reattachTimer);
      this.reattachTimer = null;
    }
    if (this.reattaching) return this.reattaching;
    let wantRetry = false;
    const p = this.attemptAttach()
      .then((outcome) => { wantRetry = outcome === 'retry'; })
      .finally(() => {
        if (this.reattaching === p) this.reattaching = null;
        // A transport-uncertain probe never spawns a PTY; it only schedules a backoff retry.
        if (wantRetry && !this.destroyed && !this.pty) this.scheduleReattach();
      });
    this.reattaching = p;
    return p;
  }

  // Owned = current same-name generation (pid+start_time+session_id) matches the pinned one and is still self-claimed; a fresh server reissues the name with a NEW generation. Throws on a transport-uncertain probe so the caller backs off, not misreads it as gone.
  private async checkOwnership(): Promise<'owned' | 'gone'> {
    const snap = await this.tmux.getSessionSnapshot(this.agent.id, { timeout: this.sessionProbeTimeoutMs });
    if (!snap || snap.claim !== this.agent.id) return 'gone';
    if (this.expectedRef === null) {
      this.expectedRef = snap.ref; // first attach pins the generation we are bound to
      return 'owned';
    }
    const sameGeneration =
      snap.ref.serverPid === this.expectedRef.serverPid &&
      snap.ref.serverStart === this.expectedRef.serverStart &&
      snap.ref.sessionId === this.expectedRef.sessionId;
    return sameGeneration ? 'owned' : 'gone';
  }

  // 'ok' = attached; 'gone' = session absent/foreign/reissued (torn down); 'retry' = probe uncertain.
  private async attemptAttach(): Promise<'ok' | 'gone' | 'retry'> {
    let ownership: 'owned' | 'gone';
    try {
      ownership = await this.checkOwnership();
    } catch (err) {
      this.noteOutage(err);
      return 'retry';
    }
    if (this.destroyed) return 'ok';
    if (ownership === 'gone') {
      this.markSessionGone();
      return 'gone';
    }
    await this.spawnAttachPty();
    // Post-attach handshake: a restart between the guard probe and attach-session exec could connect a same-name successor; re-prove the pinned generation before Web I/O settles, tear down otherwise.
    if (this.destroyed || !this.pty) return 'ok';
    let postOwnership: 'owned' | 'gone';
    try {
      postOwnership = await this.checkOwnership();
    } catch (err) {
      // Fail closed like the pre-attach probe: an uncertain post-attach probe cannot prove we are still on
      // the pinned generation, so tear down the just-attached PTY and back off rather than expose a
      // possibly-foreign session to the browser.
      this.killAttachPty();
      this.noteOutage(err);
      return 'retry';
    }
    if (postOwnership === 'gone' && !this.destroyed) {
      this.markSessionGone();
      return 'gone';
    }
    if (this.destroyed) return 'ok';
    this.releaseQuarantine(); // verified — flush the buffered output and stream live from here
    return 'ok';
  }

  private releaseQuarantine(): void {
    if (!this.attachQuarantined) return;
    this.attachQuarantined = false;
    const buffered = this.quarantineBuffer;
    this.quarantineBuffer = [];
    for (const data of buffered) this.onPtyData(data);
  }

  private async spawnAttachPty(): Promise<void> {
    const factory = this.ptyFactoryProvided ?? (await defaultPtyFactory());
    if (this.destroyed) throw new Error('PaneStreamer destroyed during attach');
    const host = this.resolveHost();
    const env = await sshEnv(host);
    const flagged = await this.resolveAttachCapability(factory, host, env);
    if (this.destroyed) throw new Error('PaneStreamer destroyed during attach');
    await this.alignSpawnBaseline(flagged);
    if (this.destroyed) throw new Error('PaneStreamer destroyed during attach');
    // The attach command re-proves and attaches the pinned expectedRef before PTY streaming.
    const expected = this.expectedRef
      ? {
          serverPid: this.expectedRef.serverPid,
          serverStart: this.expectedRef.serverStart,
          sessionId: this.expectedRef.sessionId,
          claim: this.agent.id,
        }
      : undefined;
    const cmd = buildAttachInteractiveCommand(this.agent, host, expected, { ignoreSize: flagged });
    if (Object.keys(env).length > 0) cmd.env = env;
    const spawnCols = this.headless.cols;
    const spawnRows = this.headless.rows;
    const pty = factory(cmd, spawnCols, spawnRows);
    const generation = ++this.ptyGeneration;
    this.pty = pty;
    this.currentPtyFlagged = flagged;
    // Quarantine output until attemptAttach's post-attach handshake confirms the generation.
    this.attachQuarantined = true;
    this.quarantineBuffer = [];

    pty.onData((data: string) => {
      if (generation !== this.ptyGeneration || this.destroyed) return;
      if (this.attachQuarantined) {
        this.quarantineBuffer.push(data);
        return;
      }
      this.onPtyData(data);
    });
    pty.onExit(() => {
      if (generation !== this.ptyGeneration || this.destroyed) return;
      this.clearStabilityTimer();
      this.clearFollowTimer();
      this.pty = null;
      void this.handleAttachExit();
    });
    // A resize() that landed between baseline and spawn moved headless; the pty
    // always follows headless (single source of truth), never the reverse.
    if (this.headless.cols !== spawnCols || this.headless.rows !== spawnRows) {
      pty.resize(this.headless.cols, this.headless.rows);
    }
    this.armStabilityTimer(generation);
    this.armFollowTimer();
  }

  private async resolveAttachCapability(
    factory: PtyFactory,
    host: HostConfig | undefined,
    env: Record<string, string>,
  ): Promise<boolean> {
    if (this.attachFlagged !== null) return this.attachFlagged;
    const g = this.geometry;
    if (!g) return false;
    let output: string;
    try {
      output = await g.raceProbe(() => this.startAttachProbe(factory, host, env));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(`[pane-streamer] ${this.agent.id} attach capability probe failed (flagless this spawn): ${detail}`);
      return false;
    }
    const capability = parseAttachFlagCapability(output);
    if (capability === null) {
      console.warn(
        `[pane-streamer] ${this.agent.id} attach capability probe unparseable (flagless this spawn): ${JSON.stringify(output.slice(0, 120))}`,
      );
      return false;
    }
    this.attachFlagged = capability;
    return capability;
  }

  private startAttachProbe(
    factory: PtyFactory,
    host: HostConfig | undefined,
    env: Record<string, string>,
  ): ProbeHandle<string> {
    const cmd = buildAttachProbeCommand(this.agent, host);
    if (Object.keys(env).length > 0) cmd.env = env;
    const pty = factory(cmd, 80, 24);
    let output = '';
    pty.onData((data: string) => { output += data; });
    const settled = new Promise<void>((resolve) => { pty.onExit(() => resolve()); });
    return {
      result: settled.then(() => output),
      settled,
      // SIGKILL cannot be ignored: a hung probe reliably reaches onExit, releasing
      // its admission slot; anything still wedged stays registered as honest
      // backpressure. A kill throw propagates to the manager, which logs it with
      // the agent as target — never swallowed silently.
      onDeadline: () => pty.kill('SIGKILL'),
    };
  }

  private async alignSpawnBaseline(flagged: boolean): Promise<void> {
    const g = this.geometry;
    if (!g || !flagged || g.fullHolds() > 0) return;
    let geom: WindowGeometry;
    try {
      geom = await g.readGeometry();
    } catch {
      return;
    }
    if (this.destroyed) return;
    // holds flipping mid-read means a full subscriber owns geometry now; keep headless.
    if (g.fullHolds() > 0) return;
    const want = desiredTty(geom);
    if (want.cols === this.headless.cols && want.rows === this.headless.rows) return;
    this.headless.resize(want.cols, want.rows);
    this.scheduleSnapshotRefresh();
  }

  private armStabilityTimer(generation: number): void {
    this.clearStabilityTimer();
    this.stabilityTimer = setTimeout(() => {
      this.stabilityTimer = null;
      if (this.destroyed || generation !== this.ptyGeneration || !this.pty) return;
      this.reattachAttempts = 0;
      if (this.outageActive) {
        this.outageActive = false;
        console.log(`[pane-streamer] ${this.agent.id} attach recovered`);
      }
    }, this.reattachStableAfterMs);
    this.stabilityTimer?.unref?.();
  }

  private clearStabilityTimer(): void {
    if (this.stabilityTimer) {
      clearTimeout(this.stabilityTimer);
      this.stabilityTimer = null;
    }
  }

  private armFollowTimer(): void {
    if (this.followTimer || this.destroyed || !this.geometry || !this.currentPtyFlagged) return;
    this.followTimer = setInterval(() => { void this.followTick(); }, this.windowFollowIntervalMs);
    this.followTimer.unref?.();
  }

  private clearFollowTimer(): void {
    if (this.followTimer) {
      clearInterval(this.followTimer);
      this.followTimer = null;
    }
  }

  private async followTick(): Promise<void> {
    if (this.followInFlight) return;
    this.followInFlight = true;
    try {
      const g = this.geometry;
      if (!g || this.destroyed || !this.pty || !this.currentPtyFlagged) return;
      if (g.fullHolds() > 0) return;
      const generation = this.ptyGeneration;
      let geom: WindowGeometry;
      try {
        geom = await g.readGeometry();
      } catch (err) {
        if (!this.followReadFailing) {
          this.followReadFailing = true;
          const detail = err instanceof Error ? err.message : String(err);
          console.warn(`[pane-streamer] ${this.agent.id} follow geometry read failing: ${detail}`);
        }
        return;
      }
      if (this.followReadFailing) {
        this.followReadFailing = false;
        console.log(`[pane-streamer] ${this.agent.id} follow geometry read recovered`);
      }
      if (this.destroyed) return;
      if (geom.sizeMode === 'manual') {
        g.noteManualSeen();
        return;
      }
      const want = desiredTty(geom);
      if (want.cols === this.headless.cols && want.rows === this.headless.rows) return;
      // Commit-point recheck: the read was async and the world may have moved.
      if (this.destroyed || g.fullHolds() > 0 || generation !== this.ptyGeneration || !this.pty) return;
      try {
        // The hidden attach can die between the recheck and this call (onExit not
        // yet delivered); this runs on a bare interval, so a throw here would be
        // an unhandled rejection, not a client-visible resize_failed.
        this.pty.resize(want.cols, want.rows);
        this.headless.resize(want.cols, want.rows);
      } catch (err) {
        console.warn(`[pane-streamer] ${this.agent.id} follow resize raced pty exit:`, err);
        return;
      }
      this.scheduleSnapshotRefresh();
    } catch (err) {
      console.warn(`[pane-streamer] ${this.agent.id} follow tick failed:`, err);
    } finally {
      this.followInFlight = false;
    }
  }

  // Non-blocking, merged: geometry commits never wait on the data chain; one
  // pending node re-reads headless at run time, so the last geometry wins.
  scheduleSnapshotRefresh(): void {
    if (this.refreshPending || this.destroyed) return;
    this.refreshPending = true;
    this.onPtyDataChain = this.onPtyDataChain.then(() => {
      this.refreshPending = false;
      if (this.destroyed || this.refreshCbs.size === 0) return;
      const snapshot = {
        cols: this.headless.cols,
        rows: this.headless.rows,
        data: this.serialize.serialize(),
      };
      const seq = this.lastBroadcastSeq;
      for (const cb of [...this.refreshCbs]) {
        try { cb(snapshot, seq); } catch {}
      }
    }).catch((err) => {
      // A rejected tail would silently swallow every later write/subscribe on
      // this chain; recover it so one bad serialize can't kill the stream.
      this.refreshPending = false;
      console.warn(`[pane-streamer] ${this.agent.id} snapshot refresh failed:`, err);
    });
  }

  acquireFullHold(): () => void {
    if (!this.geometry) return () => undefined;
    return this.geometry.acquireFullHold();
  }

  private onPtyData(data: string): void {
    this.onPtyDataChain = this.onPtyDataChain.then(async () => {
      if (this.destroyed) return;
      const seq = this.nextSeq++;
      await new Promise<void>((resolve) => this.headless.write(data, () => resolve()));
      this.lastBroadcastSeq = seq;
      for (const cb of [...this.live]) {
        try { cb(data, seq); } catch {}
      }
    });
  }

  async subscribeAtomic(cbs: SubscriberCallbacks): Promise<SubscribeResult> {
    this.cancelIdleTimer();
    await this.ensureStarted();
    return new Promise((resolve, reject) => {
      this.onPtyDataChain = this.onPtyDataChain.then(() => {
        if (this.destroyed) {
          reject(new Error('PaneStreamer destroyed before subscribe'));
          return;
        }
        const snapshot: PaneSnapshot = {
          cols: this.headless.cols,
          rows: this.headless.rows,
          data: this.serialize.serialize(),
        };
        const snapshotSeq = this.lastBroadcastSeq;
        this.live.add(cbs.onLive);
        this.sessionGoneCbs.add(cbs.onSessionGone);
        if (cbs.onSnapshotRefresh) this.refreshCbs.add(cbs.onSnapshotRefresh);
        resolve({
          unsubscribe: () => this.unsubscribeOne(cbs),
          snapshot,
          snapshotSeq,
        });
      });
    });
  }

  async getSnapshotAtomic(): Promise<GetSnapshotResult> {
    this.cancelIdleTimer();
    await this.ensureStarted();
    return new Promise((resolve, reject) => {
      this.onPtyDataChain = this.onPtyDataChain.then(() => {
        if (this.destroyed) {
          reject(new Error('PaneStreamer destroyed before snapshot'));
          return;
        }
        const snapshot: PaneSnapshot = {
          cols: this.headless.cols,
          rows: this.headless.rows,
          data: this.serialize.serialize(),
        };
        resolve({ snapshot, snapshotSeq: this.lastBroadcastSeq });
      });
    });
  }

  // Full target lands in owner state before any exec, and the local stream follows
  // immediately (the client xterm already fitted); the tmux write may fail, but the
  // target survives for the reconciler to converge on.
  async resize(cols: number, rows: number): Promise<void> {
    if (this.destroyed) throw new Error('PaneStreamer is destroyed');
    const g = this.geometry;
    g?.recordFullTarget({ cols, rows });
    this.pty?.resize(cols, rows);
    this.headless.resize(cols, rows);
    this.scheduleSnapshotRefresh();
    // The manager's owner write carries the triple∧claim∧generation guard server-side,
    // so a foreign or reissued same-name session can never be resized from here.
    if (g) await g.commitOwnerResize();
  }

  async sendInput(data: string): Promise<void> {
    if (this.destroyed) throw new Error('PaneStreamer is destroyed');
    if (data.length === 0) return;
    await this.ensureStarted();
    if (!this.pty) throw new Error('PaneStreamer pty unavailable');
    this.pty.write(data);
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  get size(): TtySize {
    return { cols: this.headless.cols, rows: this.headless.rows };
  }

  destroy(opts: { silent?: boolean } = {}): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.reattachTimer) {
      clearTimeout(this.reattachTimer);
      this.reattachTimer = null;
    }
    const goneCbs = [...this.sessionGoneCbs];
    this.sessionGoneCbs.clear();
    this.live.clear();
    this.refreshCbs.clear();
    if (!opts.silent) {
      for (const cb of goneCbs) {
        try { cb(); } catch {}
      }
    }
    this.killAttachPty();
  }

  private killAttachPty(): void {
    this.clearStabilityTimer();
    this.clearFollowTimer();
    // Discard any quarantined (unverified) output with the PTY — it must never reach the browser.
    this.attachQuarantined = false;
    this.quarantineBuffer = [];
    if (this.pty) {
      const pty = this.pty;
      this.pty = null;
      try { pty.kill(); } catch {}
    }
  }

  private async handleAttachExit(): Promise<void> {
    if (this.destroyed) return;
    if (this.live.size === 0 && this.sessionGoneCbs.size === 0) {
      this.scheduleIdleIfEmpty();
      return;
    }

    // Reconnect only into our pinned generation; a bare hasSession(name) would reattach Web I/O into a fresh server's same-name session.
    let ownership: 'owned' | 'gone' | null = null;
    try {
      ownership = await this.checkOwnership();
    } catch (err) {
      this.noteOutage(err); // transport-uncertain → backoff retry (attemptAttach re-verifies), never spawn now
    }
    if (this.destroyed) return;
    if (ownership === 'gone') {
      this.markSessionGone();
      return;
    }
    this.scheduleReattach();
  }

  private scheduleReattach(): void {
    if (this.destroyed || this.pty || this.reattaching || this.reattachTimer) return;
    const run = () => {
      this.ensureAttachPty().catch((err) => {
        if (this.destroyed) return;
        this.noteOutage(err);
        this.scheduleReattach();
      });
    };
    const delay = computeBackoffMs(++this.reattachAttempts, {
      baseMs: this.reattachDelayMs,
      maxMs: this.reattachMaxDelayMs,
      jitter: this.reattachJitter,
      random: this.random,
    });
    this.reattachTimer = setTimeout(() => {
      this.reattachTimer = null;
      run();
    }, delay);
  }

  private noteOutage(err: unknown): void {
    if (this.outageActive) return;
    this.outageActive = true;
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(`[pane-streamer] ${this.agent.id} attach failing; backing off retries: ${detail}`);
  }

  private markSessionGone(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.reattachTimer) {
      clearTimeout(this.reattachTimer);
      this.reattachTimer = null;
    }
    const cbs = [...this.sessionGoneCbs];
    this.sessionGoneCbs.clear();
    this.live.clear();
    this.refreshCbs.clear();
    this.killAttachPty();
    for (const cb of cbs) {
      try { cb(); } catch {}
    }
  }

  private unsubscribeOne(cbs: SubscriberCallbacks): void {
    this.live.delete(cbs.onLive);
    this.sessionGoneCbs.delete(cbs.onSessionGone);
    if (cbs.onSnapshotRefresh) this.refreshCbs.delete(cbs.onSnapshotRefresh);
    this.scheduleIdleIfEmpty();
  }

  private scheduleIdleIfEmpty(): void {
    if (this.destroyed) return;
    if (this.live.size > 0 || this.sessionGoneCbs.size > 0) return;
    if (this.idleTimer) return;
    if (this.idleGraceMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.live.size === 0 && this.sessionGoneCbs.size === 0 && !this.destroyed) {
        this.destroy();
      }
    }, this.idleGraceMs);
  }

  private cancelIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  _waitForChainDrain(): Promise<void> {
    return this.onPtyDataChain;
  }
}
