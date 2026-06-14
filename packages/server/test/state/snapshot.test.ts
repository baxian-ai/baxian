import { describe, expect, it, vi } from 'vitest';
import type { AgentBindingFacts, TaskState } from '../../src/shared/index.js';
import type { TmuxSessionObservation } from '../../src/agent/tmux-probe-poller.js';
import type { ErrorRecord } from '../../src/state/error-record-store.js';
import { agentSnapshot, buildAllAgentSnapshots, deriveRuntimeStatus } from '../../src/state/snapshot.js';

const NOW = '2026-05-14T05:00:00.000Z';

function binding(overrides: Partial<AgentBindingFacts> = {}): AgentBindingFacts {
  return {
    id: 'dev-1',
    projectId: 'proj',
    updatedAt: NOW,
    ...overrides,
  };
}

function task(status: TaskState['status']): TaskState {
  return {
    id: 'task-1',
    projectId: 'proj',
    title: 'T',
    description: 'D',
    preferredAgentId: 'dev-1',
    agentId: 'dev-1',
    reviewRound: 0,
    status,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe('deriveRuntimeStatus', () => {
  it('reports creationToken as pending before the first tmux probe completes', () => {
    expect(
      deriveRuntimeStatus(
        binding({ creationToken: 'tok' }),
        { tmuxSessionStatus: 'unknown' },
        undefined,
      ),
    ).toBe('pending');
  });

  it('maps active task statuses while tmux is present', () => {
    const b = binding({ taskId: 'task-1' });
    const obs: TmuxSessionObservation = { tmuxSessionStatus: 'present', observedAt: NOW };
    expect(deriveRuntimeStatus(b, obs, task('in_progress'))).toBe('working');
    expect(deriveRuntimeStatus(b, obs, task('review'))).toBe('waiting');
    expect(deriveRuntimeStatus(b, obs, task('failed'))).toBe('error');
  });

  it('reports a reserved max_rounds dev as waiting (awaiting human decision), not error (task-097)', () => {
    const b = binding({ taskId: 'task-1' });
    const obs: TmuxSessionObservation = { tmuxSessionStatus: 'present', observedAt: NOW };
    expect(deriveRuntimeStatus(b, obs, task('max_rounds'))).toBe('waiting');
  });

  it('reports a still-bound merged task as working (post-merge cleanup + compact in flight, not yet idle)', () => {
    expect(
      deriveRuntimeStatus(
        binding({ taskId: 'task-1' }),
        { tmuxSessionStatus: 'present', observedAt: NOW },
        task('merged'),
      ),
    ).toBe('working');
  });

  it('keeps a recently-present active task in its task-derived status during transient unreachable probes', () => {
    const b = binding({ taskId: 'task-1' });
    expect(
      deriveRuntimeStatus(
        b,
        {
          tmuxSessionStatus: 'unreachable',
          observedAt: '2026-05-14T05:00:20.000Z',
          lastPresentAt: '2026-05-14T05:00:00.000Z',
        },
        task('in_progress'),
      ),
    ).toBe('working');
  });

  it('downgrades an active task to unknown after the unreachable grace window expires', () => {
    expect(
      deriveRuntimeStatus(
        binding({ taskId: 'task-1' }),
        {
          tmuxSessionStatus: 'unreachable',
          observedAt: '2026-05-14T05:01:00.000Z',
          lastPresentAt: '2026-05-14T05:00:00.000Z',
        },
        task('in_progress'),
      ),
    ).toBe('unknown');
  });

  it('treats an absent active-task session as error', () => {
    expect(
      deriveRuntimeStatus(
        binding({ taskId: 'task-1' }),
        { tmuxSessionStatus: 'absent', observedAt: NOW },
        task('in_progress'),
      ),
    ).toBe('error');
  });

  it('uses runtime observation hints for pending and unsafe pane states', () => {
    expect(
      deriveRuntimeStatus(
        binding({ taskId: 'task-1' }),
        {
          tmuxSessionStatus: 'present',
          observedAt: NOW,
          runtimeStatusHint: 'pending',
          reason: 'PENDING_HUMAN',
        },
        task('in_progress'),
      ),
    ).toBe('pending');
    expect(
      deriveRuntimeStatus(
        binding({ taskId: 'task-1' }),
        { tmuxSessionStatus: 'present', observedAt: NOW, paneState: 'shell' },
        task('in_progress'),
      ),
    ).toBe('error');
  });

  it('uses a working runtime hint instead of falling back to a review task as waiting', () => {
    expect(
      deriveRuntimeStatus(
        binding({ taskId: 'task-1' }),
        {
          tmuxSessionStatus: 'present',
          observedAt: NOW,
          runtimeStatusHint: 'working',
        },
        task('review'),
      ),
    ).toBe('working');
  });

  it('PENDING_IDLE hint is honored when the bound task is actively running (in_progress / fixing)', () => {
    const b = binding({ taskId: 'task-1' });
    const obs: TmuxSessionObservation = {
      tmuxSessionStatus: 'present',
      observedAt: NOW,
      runtimeStatusHint: 'pending',
      reason: 'PENDING_IDLE',
    };
    expect(deriveRuntimeStatus(b, obs, task('in_progress'))).toBe('pending');
    expect(deriveRuntimeStatus(b, obs, task('fixing'))).toBe('pending');
  });

  it('PENDING_IDLE hint is suppressed when task is in a non-working status (e.g. review)', () => {
    expect(
      deriveRuntimeStatus(
        binding({ taskId: 'task-1' }),
        {
          tmuxSessionStatus: 'present',
          observedAt: NOW,
          runtimeStatusHint: 'pending',
          reason: 'PENDING_IDLE',
        },
        task('review'),
      ),
    ).toBe('waiting');
  });

  it('PENDING_IDLE hint is suppressed when no task is attached', () => {
    expect(
      deriveRuntimeStatus(
        binding({ taskId: 'task-1' }),
        {
          tmuxSessionStatus: 'present',
          observedAt: NOW,
          runtimeStatusHint: 'pending',
          reason: 'PENDING_IDLE',
        },
        undefined,
      ),
    ).toBe('working');
  });

  it('PENDING_HUMAN hint is honored regardless of task status (physical menu signal — never gated)', () => {
    const b = binding({ taskId: 'task-1' });
    const obs: TmuxSessionObservation = {
      tmuxSessionStatus: 'present',
      observedAt: NOW,
      runtimeStatusHint: 'pending',
      reason: 'PENDING_HUMAN',
    };
    expect(deriveRuntimeStatus(b, obs, task('in_progress'))).toBe('pending');
    expect(deriveRuntimeStatus(b, obs, task('review'))).toBe('pending');
    expect(deriveRuntimeStatus(b, obs, task('approved'))).toBe('pending');
  });

  it('does not show an unbound absent or unverified agent as idle', () => {
    expect(deriveRuntimeStatus(binding(), { tmuxSessionStatus: 'present', observedAt: NOW }, undefined)).toBe('idle');
    expect(deriveRuntimeStatus(binding(), { tmuxSessionStatus: 'absent', observedAt: NOW }, undefined)).toBe('unknown');
    expect(deriveRuntimeStatus(binding(), { tmuxSessionStatus: 'unknown' }, undefined)).toBe('unknown');
  });
});

describe('agentSnapshot', () => {
  it('suppresses PENDING_IDLE reason/message/latestError when task-status gating applies', () => {
    const snapshot = agentSnapshot(
      { id: 'dev-1', projectId: 'proj' },
      binding({ taskId: 'task-1' }),
      {
        tmuxSessionStatus: 'present',
        observedAt: NOW,
        runtimeStatusHint: 'pending',
        reason: 'PENDING_IDLE',
        message: 'Agent runtime has been idle while a task is active — likely waiting on user input.',
        latestError: {
          id: 'err-1',
          agentId: 'dev-1',
          reason: 'PENDING_IDLE',
          message: 'idle',
          occurredAt: NOW,
        },
      },
      task('review'),
    );
    expect(snapshot.runtimeStatus).toBe('waiting');
    expect(snapshot.reason).toBeUndefined();
    expect(snapshot.message).toBeUndefined();
    expect(snapshot.latestError).toBeUndefined();
  });

  it('keeps PENDING_IDLE reason/message/latestError when task is in working status', () => {
    const snapshot = agentSnapshot(
      { id: 'dev-1', projectId: 'proj' },
      binding({ taskId: 'task-1' }),
      {
        tmuxSessionStatus: 'present',
        observedAt: NOW,
        runtimeStatusHint: 'pending',
        reason: 'PENDING_IDLE',
        message: 'idle',
        latestError: {
          id: 'err-1',
          agentId: 'dev-1',
          reason: 'PENDING_IDLE',
          message: 'idle',
          occurredAt: NOW,
        },
      },
      task('in_progress'),
    );
    expect(snapshot.runtimeStatus).toBe('pending');
    expect(snapshot.reason).toBe('PENDING_IDLE');
    expect(snapshot.message).toBe('idle');
    expect(snapshot.latestError?.reason).toBe('PENDING_IDLE');
  });

  it('does not suppress non-PENDING_IDLE reason/message/latestError even under PENDING_IDLE-like conditions', () => {
    const snapshot = agentSnapshot(
      { id: 'dev-1', projectId: 'proj' },
      binding({ taskId: 'task-1' }),
      {
        tmuxSessionStatus: 'unreachable',
        observedAt: NOW,
        reason: 'TMUX_UNREACHABLE',
        message: 'ssh dead',
        latestError: {
          id: 'err-2',
          agentId: 'dev-1',
          reason: 'TMUX_UNREACHABLE',
          message: 'ssh dead',
          occurredAt: NOW,
        },
      },
      task('review'),
    );
    expect(snapshot.reason).toBe('TMUX_UNREACHABLE');
    expect(snapshot.latestError?.reason).toBe('TMUX_UNREACHABLE');
  });

  it('surfaces stale unreachable observations and actionable reason fields', () => {
    const snapshot = agentSnapshot(
      { id: 'dev-1', projectId: 'proj' },
      binding({ taskId: 'task-1' }),
      {
        tmuxSessionStatus: 'unreachable',
        observedAt: NOW,
        reason: 'TMUX_UNREACHABLE',
        message: 'ssh timeout',
      },
      task('in_progress'),
    );

    expect(snapshot.stale).toBe(true);
    expect(snapshot.reason).toBe('TMUX_UNREACHABLE');
    expect(snapshot.message).toBe('ssh timeout');
  });

  it('surfaces latestBootstrapError when no repoPath has been recorded yet', () => {
    const snapshot = agentSnapshot(
      { id: 'dev-1', projectId: 'proj' },
      undefined,
      { tmuxSessionStatus: 'absent', observedAt: NOW },
      undefined,
      {
        id: 'err-boot',
        reason: 'BOOTSTRAP_REPO_ACCESS_DENIED',
        message: 'GitHub repo "owner/missing" not found or access denied.',
        occurredAt: NOW,
        recommendation: 'Verify the repo URL...',
      },
    );
    expect(snapshot.latestBootstrapError?.reason).toBe('BOOTSTRAP_REPO_ACCESS_DENIED');
    expect(snapshot.latestBootstrapError?.recommendation).toContain('Verify');
  });

  it('shows latestBootstrapError even when binding.repoPath exists (later failure after first success)', () => {
    // binding.repoPath was set by a previous successful bootstrap; later the
    // remote was rotated and bootstrap regressed. The new error MUST surface — don't gate on
    // a stale "has succeeded once" signal. (Stale error clearing on success is handled by
    // purgeBootstrapForAgent in the success path, not by snapshot-time suppression.)
    const snapshot = agentSnapshot(
      { id: 'dev-1', projectId: 'proj' },
      binding({ repoPath: '/local/repo' }),
      { tmuxSessionStatus: 'present', observedAt: NOW },
      undefined,
      {
        id: 'err-boot-regression',
        reason: 'BOOTSTRAP_REPO_ACCESS_DENIED',
        message: 'auth rotated, repo no longer accessible',
        occurredAt: NOW,
      },
    );
    expect(snapshot.latestBootstrapError?.reason).toBe('BOOTSTRAP_REPO_ACCESS_DENIED');
  });

  it('shows latestBootstrapError for never-dispatched config-only agents (no binding at all)', () => {
    // Auto-mode agents that have never been task-dispatched have NO AgentStore binding. The
    // old binding.repoPath gate would never trigger for them → red card stuck forever. After
    // the fix, snapshot uses purge-on-success as the truth source and just renders whatever
    // bootstrap error record exists.
    const snapshot = agentSnapshot(
      { id: 'dev-1', projectId: 'proj' },
      undefined,
      { tmuxSessionStatus: 'absent', observedAt: NOW },
      undefined,
      {
        id: 'err-boot',
        reason: 'BOOTSTRAP_REPO_ACCESS_DENIED',
        message: 'access denied',
        occurredAt: NOW,
      },
    );
    expect(snapshot.latestBootstrapError?.reason).toBe('BOOTSTRAP_REPO_ACCESS_DENIED');
  });

  it('omits latestBootstrapError when none was loaded', () => {
    const snapshot = agentSnapshot(
      { id: 'dev-1', projectId: 'proj' },
      undefined,
      { tmuxSessionStatus: 'absent', observedAt: NOW },
      undefined,
    );
    expect(snapshot.latestBootstrapError).toBeUndefined();
  });
});

describe('buildAllAgentSnapshots — batched bootstrap error load', () => {
  function makeRecord(agentId: string, message: string): ErrorRecord {
    return {
      id: `err_${agentId}`,
      agentId,
      projectId: 'p',
      operation: 'bootstrap',
      reason: 'BOOTSTRAP_REPO_ACCESS_DENIED',
      message,
      occurredAt: NOW,
    };
  }

  it('calls latestBootstrapByAgent exactly once regardless of agent count (no O(N) per-agent scans)', async () => {
    const latestBootstrapByAgent = vi.fn().mockResolvedValue(new Map<string, ErrorRecord>([
      ['dev-1', makeRecord('dev-1', 'access denied for dev-1')],
      ['dev-3', makeRecord('dev-3', 'access denied for dev-3')],
    ]));
    const latestBootstrapForAgent = vi.fn();
    const ctx = {
      agentManager: {
        listAgents: () => [
          { id: 'dev-1', projectId: 'p' },
          { id: 'dev-2', projectId: 'p' },
          { id: 'dev-3', projectId: 'p' },
        ],
        getAgentConfig: () => undefined,
      },
      agentStore: { list: async () => [], get: async () => null },
      taskStore: { get: async () => null },
      tmuxSessionStatusStore: { get: () => ({ tmuxSessionStatus: 'absent' as const, observedAt: NOW }) },
      errorRecordStore: {
        latestBootstrapForAgent,
        latestBootstrapByAgent,
        toSummary: (r: ErrorRecord) => ({
          id: r.id, reason: r.reason, message: r.message, occurredAt: r.occurredAt,
        }),
      },
    };

    const snapshots = await buildAllAgentSnapshots(ctx);
    expect(snapshots).toHaveLength(3);
    expect(snapshots[0].latestBootstrapError?.message).toBe('access denied for dev-1');
    expect(snapshots[1].latestBootstrapError).toBeUndefined();
    expect(snapshots[2].latestBootstrapError?.message).toBe('access denied for dev-3');
    expect(latestBootstrapByAgent).toHaveBeenCalledTimes(1);
    expect(latestBootstrapForAgent).not.toHaveBeenCalled();
  });
});
