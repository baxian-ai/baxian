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

// Cap so a stuck pane spewing endless distinct tokens can't grow the set or the logs unbounded.
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
  // Ask/answer watermark: lit ⟺ askSeq > answeredSeq. Monotonic within the entry;
  // replayed literals (redraw/reattach) carry seq ≤ watermark and are swallowed.
  askSeq: number;
  answeredSeq: number;
  // Persistence generation fixed by the arm-time bump write; stale-epoch commits fence server-side.
  epoch: number;
  // Whether this arm may read the pane snapshot as a record of its own generation.
  // False once a same-token replay has put two generations of the same ordinals on the
  // pane: nothing in a framebuffer can then attribute a literal to a generation.
  snapshotReconcile: boolean;
  // False when the arm could not establish a generation (bump failed / binding absent):
  // the badge degrades for this dispatch but signal watching must not — commits are
  // skipped instead of ghost-fencing against the persisted epoch.
  commitEnabled: boolean;
  // Separate tail window for ask/answer literals, distinct from the phase-signal
  // buffer (clearing THAT could lose a phase signal torn across chunks). Cleared on
  // every answered edge so a windowed BARE ask cannot re-fire after the answer.
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
  // Watermark state established by the arm-time epoch bump (restore carries prior seqs).
  needInput?: { epoch: number; askSeq: number; answeredSeq: number };
  // Merge the evicted same-token entry's in-memory seqs into the replacement. Only a
  // restore arm wants this: a fresh replay restarts its ordinals at 1, and inherited
  // seqs would swallow the new prompt's questions.
  needInputInherit?: boolean;
  skipSnapshot?: boolean;
  recovered?: boolean;
  // A fenced (re)arm may replace its own token's watch but never a successor's rotated one.
  onlyReplaceOwnToken?: boolean;
  // A token-rotating replay may hand off exactly its same-agent predecessor.
  replaceFromToken?: string;
  // Claim from claimArm(), excluded from this arm's own ownership probes.
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
  // Highest generation any arm ever CARRIED for this key (recorded at start entry, not
  // install): a successor that failed to subscribe or already exited must still fence a
  // late-settling older arm, or the stale watcher would resurrect on a dead generation.
  highWater: number;
  // Latest start() arrival for this key — orders arms that carry no generation
  // (degraded bump) where epochs cannot be compared.
  latestSeq: number;
}

export class PhaseSignalWatcher {
  private readonly entries = new Map<string, WatchEntry>();
  private readonly armFences = new Map<string, ArmFence>();
  // Arms that claimed ownership but have not installed yet (their subscribe is in
  // flight). The own-token fence must see them, or a stale replay would evict a
  // current-token pass whose watcher is merely slow to attach.
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
    // Everything up to the first await is one atomic section with the caller's epoch bump.
    const key = entryKey(args.taskId, args.agentId);
    const predecessor = this.entries.get(key);
    // The predecessor keeps consuming pane data while we subscribe: hand it this arm's
    // generation now, or answers it consumes in that window fence against the store.
    if (args.needInput !== undefined && args.needInputInherit
      && predecessor?.expectedToken === args.token) {
      this.migrateEntryGeneration(predecessor, args.needInput, true);
    }
    // Our caller bumped the store before calling us, so any rejection leaves the store
    // ahead of the installed entry. Rescue it — but only when it is still the very entry
    // this arm started against: a successor installed meanwhile owns a newer generation
    // and adopting ours would drag it back to a superseded watermark.
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
    // Fence bookkeeping happens on ENTRY, before any await: even an arm that later
    // fails to subscribe leaves its generation/arrival behind to fence older stragglers.
    const armSeq = ++this.armCounter;
    this.touchArmFence(key, armSeq, args.needInput?.epoch);
    // The old entry keeps consuming until the replacement subscription exists; a failed start must not orphan the signal.
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

    // ---- Fences first: every rejection must happen BEFORE any raced entry is dropped,
    // or a doomed stale arm would tear down a live sibling watcher on its way out.
    const raced = this.replaceTargets(args);
    const rejectAfterSubscribe = (): false => {
      try { sub.unsubscribe(); } catch {}
      return rejectArm();
    };
    if (this.hasForeignTokenOwner(args, args.armClaimId)) return rejectAfterSubscribe();
    const own = this.entries.get(key);
    // Generation-monotonic install: the bump order IS the arm order, so a smaller epoch
    // identifies a late arrival that must not demote the persisted generation. The fence
    // record (not the live entry) carries this across subscribe failures and exits.
    if (own?.commitEnabled && args.needInput !== undefined && own.epoch > args.needInput.epoch) {
      return rejectAfterSubscribe();
    }
    const fence = this.armFences.get(key);
    if (args.needInput !== undefined && (fence?.highWater ?? 0) > args.needInput.epoch) {
      return rejectAfterSubscribe();
    }
    // Arrival-order fence covers what epochs cannot: a degraded successor (no generation)
    // must still win over an older arm whose subscription settled after it.
    if (fence !== undefined && fence.latestSeq !== armSeq) {
      return rejectAfterSubscribe();
    }

