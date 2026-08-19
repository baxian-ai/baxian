import type { AgentConfig, BaxianEvent, EventType } from '../shared/index.js';
import type { EventBus } from '../event/bus.js';
import type { PaneStreamerManager } from './pane-streamer-manager.js';
import {
  compactBoundaryIndex,
  scanAskAnswerSignals,
  scanPhaseSignalMatches,
  scanPhaseSignals,
  type NeedInputSignal,
  type PhaseSignal,
  type PhaseSignalKind,
} from './phase-signal.js';
import { visibleText } from './vt-visible-text.js';

export interface NeedInputCommitIntent {
  agentId: string;
  taskId: string;
  epoch: number;
  askSeq: number;
  answeredSeq: number;
}

export type NeedInputCommitResult = 'ok' | 'fenced' | 'error';

interface SettlingEntry {
  active: number;
  promise: Promise<void>;
  resolve: () => void;
}

const MATCH_BUFFER_CHARS = 1024;

const STALE_TOKEN_WARN_CAP = 32;

const KIND_TO_EVENT_TYPE: Record<Exclude<PhaseSignalKind, 'greeting'>, EventType> = {
  'pr-created': 'pr.created',
  'pr-fixed': 'pr.fix.submitted',
  'pr-merge-ready': 'pr.updated',
  'spec-done': 'spec.ready',
};

interface WatchEntry {
  taskId: string;
  projectId: string;
  agentId: string;
  expectedKinds: ReadonlySet<PhaseSignalKind>;
  expectedToken: string;
  seenStaleToken: Set<string>;
  staleWarnCapped: boolean;
  askSeq: number;
  answeredSeq: number;
  epoch: number;
  snapshotReconcile: boolean;
  commitEnabled: boolean;
  needInputBuffer: string;
  recovered: boolean;
  buffer: string;
  unsubscribe: () => void;
  fired: boolean;
}

export interface PhaseSignalWatcherDeps {
  paneStreamerManager: PaneStreamerManager;
  eventBus: EventBus;
  resolveAgent: (agentId: string) => AgentConfig | undefined;
  commitNeedInputWatermark?: (intent: NeedInputCommitIntent) => Promise<NeedInputCommitResult>;
}

export interface PhaseSignalWatcherStartArgs {
  taskId: string;
  projectId: string;
  agentId: string;
  expectedKinds: PhaseSignalKind | readonly PhaseSignalKind[] | ReadonlySet<PhaseSignalKind>;
  token: string;
  needInput?: { epoch: number; askSeq: number; answeredSeq: number };
  needInputInherit?: boolean;
  skipSnapshot?: boolean;
  recovered?: boolean;
  onlyReplaceOwnToken?: boolean;
  replaceFromToken?: string;
  armClaimId?: number;
  replaceScope?: 'task' | 'agent';
}

function normalizeKinds(
  input: PhaseSignalKind | readonly PhaseSignalKind[] | ReadonlySet<PhaseSignalKind>,
): ReadonlySet<PhaseSignalKind> {
  if (input instanceof Set) return input;
  if (Array.isArray(input)) return new Set(input);
  return new Set([input as PhaseSignalKind]);
}

function entryKey(taskId: string, agentId: string): string {
  return `${taskId}:${agentId}`;
}

const ARM_FENCE_CAP = 4096;

interface ArmFence {
  highWater: number;
  latestSeq: number;
}

export class PhaseSignalWatcher {
  private readonly entries = new Map<string, WatchEntry>();
  private readonly armFences = new Map<string, ArmFence>();
  private readonly pendingArms = new Map<number, { taskId: string; agentId: string; token: string }>();
  private armCounter = 0;
  private readonly settlingByTask = new Map<string, SettlingEntry>();

  constructor(private readonly deps: PhaseSignalWatcherDeps) {}

  isSettling(taskId: string): boolean {
    return this.settlingByTask.has(taskId);
  }

  async awaitSettled(taskId: string): Promise<void> {
    const settling = this.settlingByTask.get(taskId);
    if (settling) await settling.promise;
  }

  private beginSettling(taskId: string): SettlingEntry {
    const current = this.settlingByTask.get(taskId);
    if (current) {
      current.active += 1;
      return current;
    }
    let resolve!: () => void;
    const settling = {
      active: 1,
      promise: new Promise<void>(settled => { resolve = settled; }),
      resolve: () => resolve(),
    };
    this.settlingByTask.set(taskId, settling);
    return settling;
  }

