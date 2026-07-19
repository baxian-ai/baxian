import type { AgentConfig, BaxianEvent, EventType } from '../shared/index.js';
import type { EventBus } from '../event/bus.js';
import type { PaneStreamerManager } from './pane-streamer-manager.js';
import {
  scanNeedInputSignals,
  scanPhaseSignals,
  scanReadFileSignals,
  type PhaseSignalKind,
  type ReadFileSignal,
} from './phase-signal.js';

const MATCH_BUFFER_CHARS = 1024;

const KIND_TO_EVENT_TYPE: Record<Exclude<PhaseSignalKind, 'greeting'>, EventType> = {
  'spec-fixed': 'server.spec.fix.submitted',
  'pr-created': 'pr.created',
  'pr-approved': 'review.submitted',
  'pr-changes-requested': 'review.submitted',
  'pr-fixed': 'pr.fix.submitted',
  'pr-merge-ready': 'pr.updated',
  'spec-done': 'server.spec.ready',
  'spec-reviewed': 'server.spec.review.submitted',
  'code-done': 'server.code.ready',
  'code-reviewed': 'server.code.review.submitted',
  'code-fixed': 'server.code.fix.submitted',
  'code-ready': 'server.code.published',
};

interface WatchEntry {
  taskId: string;
  projectId: string;
  agentId: string;
  expectedKinds: ReadonlySet<PhaseSignalKind>;
  expectedToken: string;
  onReadFile?: (req: ReadFileSignal) => void;
  seenReadFile: Set<string>;
  onNeedInput?: (pending: boolean) => void;
  needInputFired: boolean;
  // Separate tail window for need-input: rearmNeedInput() drops it so the
  // already-consumed literal cannot re-fire, without touching the phase-signal
  // buffer (clearing THAT could lose a phase signal torn across chunks).
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
}

export interface PhaseSignalWatcherStartArgs {
  taskId: string;
  projectId: string;
  agentId: string;
  expectedKinds: PhaseSignalKind | readonly PhaseSignalKind[] | ReadonlySet<PhaseSignalKind>;
  token: string;
  onReadFile?: (req: ReadFileSignal) => void;
  onNeedInput?: (pending: boolean) => void;
  skipSnapshot?: boolean;
  recovered?: boolean;
  // A fenced (re)arm may replace its own token's watch but never a successor's rotated one.
  onlyReplaceOwnToken?: boolean;
  // 'task' (default) evicts every entry of the task on arm; 'agent' touches only the
  // same (taskId, agentId) entry so a sibling watch (git dev reconciliation) survives.
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

export class PhaseSignalWatcher {
  private readonly entries = new Map<string, WatchEntry>();

  constructor(private readonly deps: PhaseSignalWatcherDeps) {}

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
    if (args.onlyReplaceOwnToken
      && this.replaceTargets(args).some(entry => entry.expectedToken !== args.token)) {
      return false;
    }
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
      return false;
    }

    const streamer = this.deps.paneStreamerManager.ensure(agent);
    const entry: WatchEntry = {
      taskId: args.taskId,
      projectId: args.projectId,
      agentId: args.agentId,
      expectedKinds,
      expectedToken: args.token,
      ...(args.onReadFile ? { onReadFile: args.onReadFile } : {}),
      seenReadFile: new Set(),
      ...(args.onNeedInput ? { onNeedInput: args.onNeedInput } : {}),
      needInputFired: false,
      needInputBuffer: '',
      recovered: args.recovered ?? false,
      buffer: '',
      unsubscribe: () => undefined,
      fired: false,
    };

