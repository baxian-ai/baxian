import type { AgentConfig, BaxianEvent, EventType } from '../shared/index.js';
import type { EventBus } from '../event/bus.js';
import type { PaneStreamerManager } from './pane-streamer-manager.js';
import {
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
  skipSnapshot?: boolean;
  recovered?: boolean;
}

function normalizeKinds(
  input: PhaseSignalKind | readonly PhaseSignalKind[] | ReadonlySet<PhaseSignalKind>,
): ReadonlySet<PhaseSignalKind> {
  if (input instanceof Set) return input;
  if (Array.isArray(input)) return new Set(input);
  return new Set([input as PhaseSignalKind]);
}

export class PhaseSignalWatcher {
  private readonly entries = new Map<string, WatchEntry>();

  constructor(private readonly deps: PhaseSignalWatcherDeps) {}

  async start(args: PhaseSignalWatcherStartArgs): Promise<boolean> {
    this.stop(args.taskId);
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

    entry.unsubscribe = sub.unsubscribe;
    this.entries.set(args.taskId, entry);

    if (!args.skipSnapshot) {
      this.onPaneData(entry, sub.snapshot.data, true);
    }
    return true;
  }

  stop(taskId: string): void {
    const entry = this.entries.get(taskId);
    if (!entry) return;
    this.entries.delete(taskId);
    try { entry.unsubscribe(); } catch {}
  }

  has(taskId: string): boolean {
    return this.entries.has(taskId);
  }

  expectedKindsFor(taskId: string): ReadonlySet<PhaseSignalKind> {
    return this.entries.get(taskId)?.expectedKinds ?? new Set();
  }

  isRecovered(taskId: string): boolean {
    return this.entries.get(taskId)?.recovered ?? false;
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

  private onPaneData(entry: WatchEntry, chunk: string, isSnapshot = false): void {
    if (this.entries.get(entry.taskId) !== entry) return;
    if (entry.fired) return;
    const rawCombined = entry.buffer + chunk;
    if (entry.onReadFile) {
      for (const req of scanReadFileSignals(rawCombined)) {
        if (entry.seenReadFile.has(req.raw)) continue;
        entry.seenReadFile.add(req.raw);
        if (!isSnapshot) entry.onReadFile(req);
      }
    }
    const signal = scanPhaseSignals(rawCombined).find(candidate =>
      entry.expectedKinds.has(candidate.kind) && candidate.token === entry.expectedToken,
    );
    entry.buffer = rawCombined.slice(-MATCH_BUFFER_CHARS);
    if (!signal) return;
    if (signal.kind === 'greeting') return;
    entry.fired = true;
    this.entries.delete(entry.taskId);
    try { entry.unsubscribe(); } catch {}
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
    if (this.entries.get(entry.taskId) !== entry) return;
    this.entries.delete(entry.taskId);
    if (entry.fired) return;
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