  private endSettling(taskId: string, settling: SettlingEntry): void {
    if (this.settlingByTask.get(taskId) !== settling) return;
    settling.active -= 1;
    if (settling.active > 0) return;
    this.settlingByTask.delete(taskId);
    settling.resolve();
  }

  private taskEntries(taskId: string): WatchEntry[] {
    return [...this.entries.values()].filter(entry => entry.taskId === taskId);
  }

  private replaceTargets(args: PhaseSignalWatcherStartArgs): WatchEntry[] {
    if (args.replaceScope === 'agent') {
      const own = this.entries.get(entryKey(args.taskId, args.agentId));
      return own ? [own] : [];
    }
    return this.taskEntries(args.taskId);
  }

  async start(args: PhaseSignalWatcherStartArgs): Promise<boolean> {
    const key = entryKey(args.taskId, args.agentId);
    const predecessor = this.entries.get(key);
    if (args.needInput !== undefined && args.needInputInherit
      && predecessor?.expectedToken === args.token) {
      this.migrateEntryGeneration(predecessor, args.needInput, true);
    }
    const rejectArm = (): false => {
      if (args.needInput !== undefined
        && predecessor
        && this.entries.get(key) === predecessor
        && (args.replaceFromToken === undefined || predecessor.expectedToken === args.token)) {
        this.migrateEntryGeneration(
          predecessor,
          args.needInput,
          args.needInputInherit === true && predecessor.expectedToken === args.token,
        );
      }
      return false;
    };
    if (!this.ownsArmClaim(args, args.armClaimId)) return rejectArm();
    if (this.hasForeignTokenOwner(args, args.armClaimId)) return rejectArm();
    const armSeq = ++this.armCounter;
    this.touchArmFence(key, armSeq, args.needInput?.epoch);
    const expectedKinds = normalizeKinds(args.expectedKinds);
    const kindsLabel = [...expectedKinds].join(',');

    const agent = this.deps.resolveAgent(args.agentId);
    if (!agent) {
      console.warn(
        `[PhaseSignalWatcher] resolveAgent returned undefined for agentId=${args.agentId} (task=${args.taskId} expected=${kindsLabel}); no watcher set up`,
      );
      await this.emitInterventionFireAndForget({
        taskId: args.taskId,
        projectId: args.projectId,
        agentId: args.agentId,
        phase: `signal-setup-no-agent:${kindsLabel}`,
      });
      return rejectArm();
    }

    const streamer = this.deps.paneStreamerManager.ensure(agent);
    const entry: WatchEntry = {
      taskId: args.taskId,
      projectId: args.projectId,
      agentId: args.agentId,
      expectedKinds,
      expectedToken: args.token,
      seenStaleToken: new Set(),
      staleWarnCapped: false,
      askSeq: args.needInput?.askSeq ?? 0,
      answeredSeq: args.needInput?.answeredSeq ?? 0,
      epoch: args.needInput?.epoch ?? 0,
      snapshotReconcile: args.needInputInherit === true && args.needInput !== undefined,
      commitEnabled: args.needInput !== undefined,
      needInputBuffer: '',
      recovered: args.recovered ?? false,
      buffer: '',
      unsubscribe: () => undefined,
      fired: false,
    };

    let sub;
    try {
      sub = await streamer.subscribeAtomic({
        onVisible: (visible) => this.onPaneData(entry, visible),
        onSessionGone: () => this.onSessionGone(entry),
      });
    } catch (err) {
      console.warn(
        `[PhaseSignalWatcher] subscribe failed for task=${args.taskId} expected=${kindsLabel} agent=${args.agentId}:`,
        err,
      );
      await this.emitInterventionFireAndForget({
        taskId: args.taskId,
        projectId: args.projectId,
        agentId: args.agentId,
        phase: `signal-setup-failed:${kindsLabel}`,
        error: err instanceof Error ? err.message : String(err),
      });
      return rejectArm();
    }

    const raced = this.replaceTargets(args);
    const rejectAfterSubscribe = (): false => {
      try { sub.unsubscribe(); } catch {}
      return rejectArm();
    };
    if (this.hasForeignTokenOwner(args, args.armClaimId)) return rejectAfterSubscribe();
    const own = this.entries.get(key);
    if (own?.commitEnabled && args.needInput !== undefined && own.epoch > args.needInput.epoch) {
      return rejectAfterSubscribe();
    }
    const fence = this.armFences.get(key);
    if (args.needInput !== undefined && (fence?.highWater ?? 0) > args.needInput.epoch) {
      return rejectAfterSubscribe();
    }
    if (fence !== undefined && fence.latestSeq !== armSeq) {
      return rejectAfterSubscribe();
    }

    if (args.needInput === undefined && own) {
      entry.epoch = own.epoch;
      entry.commitEnabled = false;
      if (args.needInputInherit) {
        entry.askSeq = Math.max(entry.askSeq, own.askSeq);
        entry.answeredSeq = Math.max(entry.answeredSeq, own.answeredSeq);
      }
    }
    const prior = args.needInputInherit
      ? raced.find(existing =>
          existing.taskId === args.taskId
          && existing.agentId === args.agentId
          && existing.expectedToken === args.token,
        )
      : undefined;
    if (prior) {
      entry.askSeq = Math.max(entry.askSeq, prior.askSeq);
      entry.answeredSeq = Math.max(entry.answeredSeq, prior.answeredSeq);
    }
    for (const existing of raced) this.dropEntry(existing);
    entry.unsubscribe = sub.unsubscribe;
    this.entries.set(key, entry);

    if (args.needInput !== undefined
      && (entry.askSeq > args.needInput.askSeq || entry.answeredSeq > args.needInput.answeredSeq)) {
      this.commitWatermark(entry);
    }

    if (!args.skipSnapshot) {
      this.onPaneData(entry, visibleText(sub.snapshot.data, sub.snapshot.cols, sub.snapshot.rows), true);
    }
    return true;
  }