    let sub;
    try {
      sub = await streamer.subscribeAtomic({
        onLive: (data) => this.onPaneData(entry, data),
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
      return false;
    }

    // A successor may have armed while the subscription was in flight.
    const raced = this.replaceTargets(args);
    if (raced.length > 0) {
      if (args.onlyReplaceOwnToken && raced.some(existing => existing.expectedToken !== args.token)) {
        try { sub.unsubscribe(); } catch {}
        return false;
      }
      for (const existing of raced) this.dropEntry(existing);
    }
    entry.unsubscribe = sub.unsubscribe;
    this.entries.set(entryKey(args.taskId, args.agentId), entry);

    if (!args.skipSnapshot) {
      this.onPaneData(entry, sub.snapshot.data, true);
    }
    return true;
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
          onLive: (data) => { if (matches(data)) finish('matched'); },
          onSessionGone: () => finish('session-gone'),
        })
        .then((sub) => {
          unsubscribe = sub.unsubscribe;
          if (done) { try { sub.unsubscribe(); } catch {} return; }
          if (matches(sub.snapshot.data)) finish('matched');
        })
        .catch(() => finish('session-gone'));
    });
  }

  // Re-arm takes effect immediately: dropping the need-input tail window means the
  // consumed literal cannot re-fire off the echo of the user's answer, while a
  // follow-up ask (arriving as new bytes) fires even when it comes right away.
  rearmNeedInput(agentId: string): void {
    for (const entry of this.entries.values()) {
      if (entry.agentId !== agentId) continue;
      if (!entry.needInputFired) continue;
      entry.needInputFired = false;
      entry.needInputBuffer = '';
    }
  }

  private scanNeedInput(entry: WatchEntry, chunk: string, isSnapshot: boolean): void {
    if (!entry.onNeedInput) return;
    // Snapshot content is ignored entirely (not even buffered). The persisted binding
    // flag alone carries pre-restart state: marking a scrollback literal as fired would
    // permanently swallow the next same-token ask when the user had already answered
    // before the restart, and a stale-but-still-open ask re-badges idempotently anyway.
    if (isSnapshot) return;
    const combined = entry.needInputBuffer + chunk;
    entry.needInputBuffer = combined.slice(-MATCH_BUFFER_CHARS);
    if (entry.needInputFired) return;
    if (!scanNeedInputSignals(combined).some(s => s.token === entry.expectedToken)) return;
    entry.needInputFired = true;
    entry.onNeedInput(true);
  }

  private onPaneData(entry: WatchEntry, chunk: string, isSnapshot = false): void {
    if (this.entries.get(entryKey(entry.taskId, entry.agentId)) !== entry) return;
    if (entry.fired) return;
    const rawCombined = entry.buffer + chunk;
    if (entry.onReadFile) {
      for (const req of scanReadFileSignals(rawCombined)) {
        if (entry.seenReadFile.has(req.raw)) continue;
        entry.seenReadFile.add(req.raw);
        if (!isSnapshot) entry.onReadFile(req);
      }
    }
    this.scanNeedInput(entry, chunk, isSnapshot);
    const signal = scanPhaseSignals(rawCombined).find(candidate =>
      entry.expectedKinds.has(candidate.kind) && candidate.token === entry.expectedToken,
    );
    entry.buffer = rawCombined.slice(-MATCH_BUFFER_CHARS);
    if (!signal) return;
    if (signal.kind === 'greeting') return;
    entry.fired = true;
    this.entries.delete(entryKey(entry.taskId, entry.agentId));
    try { entry.unsubscribe(); } catch {}
    // Unconditional: a recovered watch may not have rebuilt needInputFired even though
    // the persisted badge is set — the phase signal ends the dispatch either way.
    entry.onNeedInput?.(false);
    const verdictAction: 'APPROVE' | 'REQUEST_CHANGES' | undefined =
      signal.kind === 'pr-approved' ? 'APPROVE'
      : signal.kind === 'pr-changes-requested' ? 'REQUEST_CHANGES'
      : undefined;
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
        ...(signal.kind === 'pr-created' ? { prNumber: signal.prNumber } : {}),
        ...(signal.kind === 'pr-created' && signal.actorB64 !== undefined ? { actorB64: signal.actorB64 } : {}),
        ...(signal.kind === 'code-ready' && signal.prNumber !== undefined
          ? { prNumber: signal.prNumber }
          : {}),
        ...(verdictAction ? { action: verdictAction } : {}),
      },
    };
    void this.emitCompletion(event, entry, signal.kind);
  }

  private async emitCompletion(event: BaxianEvent, entry: WatchEntry, kind: PhaseSignalKind): Promise<void> {
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
    }
  }

  private onSessionGone(entry: WatchEntry): void {
    if (this.entries.get(entryKey(entry.taskId, entry.agentId)) !== entry) return;
    this.entries.delete(entryKey(entry.taskId, entry.agentId));
    if (entry.fired) return;
    entry.onNeedInput?.(false);
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
