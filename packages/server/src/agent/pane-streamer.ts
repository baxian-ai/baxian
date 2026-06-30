import { accessSync, chmodSync, constants, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { AgentConfig, HostConfig } from '../shared/index.js';
import xterm from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import { buildAttachInteractiveCommand, type AttachCommand } from '../terminal/attach.js';
import type { CommandRunner } from './runner.js';
import { sshEnv } from './runner.js';
import { TmuxManager } from './tmux.js';
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
  ptyFactory?: PtyFactory;
  random?: () => number;
}

export interface PaneSnapshot {
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
  private destroyed = false;
  private starting: Promise<void> | null = null;
  private started = false;

  private readonly scrollbackLines: number;
  private readonly idleGraceMs: number;
  private readonly reattachDelayMs: number;
  private readonly reattachMaxDelayMs: number;
  private readonly reattachJitter: number;
  private readonly reattachStableAfterMs: number;
  private readonly sessionProbeTimeoutMs: number;
  private readonly initialCols: number;
  private readonly initialRows: number;
  private readonly ptyFactoryProvided: PtyFactory | undefined;
  private readonly random: () => number;

  constructor(
    private readonly agent: AgentConfig,
    private readonly tmux: TmuxManager,
    _runner: CommandRunner,
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
    const p = this.spawnAttachPty().finally(() => {
      if (this.reattaching === p) this.reattaching = null;
    });
    this.reattaching = p;
    return p;
  }

  private async spawnAttachPty(): Promise<void> {
    const factory = this.ptyFactoryProvided ?? (await defaultPtyFactory());
    if (this.destroyed) throw new Error('PaneStreamer destroyed during attach');
    const host = this.resolveHost();
    const cmd = buildAttachInteractiveCommand(this.agent, host);
    const env = await sshEnv(host);
    if (Object.keys(env).length > 0) cmd.env = env;
    const pty = factory(cmd, this.headless.cols, this.headless.rows);
    const generation = ++this.ptyGeneration;
    this.pty = pty;

    pty.onData((data: string) => {
      if (generation !== this.ptyGeneration || this.destroyed) return;
      this.onPtyData(data);
    });
    pty.onExit(() => {
      if (generation !== this.ptyGeneration || this.destroyed) return;
      this.clearStabilityTimer();
      this.pty = null;
      void this.handleAttachExit();
    });
    this.armStabilityTimer(generation);
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

  async resize(cols: number, rows: number): Promise<void> {
    if (this.destroyed) throw new Error('PaneStreamer is destroyed');
    await this.tmux.resizeWindow(this.agent.id, cols, rows);
    this.pty?.resize(cols, rows);
    this.headless.resize(cols, rows);
    try {
      await this.tmux.setOption(this.agent.id, 'window-size', 'latest');
    } catch (err) {
      console.warn(`[pane-streamer] set window-size=latest failed after resize(${this.agent.id}):`, err);
    }
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
    if (!opts.silent) {
      for (const cb of goneCbs) {
        try { cb(); } catch {}
      }
    }
    this.killAttachPty();
  }

  private killAttachPty(): void {
    this.clearStabilityTimer();
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

    let sessionPresent: boolean | null = null;
    try {
      sessionPresent = await this.tmux.hasSession(this.agent.id, { timeout: this.sessionProbeTimeoutMs });
    } catch (err) {
      this.noteOutage(err);
    }
    if (this.destroyed) return;
    if (sessionPresent === false) {
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
    this.killAttachPty();
    for (const cb of cbs) {
      try { cb(); } catch {}
    }
  }

  private unsubscribeOne(cbs: SubscriberCallbacks): void {
    this.live.delete(cbs.onLive);
    this.sessionGoneCbs.delete(cbs.onSessionGone);
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