  private touchArmFence(key: string, armSeq: number, epoch?: number): void {
    const cur = this.armFences.get(key);
    const next: ArmFence = {
      highWater: Math.max(cur?.highWater ?? 0, epoch ?? 0),
      latestSeq: Math.max(cur?.latestSeq ?? 0, armSeq),
    };
    this.armFences.delete(key);
    this.armFences.set(key, next);
    if (this.armFences.size > ARM_FENCE_CAP) {
      const oldest = this.armFences.keys().next().value;
      if (oldest !== undefined) this.armFences.delete(oldest);
    }
  }

  private hasForeignTokenOwner(
    args: {
      taskId: string;
      agentId: string;
      token: string;
      onlyReplaceOwnToken?: boolean;
      replaceFromToken?: string;
      replaceScope?: 'task' | 'agent';
    },
    selfArmId?: number,
  ): boolean {
    if (!args.onlyReplaceOwnToken) return false;
    const installed = this.replaceTargets({
      taskId: args.taskId,
      agentId: args.agentId,
      ...(args.replaceScope ? { replaceScope: args.replaceScope } : {}),
    } as PhaseSignalWatcherStartArgs);
    const replaceFromToken = args.replaceScope === 'agent' ? args.replaceFromToken : undefined;
    if (installed.some(entry =>
      entry.expectedToken !== args.token && entry.expectedToken !== replaceFromToken,
    )) return true;
    for (const [id, arm] of this.pendingArms) {
      if (id === selfArmId) continue;
      if (arm.taskId !== args.taskId) continue;
      if (args.replaceScope === 'agent' && arm.agentId !== args.agentId) continue;
      if (arm.token !== args.token) return true;
    }
    return false;
  }

  wouldRejectOwnTokenArm(args: {
    taskId: string;
    agentId: string;
    token: string;
    onlyReplaceOwnToken?: boolean;
    replaceFromToken?: string;
    replaceScope?: 'task' | 'agent';
  }): boolean {
    return this.hasForeignTokenOwner(args);
  }

  claimArm(args: {
    taskId: string;
    agentId: string;
    token: string;
    onlyReplaceOwnToken?: boolean;
    replaceFromToken?: string;
    replaceScope?: 'task' | 'agent';
  }): number | null {
    if (this.hasForeignTokenOwner(args)) return null;
    const armId = ++this.armCounter;
    this.pendingArms.set(armId, { taskId: args.taskId, agentId: args.agentId, token: args.token });
    return armId;
  }

  releaseArm(armId: number | null | undefined): void {
    if (armId != null) this.pendingArms.delete(armId);
  }