    // ---- Install: merge, evict, subscribe hand-off.
    if (args.needInput === undefined && own) {
      // Degraded arm (bump failed): keep watching signals on the surviving entry's
      // generation, but honour the wm-null contract — no badge commits, and only a
      // restore intent may carry the ordinals (a fresh replay restarts at 1).
      entry.epoch = own.epoch;
      entry.commitEnabled = false;
      if (args.needInputInherit) {
        entry.askSeq = Math.max(entry.askSeq, own.askSeq);
        entry.answeredSeq = Math.max(entry.answeredSeq, own.answeredSeq);
      }
    }
    // Same-token restore transfer merges the predecessor's in-memory watermark: seqs it
    // advanced but never persisted (error'd commits) must survive the swap.
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

    // A merged watermark ahead of the bump write (the predecessor's error'd commits, whose
    // retry intents the arm just cleared) must reach the new generation's persistence now,
    // or a cleared badge could stay lit in the store forever.
    if (args.needInput !== undefined
      && (entry.askSeq > args.needInput.askSeq || entry.answeredSeq > args.needInput.answeredSeq)) {
      this.commitWatermark(entry);
    }

    if (!args.skipSnapshot) {
      // A serialized framebuffer is its own byte stream, not a continuation of the PTY one.
      this.onPaneData(entry, visibleText(sub.snapshot.data), true);
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

  // Read-only ownership probe (no claim) — the fence a would-be arm faces right now.
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

  // Atomic decide-and-claim, called before the caller's epoch bump: a rejected arm must
  // not bump (it would fence the owner), and a claimed arm must be visible to every
  // later ownership probe until it installs or fails.
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

  // Monotonic: never demote a generation a successor already owns. An in-memory lead
  // (seqs the entry advanced but could not persist) is written out immediately.
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
      // A fresh generation superseded whatever was open: adopt its stripped ordinals
      // instead of re-committing the old question into it.
      entry.askSeq = wm.askSeq;
      entry.answeredSeq = wm.answeredSeq;
      entry.snapshotReconcile = false;
      return;
    }
    const leads = entry.askSeq > wm.askSeq || entry.answeredSeq > wm.answeredSeq;
    // The watermark may lead the entry too (queue/ledger merges): adopt it, or the entry
    // would answer a question it does not know is open.
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

  // Token-fenced teardown: a stale pass undoing its own arm must never kill a successor's watcher.
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
          if (matches(visibleText(sub.snapshot.data))) finish('matched');
        })
        .catch(() => finish('session-gone'));
    });
  }

  private commitWatermark(entry: WatchEntry): void {
    const commit = this.deps.commitNeedInputWatermark;
    if (!commit || !entry.commitEnabled) return;
    // Fire-and-forget by design: memory seqs never roll back on a failed write —
    // the manager-side retry queue owns persistence convergence.
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

  // The user submitted input through baxian's own channel — the open question
  // (if any) counts as answered. Returns whether any entry watches this agent:
  // when one does, the store fallback must NOT run (it would re-read a moving
  // watermark and could confirm an ask that arrived after this input).
  // Returns the tasks whose watermark actually absorbed this input. Entries are settled
  // synchronously, before any await: a question printed while this runs must not be
  // swallowed as if it had been answered.
  async rearmNeedInput(agentId: string): Promise<Set<string>> {
    const handled = new Set<string>();
    const commits: Promise<NeedInputCommitResult>[] = [];
    for (const entry of this.entries.values()) {
      if (entry.agentId !== agentId) continue;
      // A commit-disabled (degraded) entry cannot persist the answer, so it must not
      // count as handled — the store fallback has to run instead.
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
      // Bare legacy ask: trust it only when no question is open (idempotent while lit).
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
    // Snapshot asks and BARE answers stay blind (replaying them would relight or clear
    // ambiguously), but a seq'd answer proves its numbered question was answered no
    // matter when it was printed — this recovers a reply given while the server was
    // down, which nothing else can carry (no ledger, no fallback, no live edge).
    if (isSnapshot) {
      // Seed the tail so a literal torn across the snapshot/live boundary still matches;
      // the old/new region split keeps the seeded bytes from being applied twice.
      entry.needInputBuffer = chunk.slice(-MATCH_BUFFER_CHARS);
      if (!entry.snapshotReconcile) return;
      // A snapshot is a serialized framebuffer, not an output log: a TUI redraw can put
      // later output on an earlier row, so screen position says nothing about time.
      // Ordinals do — within one generation each question is asked once and confirmed
      // once, so a literal's mere presence is the fact, wherever it sits.
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
    // Matches that end inside the old tail are rescans of already-processed bytes:
    // applying them again would let a swallowed answer clear a later ask, while
    // clearing the buffer instead would drop a torn next-ask prefix. Skipping them
    // keeps both; genuinely new literals (even replayed by a redraw as fresh bytes)
    // land in the new region and are handled by the seq watermark. The boundary is
    // mapped through the COMBINED compact transform — compacting the tail on its own
    // would misplace it whenever an escape/whitespace run straddles the chunk seam.
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

  // `chunk` is always visible text — decoded by PaneStreamer (live) or at the call site (snapshot).
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
    // The armed marker ends the dispatch, so a foreign token after it belongs to the next task, not a mis-send here.
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
    // The phase signal ends the dispatch: whatever question was open counts as closed.
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
          ? { prNumber: signal.prNumber, actorB64: signal.actorB64 }
          : {}),
      },
    };
    const settling = this.beginSettling(entry.taskId);
    void this.emitCompletion(event, entry, signal.kind, settling);
  }

  // 静默丢弃会把"agent 以为已交付、任务实际停等"变成查无实据的失联；故留痕，但只记日志不发事件（避免重放刷屏）。
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