  private ownsArmClaim(args: PhaseSignalWatcherStartArgs, armId: number | undefined): boolean {
    if (armId === undefined) return true;
    const claim = this.pendingArms.get(armId);
    return claim?.taskId === args.taskId
      && claim.agentId === args.agentId
      && claim.token === args.token;
  }

  private migrateEntryGeneration(
    entry: WatchEntry,
    wm: { epoch: number; askSeq: number; answeredSeq: number },
    inherit: boolean,
  ): void {
    if (entry.commitEnabled && entry.epoch >= wm.epoch) return;
    entry.epoch = wm.epoch;
    entry.commitEnabled = true;
    this.touchArmFence(entryKey(entry.taskId, entry.agentId), 0, wm.epoch);
    if (!inherit) {
      entry.askSeq = wm.askSeq;
      entry.answeredSeq = wm.answeredSeq;
      entry.snapshotReconcile = false;
      return;
    }
    const leads = entry.askSeq > wm.askSeq || entry.answeredSeq > wm.answeredSeq;
    entry.askSeq = Math.max(entry.askSeq, wm.askSeq);
    entry.answeredSeq = Math.max(entry.answeredSeq, wm.answeredSeq);
    if (leads) this.commitWatermark(entry);
  }

  private dropEntry(entry: WatchEntry): void {
    this.entries.delete(entryKey(entry.taskId, entry.agentId));
    try { entry.unsubscribe(); } catch {}
  }

  stop(taskId: string): void {
    for (const entry of this.taskEntries(taskId)) this.dropEntry(entry);
  }

  stopAgent(taskId: string, agentId: string): void {
    const entry = this.entries.get(entryKey(taskId, agentId));
    if (entry) this.dropEntry(entry);
  }

  stopIfToken(taskId: string, expectedToken: string): void {
    for (const entry of this.taskEntries(taskId)) {
      if (entry.expectedToken === expectedToken) this.dropEntry(entry);
    }
  }

  stopAgentIfToken(taskId: string, agentId: string, expectedToken: string): void {
    const entry = this.entries.get(entryKey(taskId, agentId));
    if (entry?.expectedToken === expectedToken) this.dropEntry(entry);
  }

  has(taskId: string, agentId?: string): boolean {
    if (agentId !== undefined) return this.entries.has(entryKey(taskId, agentId));
    return this.taskEntries(taskId).length > 0;
  }

  expectedKindsFor(taskId: string): ReadonlySet<PhaseSignalKind> {
    const union = new Set<PhaseSignalKind>();
    for (const entry of this.taskEntries(taskId)) {
      for (const kind of entry.expectedKinds) union.add(kind);
    }
    return union;
  }

  isRecovered(taskId: string): boolean {
    return this.taskEntries(taskId).some(entry => entry.recovered);
  }

  async awaitOnce(args: {
    agentId: string;
    kind: PhaseSignalKind;
    token: string;
    timeoutMs: number;
  }): Promise<'matched' | 'timeout' | 'session-gone' | 'no-agent'> {
    const agent = this.deps.resolveAgent(args.agentId);
    if (!agent) return 'no-agent';
    const streamer = this.deps.paneStreamerManager.ensure(agent);
    return new Promise((resolve) => {
      let buffer = '';
      let done = false;
      let unsubscribe: () => void = () => undefined;
      const finish = (outcome: 'matched' | 'timeout' | 'session-gone'): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { unsubscribe(); } catch {}
        resolve(outcome);
      };
      const matches = (chunk: string): boolean => {
        const combined = buffer + chunk;
        buffer = combined.slice(-MATCH_BUFFER_CHARS);
        return scanPhaseSignals(combined).some(
          (s) => s.kind === args.kind && s.token === args.token,
        );
      };
      const timer = setTimeout(() => finish('timeout'), args.timeoutMs);
      streamer
        .subscribeAtomic({
          onVisible: (visible) => { if (matches(visible)) finish('matched'); },
          onSessionGone: () => finish('session-gone'),
        })
        .then((sub) => {
          unsubscribe = sub.unsubscribe;
          if (done) { try { sub.unsubscribe(); } catch {} return; }
          if (matches(visibleText(sub.snapshot.data, sub.snapshot.cols, sub.snapshot.rows))) finish('matched');
        })
        .catch(() => finish('session-gone'));
    });
  }

  private commitWatermark(entry: WatchEntry): void {
    const commit = this.deps.commitNeedInputWatermark;
    if (!commit || !entry.commitEnabled) return;
    void commit({
      agentId: entry.agentId,
      taskId: entry.taskId,
      epoch: entry.epoch,
      askSeq: entry.askSeq,
      answeredSeq: entry.answeredSeq,
    }).catch(() => undefined);
  }

  private markAnswered(entry: WatchEntry): boolean {
    if (entry.askSeq <= entry.answeredSeq) return false;
    entry.answeredSeq = entry.askSeq;
    return true;
  }

  async rearmNeedInput(agentId: string): Promise<Set<string>> {
    const handled = new Set<string>();
    const commits: Promise<NeedInputCommitResult>[] = [];
    for (const entry of this.entries.values()) {
      if (entry.agentId !== agentId) continue;
      if (entry.commitEnabled) handled.add(entry.taskId);
      if (!this.markAnswered(entry)) continue;
      const commit = this.deps.commitNeedInputWatermark;
      if (!commit || !entry.commitEnabled) continue;
      commits.push(commit({
        agentId: entry.agentId,
        taskId: entry.taskId,
        epoch: entry.epoch,
        askSeq: entry.askSeq,
        answeredSeq: entry.answeredSeq,
      }).catch((): NeedInputCommitResult => 'error'));
    }
    await Promise.all(commits);
    return handled;
  }

  private onAskSignal(entry: WatchEntry, sig: NeedInputSignal): void {
    if (sig.seq !== undefined) {
      if (sig.seq <= entry.askSeq) return;
      entry.askSeq = sig.seq;
    } else {
      if (entry.askSeq > entry.answeredSeq) return;
      entry.askSeq += 1;
    }
    this.commitWatermark(entry);
  }

  private onAnswerSignal(entry: WatchEntry, sig: NeedInputSignal): void {
    if (entry.askSeq <= entry.answeredSeq) return;
    if (sig.seq !== undefined && sig.seq < entry.askSeq) return;
    if (this.markAnswered(entry)) this.commitWatermark(entry);
  }

  private scanNeedInput(entry: WatchEntry, chunk: string, isSnapshot: boolean): void {
    if (isSnapshot) {
      entry.needInputBuffer = chunk.slice(-MATCH_BUFFER_CHARS);
      if (!entry.snapshotReconcile) return;
      let maxAsk = 0;
      let maxAnswer = 0;
      for (const sig of scanAskAnswerSignals(chunk)) {
        if (sig.token !== entry.expectedToken || sig.seq === undefined) continue;
        if (sig.kind === 'ask') maxAsk = Math.max(maxAsk, sig.seq);
        else maxAnswer = Math.max(maxAnswer, sig.seq);
      }
      const askSeq = Math.max(entry.askSeq, maxAsk);
      const answeredSeq = Math.min(askSeq, Math.max(entry.answeredSeq, maxAnswer));
      if (askSeq === entry.askSeq && answeredSeq === entry.answeredSeq) return;
      entry.askSeq = askSeq;
      entry.answeredSeq = answeredSeq;
      this.commitWatermark(entry);
      return;
    }
    const combined = entry.needInputBuffer + chunk;
    const oldRegionLen = compactBoundaryIndex(combined, entry.needInputBuffer.length);
    entry.needInputBuffer = combined.slice(-MATCH_BUFFER_CHARS);
    for (const sig of scanAskAnswerSignals(combined)) {
      if (sig.token !== entry.expectedToken) continue;
      if (sig.index + sig.raw.length <= oldRegionLen) continue;
      if (sig.kind === 'ask') this.onAskSignal(entry, sig);
      else this.onAnswerSignal(entry, sig);
    }
  }

  private onPaneData(entry: WatchEntry, chunk: string, isSnapshot = false): void {
    if (this.entries.get(entryKey(entry.taskId, entry.agentId)) !== entry) return;
    if (entry.fired) return;
    const combined = entry.buffer + chunk;
    this.scanNeedInput(entry, chunk, isSnapshot);
    const oldRegionLen = compactBoundaryIndex(combined, entry.buffer.length);
    const matches = scanPhaseSignalMatches(combined);
    entry.buffer = combined.slice(-MATCH_BUFFER_CHARS);
    const armed = matches.find(m =>
      entry.expectedKinds.has(m.signal.kind) && m.signal.token === entry.expectedToken,
    );
    if (!isSnapshot) {
      const endsBy = armed ? armed.index : Infinity;
      this.reportStaleTokens(
        entry,
        matches.filter(m => m.index + m.raw.length > oldRegionLen && m.index + m.raw.length <= endsBy).map(m => m.signal),
      );
    }
    const signal = armed?.signal;
    if (!signal) return;
    if (signal.kind === 'greeting') return;
    entry.fired = true;
    this.entries.delete(entryKey(entry.taskId, entry.agentId));
    try { entry.unsubscribe(); } catch {}
    if (this.markAnswered(entry)) this.commitWatermark(entry);
    const event: BaxianEvent = {
      id: '',
      type: KIND_TO_EVENT_TYPE[signal.kind],
      timestamp: new Date().toISOString(),
      projectId: entry.projectId,
      agentId: entry.agentId,
      taskId: entry.taskId,
      data: {
        kind: signal.kind,
        token: signal.token,
        verdictAgentId: entry.agentId,
        source: 'pane-signal',
        ...(signal.kind === 'pr-created' || signal.kind === 'spec-done'
          ? { prNumber: signal.prNumber }
          : {}),
      },
    };
    const settling = this.beginSettling(entry.taskId);
    void this.emitCompletion(event, entry, signal.kind, settling);
  }

  private reportStaleTokens(entry: WatchEntry, candidates: readonly PhaseSignal[]): void {
    for (const candidate of candidates) {
      if (entry.staleWarnCapped) return;
      if (candidate.kind === 'greeting') continue;
      if (!entry.expectedKinds.has(candidate.kind)) continue;
      if (candidate.token === entry.expectedToken) continue;
      const seenKey = `${candidate.kind}:${candidate.token}`;
      if (entry.seenStaleToken.has(seenKey)) continue;
      if (entry.seenStaleToken.size >= STALE_TOKEN_WARN_CAP) {
        entry.staleWarnCapped = true;
        console.warn(
          `[PhaseSignalWatcher] capped foreign-token warnings at ${STALE_TOKEN_WARN_CAP} distinct tokens for `
          + `task=${entry.taskId} agent=${entry.agentId}; suppressing further (pane emitting token churn?)`,
        );
        return;
      }
      entry.seenStaleToken.add(seenKey);
      console.warn(
        `[PhaseSignalWatcher] discarded ${candidate.kind} signal with a foreign token for task=${entry.taskId} `
        + `agent=${entry.agentId}: observed=${candidate.token} expected=${entry.expectedToken}`,
      );
    }
  }

  private async emitCompletion(
    event: BaxianEvent,
    entry: WatchEntry,
    kind: PhaseSignalKind,
    settling: SettlingEntry,
  ): Promise<void> {
    try {
      await this.deps.eventBus.emit(event);
    } catch (err) {
      console.error(
        `[PhaseSignalWatcher] eventBus.emit failed for task=${entry.taskId} kind=${kind}:`,
        err,
      );
      await this.emitInterventionFireAndForget({
        taskId: entry.taskId,
        projectId: entry.projectId,
        agentId: entry.agentId,
        phase: `signal-emit-failed:${kind}`,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.endSettling(entry.taskId, settling);
    }
  }

  private onSessionGone(entry: WatchEntry): void {
    if (this.entries.get(entryKey(entry.taskId, entry.agentId)) !== entry) return;
    this.entries.delete(entryKey(entry.taskId, entry.agentId));
    if (entry.fired) return;
    if (this.markAnswered(entry)) this.commitWatermark(entry);
    const kindsLabel = [...entry.expectedKinds].join(',');
    void this.emitInterventionFireAndForget({
      taskId: entry.taskId,
      projectId: entry.projectId,
      agentId: entry.agentId,
      phase: `signal-session-gone:${kindsLabel}`,
    });
  }

  private async emitInterventionFireAndForget(data: {
    taskId: string;
    projectId: string;
    agentId: string;
    phase: string;
    error?: string;
  }): Promise<void> {
    try {
      await this.deps.eventBus.emit({
        id: '',
        type: 'human.intervention',
        timestamp: new Date().toISOString(),
        projectId: data.projectId,
        agentId: data.agentId,
        taskId: data.taskId,
        data: {
          phase: data.phase,
          ...(data.error ? { error: data.error } : {}),
        },
      });
    } catch (emitErr) {
      console.warn(
        `[PhaseSignalWatcher] intervention emit (${data.phase}) failed for task=${data.taskId}:`,
        emitErr,
      );
    }
  }
}
