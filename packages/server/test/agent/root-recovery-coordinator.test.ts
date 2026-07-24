import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RootRecoveryCoordinator,
  RootRuntimeStopIncompleteError,
} from '../../src/agent/root-recovery-coordinator.js';
import {
  RootAgentTerminationError,
  RootAgentResponseInvalidError,
  RootPromptNotSubmittedError,
  type RootAgentRuntimePort,
} from '../../src/agent/root-agent-runtime.js';
import { ExecOutcomeUnknownError } from '../../src/agent/net-exec.js';
import { TmuxSessionStatusStore } from '../../src/agent/tmux-probe-poller.js';
import type { AgentManager } from '../../src/agent/manager.js';
import { EventBus } from '../../src/event/bus.js';
import { EventLog } from '../../src/event/log.js';
import { AgentStore } from '../../src/state/agent-store.js';
import { RootRecoveryStore, type RootRecoveryRecord } from '../../src/state/root-recovery-store.js';
import { TaskStore } from '../../src/state/task-store.js';
import { DEFAULT_SERVER_CONFIG, type AgentConfig, type BaxianConfig, type TaskState } from '../../src/shared/index.js';

const AT = '2026-07-21T01:02:03.000Z';
const SERVER_TOKEN = 'configured-server-token-must-not-leak';
const HOST_PASSWORD = 'configured-host-password-must-not-leak';
const DEV: AgentConfig = {
  id: 'dev-1',
  role: 'dev',
  runtime: 'codex',
  mode: 'local',
  workdir: '/tmp/dev-1',
};

class FakeRootRuntime implements RootAgentRuntimePort {
  readonly requests = new Map<string, string>();
  readonly responses = new Map<string, unknown>();
  readonly notifications: string[] = [];
  readonly cleanups: string[] = [];
  startCalls = 0;
  stopCalls = 0;
  terminateCalls = 0;
  private onSignal?: (attemptToken: string) => void;

  async start(onSignal: (attemptToken: string) => void): Promise<void> {
    this.startCalls++;
    this.onSignal = onSignal;
  }

  async writeRequest(record: RootRecoveryRecord, body: string): Promise<void> {
    this.requests.set(record.id, body);
  }

  async notify(record: RootRecoveryRecord): Promise<void> {
    this.notifications.push(record.id);
  }

  async readResponse(record: RootRecoveryRecord): Promise<unknown | null> {
    return this.responses.get(record.id) ?? null;
  }

  async cleanup(record: RootRecoveryRecord): Promise<void> {
    this.cleanups.push(record.id);
    this.requests.delete(record.id);
    this.responses.delete(record.id);
  }

  async isLive(): Promise<boolean> {
    return true;
  }

  async invalidateStreamer(): Promise<void> {}

  async terminate(): Promise<void> {
    this.terminateCalls++;
  }

  async stop(): Promise<void> {
    this.stopCalls++;
  }

  signal(attemptToken: string): void {
    this.onSignal?.(attemptToken);
  }
}

let tempDir: string;
let taskStore: TaskStore;
let agentStore: AgentStore;
let recoveryStore: RootRecoveryStore;
let eventBus: EventBus;
let statusStore: TmuxSessionStatusStore;
let runtime: FakeRootRuntime;
let coordinator: RootRecoveryCoordinator | undefined;
let redispatch: ReturnType<typeof vi.fn>;
let task: TaskState;
let now: Date;

beforeEach(async () => {
  now = new Date(AT);
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-root-coordinator-'));
  const taskDir = join(tempDir, 'tasks');
  const agentDir = join(tempDir, 'agents');
  const recoveryDir = join(tempDir, 'root-recovery');
  const eventDir = join(tempDir, 'events');
  await mkdir(taskDir, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await mkdir(recoveryDir, { recursive: true });
  await mkdir(eventDir, { recursive: true });

  taskStore = new TaskStore(taskDir);
  agentStore = new AgentStore(agentDir);
  recoveryStore = new RootRecoveryStore(recoveryDir, { now: () => now });
  eventBus = new EventBus(new EventLog(eventDir));
  statusStore = new TmuxSessionStatusStore();
  runtime = new FakeRootRuntime();
  redispatch = vi.fn().mockResolvedValue('dispatched');
  task = {
    id: 'task-1',
    projectId: 'proj',
    title: 'Recover a stalled implementation',
    description: 'Keep normal task progression under Server control.',
    preferredAgentId: 'dev-1',
    agentId: 'dev-1',
    devAgentId: 'dev-1',
    reviewRound: 1,
    phase: 'code',
    signalToken: 'abcdef123456',
    reviewMode: 'git',
    status: 'in_progress',
    createdAt: AT,
    updatedAt: AT,
  };
  await taskStore.set(task);
  await agentStore.set({
    id: 'dev-1',
    projectId: 'proj',
    taskId: task.id,
    lockToken: 'lock-must-not-leak',
    creationToken: 'creation-must-not-leak',
    updatedAt: AT,
  });
});

afterEach(async () => {
  await coordinator?.stop();
  await rm(tempDir, { recursive: true });
});

function config(): BaxianConfig {
  return {
    review: { rounds: 10, mode: 'github' },
    server: { ...DEFAULT_SERVER_CONFIG, token: SERVER_TOKEN },
    host: [{ id: 'configured-host', hostname: 'host.example.test', password: HOST_PASSWORD }],
    project: [{ id: 'proj', repo: 'user/repo', merge: null, agent: [[DEV]] }],
  };
}

function createCoordinator(options: {
  projects?: string[];
  capturePane?: (agentId: string) => Promise<string | undefined>;
  baxianConfig?: BaxianConfig;
} = {}): RootRecoveryCoordinator {
  const manager = {
    getAgentConfig: (id: string) => id === DEV.id ? DEV : undefined,
    getConfig: () => options.baxianConfig ?? config(),
    redispatchCurrentTaskPhase: redispatch,
  } as unknown as AgentManager;
  coordinator = new RootRecoveryCoordinator({
    config: {
      runtime: 'codex',
      mode: 'local',
      workdir: '/tmp/root-agent',
      projects: options.projects ?? ['proj'],
      responseTimeoutMinutes: 15,
    },
    eventBus,
    manager,
    taskStore,
    agentStore,
    statusStore,
    runtime,
    store: recoveryStore,
    capturePane: options.capturePane ?? (async () =>
      'working\ntoken: abcdef123456\nlock-must-not-leak\n[bx:code-done:abcdef123456]'),
    now: () => now,
    pollIntervalMs: 60_000,
  });
  return coordinator;
}

async function emitIntervention(phase = 'checkout-preparation-failed'): Promise<RootRecoveryRecord> {
  await eventBus.emit({
    id: 'evt-stuck',
    type: 'human.intervention',
    timestamp: AT,
    projectId: 'proj',
    taskId: task.id,
    agentId: 'dev-1',
    data: {
      phase,
      reason: 'The Server recovery budget is exhausted.',
      token: 'event-token-must-not-leak',
      note: 'The event-token-must-not-leak value must also be removed from ordinary strings.',
      nested: { password: 'password-must-not-leak' },
    },
  });
  const active = await recoveryStore.listActive();
  expect(active).toHaveLength(1);
  return active[0]!;
}

function responseFor(record: RootRecoveryRecord, action = 'redispatch-current-phase') {
  return {
    version: 1,
    requestId: record.id,
    attemptToken: record.attemptToken,
    decision: { action, reason: 'Replay the persisted phase through the Server primitive.' },
  };
}

async function createCompletedRecovery(
  trigger: RootRecoveryRecord['trigger'] = {
    kind: 'intervention',
    observedAt: AT,
    phase: 'checkout-preparation-failed',
  },
): Promise<RootRecoveryRecord> {
  const created = await recoveryStore.createIfIdle({
    taskId: task.id,
    projectId: task.projectId,
    trigger,
    guard: {
      status: task.status,
      phase: task.phase,
      signalToken: task.signalToken,
      agentId: task.agentId,
      reviewRound: task.reviewRound,
      specReviewRound: task.specReviewRound,
    },
  });
  await recoveryStore.complete(created.record.id, {
    kind: 'ignored',
    detail: 'retained result',
    at: AT,
  }, created.record);
  return (await recoveryStore.get(created.record.id))!;
}

describe('RootRecoveryCoordinator', () => {
  it('handles a task-bound intervention through files, then lets Server execute one high-level action', async () => {
    await createCoordinator().start();
    expect(runtime.startCalls).toBe(0);
    const binding = await agentStore.get('dev-1');
    await agentStore.set({
      ...binding!,
      status: 'awaiting_human',
      awaitingPhase: 'checkout-preparation-failed',
      awaitingSince: AT,
      awaitingNonce: 'nonce-must-not-leak',
    });
    const record = await emitIntervention();
    expect(record.trigger.eventId).toMatch(/^root-hold-/);
    expect(record.trigger.eventId).not.toBe('evt-stuck');
    await vi.waitFor(() => expect(runtime.notifications).toEqual([record.id]));
    const request = runtime.requests.get(record.id)!;
    expect(request).toContain('redispatch-current-phase');
    expect(request).toContain('"signalKind": "root-done"');
    expect(request).not.toContain(`[bx:root-done:${record.attemptToken}]`);
    expect(request).not.toContain('lock-must-not-leak');
    expect(request).not.toContain('creation-must-not-leak');
    expect(request).not.toContain('event-token-must-not-leak');
    expect(request).not.toContain('password-must-not-leak');
    expect(request).not.toContain('nonce-must-not-leak');
    expect(request).not.toContain('abcdef123456');
    expect(request).not.toContain('[bx:code-done:');

    runtime.responses.set(record.id, responseFor(record));
    await coordinator!.pollOnce();

    expect(redispatch).toHaveBeenCalledOnce();
    expect(redispatch).toHaveBeenCalledWith(task.id, record.guard);
    expect(await recoveryStore.get(record.id)).toMatchObject({
      status: 'done',
      outcome: { kind: 'executed' },
      decision: { action: 'redispatch-current-phase' },
    });
    expect(runtime.cleanups).toContain(record.id);
    expect(await recoveryStore.listActive()).toEqual([]);
  });

  it('records and warns when redispatch fails after its outcome becomes uncertain', async () => {
    redispatch.mockRejectedValueOnce(new Error('dispatch transport result was lost'));
    await createCoordinator().start();
    statusStore.set('dev-1', {
      tmuxSessionStatus: 'present',
      runtimeStatusHint: 'idle',
      reason: 'PENDING_IDLE',
      observedAt: AT,
    });
    await vi.waitFor(async () => {
      expect((await recoveryStore.listActive())[0]?.deliveredAt).toBeDefined();
    });
    const [record] = await recoveryStore.listActive();
    runtime.responses.set(record!.id, responseFor(record!));

    await coordinator!.pollOnce();

    expect(await recoveryStore.get(record!.id)).toMatchObject({
      status: 'done',
      outcome: {
        kind: 'unknown',
        detail: expect.stringContaining('may have produced a side effect'),
      },
      decision: { action: 'redispatch-current-phase' },
    });
    const events = await eventBus.readRange('2026-07-21', '2026-07-21');
    expect(events).toContainEqual(expect.objectContaining({
      type: 'human.intervention',
      taskId: task.id,
      data: expect.objectContaining({
        source: 'root-agent',
        phase: 'root-action-outcome-unknown',
        rootRecoveryId: record!.id,
      }),
    }));
  });

  it('does not offer an allowlisted intervention replay without its durable hold generation', async () => {
    await createCoordinator().start();
    const record = await emitIntervention('checkout-preparation-failed');
    await vi.waitFor(() => expect(runtime.requests.has(record.id)).toBe(true));
    const request = JSON.parse(runtime.requests.get(record.id)!) as {
      allowedDecisions: Array<{ action: string }>;
    };
    expect(request.allowedDecisions.map(item => item.action)).toEqual(['escalate', 'no-op']);
  });

  it('redacts event values, hold nonces, and secrets crossing a context-error truncation boundary', async () => {
    const secret = 'ZXQ91-secret-crossing-the-boundary';
    const binding = await agentStore.get('dev-1');
    await agentStore.set({
      ...binding!,
      status: 'awaiting_human',
      awaitingPhase: 'checkout-preparation-failed',
      awaitingSince: AT,
      awaitingNonce: 'nonce-must-not-leak',
      creationToken: secret,
    });
    const prefix = 'pane dev-1: ';
    const padding = 'x'.repeat(512 - Buffer.byteLength(prefix, 'utf8') - 5);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await createCoordinator({
      capturePane: async () => { throw new Error(padding + secret); },
    }).start();

    const record = await emitIntervention();
    await vi.waitFor(() => expect(runtime.requests.has(record.id)).toBe(true));
    const request = runtime.requests.get(record.id)!;
    expect(request).not.toContain('ZXQ91');
    expect(request).not.toContain('nonce-must-not-leak');
    expect(request).not.toContain('event-token-must-not-leak');
    warn.mockRestore();
  });

  it('collects credentials across all events before sanitizing events and pane context', async () => {
    const authorizationCredential = 'cross-event-bearer-credential';
    const namedCredential = 'nested-oauth-credential-value';
    const compactCredential = 'compact-oauth-credential-value';
    const uppercaseCredential = 'compact-client-credential-value';
    await createCoordinator({
      capturePane: async () =>
        `pane echoed ${authorizationCredential}, ${namedCredential}, ${compactCredential}, and ${uppercaseCredential}`,
    }).start();
    await eventBus.emit({
      id: 'evt-credential-source',
      type: 'task.updated',
      timestamp: AT,
      projectId: 'proj',
      taskId: task.id,
      data: {
        authorization: `Bearer ${authorizationCredential}`,
        oauthCredential: `Bearer ${namedCredential}`,
        oauthcredential: `Bearer ${compactCredential}`,
        CLIENTCREDENTIAL: `Basic ${uppercaseCredential}`,
      },
    });
    await eventBus.emit({
      id: 'evt-credential-echo',
      type: 'task.updated',
      timestamp: AT,
      projectId: 'proj',
      taskId: task.id,
      data: {
        message:
          `upstream echoed ${authorizationCredential}, ${namedCredential}, ${compactCredential}, and ${uppercaseCredential}`,
      },
    });
    const binding = await agentStore.get('dev-1');
    await agentStore.set({
      ...binding!,
      status: 'awaiting_human',
      awaitingPhase: 'checkout-preparation-failed',
      awaitingSince: AT,
      awaitingNonce: 'cross-event-hold',
    });

    const record = await emitIntervention();
    await vi.waitFor(() => expect(runtime.requests.has(record.id)).toBe(true));
    const request = runtime.requests.get(record.id)!;
    expect(request).not.toContain(authorizationCredential);
    expect(request).not.toContain(namedCredential);
    expect(request).not.toContain(compactCredential);
    expect(request).not.toContain(uppercaseCredential);
    expect(request).not.toContain(`Bearer ${authorizationCredential}`);
    expect(request).not.toContain(`Bearer ${namedCredential}`);
  });

  it('redacts configured credentials echoed through ordinary event and pane strings', async () => {
    await createCoordinator({
      capturePane: async () => `pane echoed ${SERVER_TOKEN} and ${HOST_PASSWORD}`,
    }).start();
    await eventBus.emit({
      id: 'evt-config-credential-echo',
      type: 'task.updated',
      timestamp: AT,
      projectId: 'proj',
      taskId: task.id,
      data: { message: `upstream echoed ${SERVER_TOKEN} and ${HOST_PASSWORD}` },
    });

    const record = await emitIntervention();
    await vi.waitFor(() => expect(runtime.requests.has(record.id)).toBe(true));
    const request = runtime.requests.get(record.id)!;
    expect(request).not.toContain(SERVER_TOKEN);
    expect(request).not.toContain(HOST_PASSWORD);
  });

  it('redacts short credentials only in labeled context without corrupting ordinary diagnostics', async () => {
    const shortConfig = config();
    const spacedPassword = 'one two three';
    shortConfig.server.token = 'baxian';
    shortConfig.host[0] = { ...shortConfig.host[0]!, password: '1' };
    shortConfig.host.push({ id: 'backup-host', hostname: 'backup.example.test', password: spacedPassword });
    const ordinary = '.baxian/review/inbox baxian task list npm run dev dev-1 exit code 1';
    await createCoordinator({
      baxianConfig: shortConfig,
      capturePane: async () =>
        `${ordinary}\nserver.token=baxian host.password=1\nbackup.password=${spacedPassword}`,
    }).start();

    const record = await emitIntervention();
    await vi.waitFor(() => expect(runtime.requests.has(record.id)).toBe(true));
    const request = JSON.parse(runtime.requests.get(record.id)!) as {
      agents: Array<{ pane?: string }>;
    };
    expect(request.agents[0]?.pane).toContain(ordinary);
    expect(request.agents[0]?.pane).toContain('server.token=[redacted]');
    expect(request.agents[0]?.pane).toContain('host.password=[redacted]');
    expect(request.agents[0]?.pane).not.toContain(spacedPassword);
  });

  it('redacts embedded labeled credentials and compound apikey fields', async () => {
    const credentials = ['a1', 'b2', 'c3', 'd4', 'e5', 'f6', 'g7', 'h8'];
    await createCoordinator({
      capturePane: async () => [
        `foo=bar&access_token=${credentials[0]}`,
        `url=https://example.test/callback?client_secret=${credentials[1]}`,
        `json={"token":"${credentials[2]}"}`,
        `cmd=run&&token=${credentials[3]}`,
        `config: token=${credentials[4]}`,
        `GITHUB_APIKEY=${credentials[5]}`,
        `server.apikey=${credentials[6]}`,
        `myapikey=${credentials[7]}`,
      ].join('\n'),
    }).start();

    const record = await emitIntervention();
    await vi.waitFor(() => expect(runtime.requests.has(record.id)).toBe(true));
    const request = JSON.parse(runtime.requests.get(record.id)!) as {
      agents: Array<{ pane?: string }>;
    };
    const pane = request.agents[0]?.pane ?? '';
    for (const credential of credentials) expect(pane).not.toContain(credential);
    expect(pane).toContain('foo=bar&access_token=[redacted]');
    expect(pane).toContain('config: token=[redacted]');
    expect(pane).toContain('GITHUB_APIKEY=[redacted]');
    expect(pane).toContain('server.apikey=[redacted]');
    expect(pane).toContain('myapikey=[redacted]');
  });

  it('does not let an unclosed quoted value consume the next line\'s sensitive label', async () => {
    const secrets = ['first-secret', 'second-secret', 'third-secret', 'fourth-secret'];
    await createCoordinator({
      capturePane: async () => [
        `token:"${secrets[0]}`,
        `token="${secrets[1]}"`,
        `password:'${secrets[2]}\r`,
        `password='${secrets[3]}'`,
      ].join('\n'),
    }).start();

    const record = await emitIntervention();
    await vi.waitFor(() => expect(runtime.requests.has(record.id)).toBe(true));
    const request = JSON.parse(runtime.requests.get(record.id)!) as {
      agents: Array<{ pane?: string }>;
    };
    const pane = request.agents[0]?.pane ?? '';
    for (const secret of secrets) expect(pane).not.toContain(secret);
    expect(pane.match(/\[redacted\]/g)).toHaveLength(4);
  });

  it('keeps label separators line-local and rescans after closed quoted values', async () => {
    const secrets = ['next-line-secret', 'quoted-secret', 'adjacent-secret'];
    await createCoordinator({
      capturePane: async () => [
        `token=\nnonce: ${secrets[0]}`,
        `token:"${secrets[1]}"password=${secrets[2]}`,
      ].join('\n'),
    }).start();

    const record = await emitIntervention();
    await vi.waitFor(() => expect(runtime.requests.has(record.id)).toBe(true));
    const request = JSON.parse(runtime.requests.get(record.id)!) as {
      agents: Array<{ pane?: string }>;
    };
    const pane = request.agents[0]?.pane ?? '';
    for (const secret of secrets) expect(pane).not.toContain(secret);
    expect(pane.match(/\[redacted\]/g)).toHaveLength(3);
  });

  it('redacts an unlabeled configured credential at the exact global threshold', async () => {
    const exactThresholdSecret = 'abcd1234';
    const thresholdConfig = config();
    thresholdConfig.host[0] = { ...thresholdConfig.host[0]!, password: exactThresholdSecret };
    await createCoordinator({
      baxianConfig: thresholdConfig,
      capturePane: async () => `pane echoed ${exactThresholdSecret}`,
    }).start();

    const record = await emitIntervention();
    await vi.waitFor(() => expect(runtime.requests.has(record.id)).toBe(true));
    expect(runtime.requests.get(record.id)).not.toContain(exactThresholdSecret);
  });

  it('redacts a short pane-only bearer credential with its authorization label', async () => {
    await createCoordinator({
      capturePane: async () => 'Authorization: Bearer abc123',
    }).start();

    const record = await emitIntervention();
    await vi.waitFor(() => expect(runtime.requests.has(record.id)).toBe(true));
    const request = runtime.requests.get(record.id)!;
    expect(request).toContain('Authorization: [redacted]');
    expect(request).not.toContain('abc123');
  });

  it('redacts credentials nested beyond the former recursive scan boundary', async () => {
    const deepSecret = 'deep-context-passcode-stays-private';
    const deepConfig = config();
    let nested: Record<string, unknown> = { password: deepSecret };
    for (let depth = 0; depth < 8; depth++) nested = { wrapper: nested };
    (deepConfig as BaxianConfig & { scanProbe?: unknown }).scanProbe = nested;
    await createCoordinator({
      baxianConfig: deepConfig,
      capturePane: async () => `pane echoed ${deepSecret}`,
    }).start();

    const record = await emitIntervention();
    await vi.waitFor(() => expect(runtime.requests.has(record.id)).toBe(true));
    expect(runtime.requests.get(record.id)).not.toContain(deepSecret);
  });

  it('visits a cyclic secret-scan object only once', async () => {
    const cyclicConfig = config() as BaxianConfig & { scanProbe?: unknown };
    const cycle: Record<string, unknown> = {};
    let visits = 0;
    Object.defineProperty(cycle, 'next', {
      enumerable: true,
      get: () => {
        visits++;
        return cycle;
      },
    });
    cyclicConfig.scanProbe = cycle;

    await createCoordinator({ baxianConfig: cyclicConfig }).start();
    const record = await emitIntervention();
    await vi.waitFor(() => expect(runtime.requests.has(record.id)).toBe(true));

    expect(visits).toBe(1);
  });

  it('stops secret scanning at the configured object-node budget', async () => {
    const boundedConfig = config() as BaxianConfig & { scanProbe?: unknown };
    let visits = 0;
    let chain: unknown = null;
    for (let index = 0; index < 5_000; index++) {
      const next = chain;
      const node: Record<string, unknown> = {};
      Object.defineProperty(node, 'next', {
        enumerable: true,
        get: () => {
          visits++;
          return next;
        },
      });
      chain = node;
    }
    boundedConfig.scanProbe = chain;

    await createCoordinator({ baxianConfig: boundedConfig }).start();
    const record = await emitIntervention();
    await vi.waitFor(() => expect(runtime.requests.has(record.id)).toBe(true));

    expect(visits).toBeGreaterThan(4_000);
    expect(visits).toBeLessThan(5_000);
  });

  it('scans a giant array without exceeding the engine argument limit', async () => {
    const arrayConfig = config() as BaxianConfig & { scanProbe?: unknown };
    arrayConfig.scanProbe = Array.from({ length: 150_000 }, () => null);

    await createCoordinator({ baxianConfig: arrayConfig }).start();
    const record = await emitIntervention();
    await vi.waitFor(() => expect(runtime.requests.has(record.id)).toBe(true));

    expect(runtime.requests.get(record.id)).toContain('Recover a stalled implementation');
  });

  it('redacts a long unbroken pane snapshot within a bounded event-loop turn', async () => {
    await createCoordinator({ capturePane: async () => 'a'.repeat(120_000) }).start();

    const record = await emitIntervention();
    await vi.waitFor(() => expect(runtime.requests.has(record.id)).toBe(true));

    expect(Buffer.byteLength(runtime.requests.get(record.id)!, 'utf8')).toBeLessThan(128 * 1024);
  }, 3_000);

  it('bounds field-name parsing and fails closed for oversized event keys', async () => {
    const credential = 'oversized-field-credential';
    await createCoordinator({ capturePane: async () => credential }).start();
    await eventBus.emit({
      id: 'evt-oversized-field-name',
      type: 'task.updated',
      timestamp: AT,
      projectId: 'proj',
      taskId: task.id,
      data: { ['A'.repeat(100_000)]: `Bearer ${credential}` },
    });

    const record = await emitIntervention();
    await vi.waitFor(() => expect(runtime.requests.has(record.id)).toBe(true));
    expect(runtime.requests.get(record.id)).not.toContain(credential);
  });

  it('redacts key credentials without treating ordinary key words as secrets', async () => {
    const secrets = [
      'api-key-secret-value',
      'access-key-secret-value',
      'private-key-secret-value',
      'ssh-key-secret-value',
      'lowercase-api-key-secret-value',
    ];
    const ordinary = ['keyboard-layout-value', 'monkey-species-value', 'turnkey-status-value'];
    await createCoordinator({
      capturePane: async () => [...secrets, ...ordinary].join(' '),
    }).start();
    await eventBus.emit({
      id: 'evt-key-credentials',
      type: 'task.updated',
      timestamp: AT,
      projectId: 'proj',
      taskId: task.id,
      data: {
        apiKey: secrets[0],
        access_key: secrets[1],
        'private-key': secrets[2],
        SSHKey: secrets[3],
        apikey: secrets[4],
        keyboard: ordinary[0],
        monkey: ordinary[1],
        turnkey: ordinary[2],
      },
    });

    const record = await emitIntervention();
    await vi.waitFor(() => expect(runtime.requests.has(record.id)).toBe(true));
    const request = runtime.requests.get(record.id)!;
    for (const secret of secrets) expect(request).not.toContain(secret);
    for (const value of ordinary) expect(request).toContain(value);
  });

  it('does not derive bare secrets from malformed authorization values or similarly named fields', async () => {
    const pane = 'stable beta abcdefgh context';
    await createCoordinator({ capturePane: async () => pane }).start();
    await eventBus.emit({
      id: 'evt-malformed-credentials',
      type: 'task.updated',
      timestamp: AT,
      projectId: 'proj',
      taskId: task.id,
      data: {
        authorization: 'Bearer  ',
        proxyAuthorization: 'Bearer b',
        credentialType: 'Bearer abcdefgh',
        authorizationCheckedAt: 'Basic abcdefgh',
      },
    });

    const record = await emitIntervention();
    await vi.waitFor(() => expect(runtime.requests.has(record.id)).toBe(true));
    expect(runtime.requests.get(record.id)).toContain(pane);
  });

  it('invalidates an in-flight root request when Server advances the task generation', async () => {
    await createCoordinator().start();
    const record = await emitIntervention();
    await taskStore.set({ ...task, signalToken: 'fedcba654321', updatedAt: '2026-07-21T01:03:00.000Z' });
    await vi.waitFor(async () => {
      expect((await recoveryStore.get(record.id))?.outcome?.kind).toBe('stale');
    });
    runtime.responses.set(record.id, responseFor(record));
    await coordinator!.pollOnce();
    expect(redispatch).not.toHaveBeenCalled();
  });

  it('removes a request written after concurrent stale completion wins', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    let markWriteStarted!: () => void;
    let releaseWrite!: () => void;
    const writeStarted = new Promise<void>(resolve => { markWriteStarted = resolve; });
    const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
    vi.spyOn(runtime, 'writeRequest').mockImplementation(async (record, body) => {
      markWriteStarted();
      await writeGate;
      runtime.requests.set(record.id, body);
    });
    await createCoordinator().start();
    const record = await emitIntervention();
    await writeStarted;

    await taskStore.set({ ...task, signalToken: 'fedcba654321', updatedAt: '2026-07-21T01:03:00.000Z' });
    await vi.waitFor(async () => {
      expect((await recoveryStore.get(record.id))?.outcome?.kind).toBe('stale');
    });
    releaseWrite();

    await vi.waitFor(() => expect(runtime.cleanups.filter(id => id === record.id)).toHaveLength(2));
    expect(runtime.requests.has(record.id)).toBe(false);
    expect(runtime.notifications).not.toContain(record.id);
    expect(log).toHaveBeenCalledWith(`[root-agent] removed stale request mailbox for ${record.id}`);
    log.mockRestore();
  });

  it('removes an undelivered mailbox only after shutdown returns its record to pending', async () => {
    const instance = createCoordinator();
    const markDispatched = recoveryStore.markDispatched.bind(recoveryStore);
    vi.spyOn(recoveryStore, 'markDispatched').mockImplementationOnce(async id => {
      const inflight = await markDispatched(id);
      (instance as unknown as { runtimeControlStatus: string }).runtimeControlStatus = 'stopping';
      return inflight;
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await instance.start();

    const record = await emitIntervention();
    await vi.waitFor(() => expect(runtime.cleanups).toContain(record.id));

    expect(await recoveryStore.get(record.id)).toMatchObject({ status: 'pending' });
    expect(runtime.requests.has(record.id)).toBe(false);
    expect(log).toHaveBeenCalledWith(
      `[root-agent] removed stopped undelivered request mailbox for ${record.id}`,
    );
    log.mockRestore();
  });

  it('preserves an undelivered mailbox when the shutdown requeue loses its state race', async () => {
    const instance = createCoordinator();
    const markDispatched = recoveryStore.markDispatched.bind(recoveryStore);
    vi.spyOn(recoveryStore, 'markDispatched').mockImplementationOnce(async id => {
      const inflight = await markDispatched(id);
      (instance as unknown as { runtimeControlStatus: string }).runtimeControlStatus = 'stopping';
      return inflight;
    });
    vi.spyOn(recoveryStore, 'requeueUndelivered').mockImplementationOnce(async (id) => ({
      requeued: false,
      record: await recoveryStore.get(id),
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await instance.start();

    const record = await emitIntervention();
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('mailbox was preserved'));
    });

    expect(runtime.requests.has(record.id)).toBe(true);
    expect(runtime.cleanups).not.toContain(record.id);
    warn.mockRestore();
  });

  it.each([
    'post-approve-merge-skipped-provenance',
    'server-code-published-head-capture-failed',
    'server-code-published-missing-pr-number',
    'server-code-published-round-mismatch',
    'dispatch-failed:ack_unknown',
    'dispatch-reconcile-attempts-exhausted',
    'code-dispatch-failed',
    'restart-redispatch-failed',
  ])('does not expose redispatch for non-allowlisted intervention %s', async (phase) => {
    await createCoordinator().start();
    const binding = await agentStore.get('dev-1');
    await agentStore.set({
      ...binding!,
      status: 'awaiting_human',
      awaitingPhase: phase,
      awaitingSince: AT,
      awaitingNonce: `hold-${phase}`,
    });
    const record = await emitIntervention(phase);
    await vi.waitFor(() => expect(runtime.requests.has(record.id)).toBe(true));
    const request = JSON.parse(runtime.requests.get(record.id)!) as {
      allowedDecisions: Array<{ action: string }>;
    };
    expect(request.allowedDecisions.map(item => item.action)).toEqual(['escalate', 'no-op']);

    runtime.responses.set(record.id, responseFor(record));
    await coordinator!.pollOnce();
    expect(redispatch).not.toHaveBeenCalled();
    expect((await recoveryStore.get(record.id))?.outcome?.kind).toBe('failed');
  });

  it('re-evaluates an unchanged runtime stall when the agent clears needInput', async () => {
    await createCoordinator().start();
    statusStore.set('dev-1', {
      tmuxSessionStatus: 'present',
      runtimeStatusHint: 'waiting',
      reason: 'PENDING_HUMAN',
      observedAt: AT,
    });
    expect(await recoveryStore.listActive()).toEqual([]);

    await agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      taskId: task.id,
      needInput: { epoch: 0, askSeq: 1, answeredSeq: 0, at: AT },
      updatedAt: AT,
    });
    statusStore.set('dev-1', {
      tmuxSessionStatus: 'present',
      runtimeStatusHint: 'idle',
      reason: 'PENDING_IDLE',
      observedAt: AT,
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(await recoveryStore.listActive()).toEqual([]);

    await agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      taskId: task.id,
      updatedAt: '2026-07-21T01:03:00.000Z',
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(await recoveryStore.listActive()).toEqual([]);

    statusStore.set('dev-1', {
      tmuxSessionStatus: 'present',
      runtimeStatusHint: 'idle',
      reason: 'PENDING_IDLE',
      observedAt: '2026-07-21T01:04:00.000Z',
    });
    await coordinator!.pollOnce();
    expect(await recoveryStore.listActive()).toHaveLength(1);
    expect(runtime.notifications).toHaveLength(1);
  });

  it('escalates after the configured PENDING_IDLE redispatch limit and resets on phase lineage change', async () => {
    for (let attempt = 0; attempt < DEFAULT_SERVER_CONFIG.dispatchReconcileMaxAttempts; attempt++) {
      const pending = await recoveryStore.createIfIdle({
        taskId: task.id,
        projectId: task.projectId,
        trigger: { kind: 'runtime-stall', observedAt: AT, agentId: 'dev-1', reason: 'PENDING_IDLE' },
        guard: {
          status: task.status,
          phase: task.phase,
          signalToken: `attempt-${attempt}`,
          agentId: task.agentId,
          reviewRound: task.reviewRound,
        },
      });
      const inflight = await recoveryStore.markDispatched(pending.record.id);
      const claimed = await recoveryStore.claimDecision(inflight!.id, inflight!.attemptToken, {
        action: 'redispatch-current-phase',
        reason: `Automatic retry ${attempt + 1}`,
      });
      await recoveryStore.complete(claimed.record!.id, {
        kind: 'executed',
        detail: 'redispatched',
        at: AT,
      }, claimed.record!);
    }
    await createCoordinator().start();

    statusStore.set('dev-1', {
      tmuxSessionStatus: 'present',
      runtimeStatusHint: 'idle',
      reason: 'PENDING_IDLE',
      observedAt: AT,
    });
    await vi.waitFor(async () => {
      expect((await recoveryStore.list()).at(-1)?.outcome?.kind).toBe('escalated');
    });
    expect(runtime.notifications).toEqual([]);
    const events = await eventBus.readRange('2026-07-21', '2026-07-21');
    expect(events.some(event => event.data.phase === 'root-redispatch-attempts-exhausted')).toBe(true);

    task = {
      ...task,
      reviewRound: task.reviewRound + 1,
      signalToken: 'next-review-lineage',
      updatedAt: '2026-07-21T01:04:00.000Z',
    };
    await taskStore.set(task);
    statusStore.set('dev-1', {
      tmuxSessionStatus: 'present',
      runtimeStatusHint: 'idle',
      observedAt: '2026-07-21T01:04:30.000Z',
    });
    statusStore.set('dev-1', {
      tmuxSessionStatus: 'present',
      runtimeStatusHint: 'idle',
      reason: 'PENDING_IDLE',
      observedAt: '2026-07-21T01:05:00.000Z',
    });
    await vi.waitFor(() => expect(runtime.notifications).toHaveLength(1));
  });

  it('counts unknown redispatch outcomes toward the configured retry limit', async () => {
    for (let attempt = 0; attempt < DEFAULT_SERVER_CONFIG.dispatchReconcileMaxAttempts; attempt++) {
      const pending = await recoveryStore.createIfIdle({
        taskId: task.id,
        projectId: task.projectId,
        trigger: { kind: 'runtime-stall', observedAt: AT, agentId: 'dev-1', reason: 'PENDING_IDLE' },
        guard: {
          status: task.status,
          phase: task.phase,
          signalToken: task.signalToken,
          agentId: task.agentId,
          reviewRound: task.reviewRound,
        },
      });
      const inflight = await recoveryStore.markDispatched(pending.record.id);
      const claimed = await recoveryStore.claimDecision(inflight!.id, inflight!.attemptToken, {
        action: 'redispatch-current-phase',
        reason: `Uncertain retry ${attempt + 1}`,
      });
      await recoveryStore.complete(claimed.record!.id, {
        kind: 'unknown',
        detail: 'redispatch outcome unknown',
        at: AT,
      }, claimed.record!);
    }
    await createCoordinator().start();

    statusStore.set('dev-1', {
      tmuxSessionStatus: 'present',
      runtimeStatusHint: 'idle',
      reason: 'PENDING_IDLE',
      observedAt: AT,
    });

    await vi.waitFor(async () => {
      expect((await recoveryStore.list()).at(-1)?.outcome?.kind).toBe('escalated');
    });
    expect(runtime.notifications).toEqual([]);
  });

  it('shares the redispatch limit across runtime stalls and replayable intervention holds', async () => {
    const limit = DEFAULT_SERVER_CONFIG.dispatchReconcileMaxAttempts;
    for (let attempt = 0; attempt < limit; attempt++) {
      const trigger = attempt === 0
        ? { kind: 'runtime-stall' as const, observedAt: AT, agentId: 'dev-1', reason: 'PENDING_IDLE' }
        : {
            kind: 'intervention' as const,
            observedAt: AT,
            agentId: 'dev-1',
            eventId: `prior-hold-${attempt}`,
            phase: 'dirty-workdir',
            holdPhase: 'dirty-workdir',
            holdSince: AT,
            holdNonce: `prior-nonce-${attempt}`,
          };
      const pending = await recoveryStore.createIfIdle({
        taskId: task.id,
        projectId: task.projectId,
        trigger,
        guard: {
          status: task.status,
          phase: task.phase,
          signalToken: `attempt-${attempt}`,
          agentId: task.agentId,
          reviewRound: task.reviewRound,
        },
      });
      const inflight = await recoveryStore.markDispatched(pending.record.id);
      const claimed = await recoveryStore.claimDecision(inflight!.id, inflight!.attemptToken, {
        action: 'redispatch-current-phase',
        reason: `Automatic retry ${attempt + 1}`,
      });
      await recoveryStore.complete(claimed.record!.id, {
        kind: 'executed',
        detail: 'redispatched',
        at: AT,
      }, claimed.record!);
    }
    await agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      taskId: task.id,
      status: 'awaiting_human',
      awaitingPhase: 'dirty-workdir',
      awaitingSince: AT,
      awaitingNonce: 'current-hold-generation',
      updatedAt: AT,
    });

    await createCoordinator().start();

    await vi.waitFor(async () => {
      expect((await recoveryStore.list()).at(-1)?.outcome?.kind).toBe('escalated');
    });
    expect(runtime.notifications).toEqual([]);
    const events = await eventBus.readRange('2026-07-21', '2026-07-21');
    expect(events.some(event => event.data.phase === 'root-redispatch-attempts-exhausted')).toBe(true);
  });

  it('warns when the redispatch-limit terminal write loses its state race', async () => {
    const instance = createCoordinator();
    const internals = instance as unknown as {
      started: boolean;
      redispatchLimitReached(taskId: string, guard: unknown): Promise<boolean>;
      createRequestNow(taskId: string, trigger: RootRecoveryRecord['trigger']): Promise<void>;
    };
    internals.started = true;
    vi.spyOn(internals, 'redispatchLimitReached').mockResolvedValue(true);
    vi.spyOn(recoveryStore, 'complete').mockResolvedValueOnce({ completed: false, record: null });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await internals.createRequestNow(task.id, {
      kind: 'intervention',
      observedAt: AT,
      agentId: 'dev-1',
      phase: 'dirty-workdir',
      holdPhase: 'dirty-workdir',
      holdSince: AT,
      holdNonce: 'limit-cas-race',
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('completion lost its state race'));
    expect(runtime.notifications).toEqual([]);
    warn.mockRestore();
  });

  it('does not create a runtime-stall request while the agent has an awaiting_human hold', async () => {
    await createCoordinator().start();
    await agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      taskId: task.id,
      status: 'awaiting_human',
      awaitingPhase: 'dirty-workdir',
      awaitingSince: AT,
      awaitingNonce: 'hold-generation',
      updatedAt: AT,
    });
    statusStore.set('dev-1', {
      tmuxSessionStatus: 'present',
      runtimeStatusHint: 'idle',
      reason: 'PENDING_IDLE',
      observedAt: AT,
    });

    await new Promise(resolve => setTimeout(resolve, 10));
    expect(await recoveryStore.list()).toEqual([]);
    expect(runtime.notifications).toEqual([]);
  });

  it('reports a stuck-busy runtime to root without offering an unsafe prompt replay', async () => {
    await createCoordinator().start();
    statusStore.set('dev-1', {
      tmuxSessionStatus: 'present',
      runtimeStatusHint: 'error',
      reason: 'STUCK_BUSY',
      observedAt: AT,
    });
    await vi.waitFor(async () => {
      expect(await recoveryStore.listActive()).toHaveLength(1);
    });
    const [record] = await recoveryStore.listActive();
    await vi.waitFor(() => expect(runtime.requests.has(record!.id)).toBe(true));
    const request = JSON.parse(runtime.requests.get(record!.id)!) as {
      allowedDecisions: Array<{ action: string }>;
    };
    expect(request.allowedDecisions.map(item => item.action)).toEqual(['escalate', 'no-op']);
  });

  it('marks a persisted-but-unfinished action unknown after restart and never retries it', async () => {
    const created = await recoveryStore.createIfIdle({
      taskId: task.id,
      projectId: task.projectId,
      trigger: { kind: 'runtime-stall', observedAt: AT, agentId: 'dev-1', reason: 'STUCK_BUSY' },
      guard: {
        status: task.status,
        phase: task.phase,
        signalToken: task.signalToken,
        agentId: task.agentId,
        reviewRound: task.reviewRound,
      },
    });
    await recoveryStore.markDispatched(created.record.id);
    await recoveryStore.claimDecision(created.record.id, created.record.attemptToken, {
      action: 'redispatch-current-phase',
      reason: 'Persist before side effects.',
    });

    await createCoordinator().start();
    expect(redispatch).not.toHaveBeenCalled();
    expect(await recoveryStore.get(created.record.id)).toMatchObject({
      status: 'done',
      outcome: { kind: 'unknown' },
    });
  });

  it('recovers a persisted held agent once and does not reopen the same hold after restart', async () => {
    await agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      taskId: task.id,
      status: 'awaiting_human',
      awaitingPhase: 'dispatch-reconcile-attempts-exhausted',
      awaitingReason: 'The prompt was not acknowledged.',
      awaitingSince: AT,
      awaitingNonce: 'hold-generation-1',
      updatedAt: AT,
    });
    await createCoordinator().start();
    const active = await recoveryStore.listActive();
    expect(active).toHaveLength(1);
    await vi.waitFor(() => expect(runtime.notifications).toEqual([active[0]!.id]));
    runtime.responses.set(active[0]!.id, responseFor(active[0]!, 'no-op'));
    await coordinator!.pollOnce();
    expect((await recoveryStore.get(active[0]!.id))?.outcome?.kind).toBe('ignored');

    await coordinator!.stop();
    coordinator = undefined;
    await createCoordinator().start();
    expect(await recoveryStore.listActive()).toEqual([]);
    expect(await recoveryStore.list()).toHaveLength(1);
  });

  it('queues a newer durable hold after the task previous recovery completes', async () => {
    await createCoordinator().start();
    const first = await emitIntervention('server-handler-failed');
    await vi.waitFor(() => expect(runtime.notifications).toContain(first.id));

    await agentStore.set({
      ...(await agentStore.get('dev-1'))!,
      status: 'awaiting_human',
      awaitingPhase: 'code-dispatch-failed',
      awaitingReason: 'The replacement dispatch needs root recovery.',
      awaitingSince: '2026-07-21T01:03:00.000Z',
      awaitingNonce: 'new-hold-generation',
      updatedAt: '2026-07-21T01:03:00.000Z',
    });
    await eventBus.emit({
      id: 'evt-new-hold',
      type: 'human.intervention',
      timestamp: '2026-07-21T01:03:00.000Z',
      projectId: task.projectId,
      taskId: task.id,
      agentId: 'dev-1',
      data: { phase: 'code-dispatch-failed', reason: 'replacement dispatch failed' },
    });
    expect((await recoveryStore.listActive()).map(record => record.id)).toEqual([first.id]);

    runtime.responses.set(first.id, responseFor(first, 'no-op'));
    await coordinator!.pollOnce();

    const [followUp] = await recoveryStore.listActive();
    expect(followUp).toMatchObject({
      taskId: task.id,
      trigger: {
        kind: 'intervention',
        agentId: 'dev-1',
        holdPhase: 'code-dispatch-failed',
        holdNonce: 'new-hold-generation',
      },
    });
    expect(followUp?.id).not.toBe(first.id);
    await vi.waitFor(() => expect(runtime.notifications).toContain(followUp!.id));
  });

  it('replaces a stale runtime-stall record with the current hold generation', async () => {
    await createCoordinator().start();
    statusStore.set('dev-1', {
      tmuxSessionStatus: 'present',
      runtimeStatusHint: 'idle',
      reason: 'PENDING_IDLE',
      observedAt: AT,
    });
    await vi.waitFor(() => expect(runtime.notifications).toHaveLength(1));
    const [stale] = await recoveryStore.listActive();
    await vi.waitFor(() => {
      expect((coordinator as unknown as { delivering: Set<string> }).delivering.size).toBe(0);
    });

    await agentStore.set({
      ...(await agentStore.get('dev-1'))!,
      status: 'awaiting_human',
      awaitingPhase: 'code-dispatch-failed',
      awaitingSince: '2026-07-21T01:03:00.000Z',
      awaitingNonce: 'replacement-hold-generation',
      updatedAt: '2026-07-21T01:03:00.000Z',
    });

    await vi.waitFor(async () => {
      expect((await recoveryStore.get(stale!.id))?.outcome?.kind).toBe('stale');
      expect(await recoveryStore.listActive()).toEqual([
        expect.objectContaining({
          trigger: expect.objectContaining({
            holdNonce: 'replacement-hold-generation',
          }),
        }),
      ]);
    });
  });

  it('retries a failed follow-up hold scan on the next coordinator poll', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await createCoordinator().start();
    const first = await emitIntervention('server-handler-failed');
    await vi.waitFor(() => expect(runtime.notifications).toContain(first.id));
    await agentStore.set({
      ...(await agentStore.get('dev-1'))!,
      status: 'awaiting_human',
      awaitingPhase: 'code-dispatch-failed',
      awaitingSince: '2026-07-21T01:03:00.000Z',
      awaitingNonce: 'retry-hold-generation',
      updatedAt: '2026-07-21T01:03:00.000Z',
    });
    const list = agentStore.list.bind(agentStore);
    vi.spyOn(agentStore, 'list')
      .mockRejectedValueOnce(new Error('agent store unavailable'))
      .mockImplementation(list);

    runtime.responses.set(first.id, responseFor(first, 'no-op'));
    await coordinator!.pollOnce();
    expect(await recoveryStore.listActive()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`follow-up trigger recovery failed for ${task.id}`),
      expect.any(Error),
    );

    await coordinator!.pollOnce();
    expect(await recoveryStore.listActive()).toEqual([
      expect.objectContaining({
        trigger: expect.objectContaining({ holdNonce: 'retry-hold-generation' }),
      }),
    ]);
    warn.mockRestore();
  });

  it('retains an old completed record while its stable hold is still active, then prunes it after Resume', async () => {
    await agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      taskId: task.id,
      status: 'awaiting_human',
      awaitingPhase: 'dirty-workdir',
      awaitingSince: AT,
      awaitingNonce: 'long-lived-hold',
      updatedAt: AT,
    });
    await createCoordinator().start();
    const [record] = await recoveryStore.listActive();
    await vi.waitFor(() => expect(runtime.notifications).toEqual([record!.id]));
    runtime.responses.set(record!.id, responseFor(record!, 'no-op'));
    await coordinator!.pollOnce();

    now = new Date(Date.parse(AT) + 31 * 24 * 60 * 60_000);
    await coordinator!.pollOnce();
    expect(await recoveryStore.get(record!.id)).not.toBeNull();

    await agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      taskId: task.id,
      updatedAt: now.toISOString(),
    });
    now = new Date(Date.parse(AT) + 33 * 24 * 60 * 60_000);
    await coordinator!.pollOnce();
    expect(await recoveryStore.get(record!.id)).toBeNull();
  });

  it.each(['pending', 'inflight'] as const)(
    'marks a persisted %s request stale after its project leaves root scope',
    async (status) => {
      const created = await recoveryStore.createIfIdle({
        taskId: task.id,
        projectId: task.projectId,
        trigger: { kind: 'runtime-stall', observedAt: AT, reason: 'STUCK_BUSY' },
        guard: {
          status: task.status,
          phase: task.phase,
          signalToken: task.signalToken,
          agentId: task.agentId,
          reviewRound: task.reviewRound,
        },
      });
      if (status === 'inflight') {
        const inflight = await recoveryStore.markDispatched(created.record.id);
        await recoveryStore.markDelivered(inflight!.id, inflight!.attemptToken);
      }

      await createCoordinator({ projects: [] }).start();
      await coordinator!.pollOnce();

      expect(await recoveryStore.get(created.record.id)).toMatchObject({
        status: 'done',
        outcome: { kind: 'stale' },
      });
      expect(runtime.notifications).toEqual([]);
      expect(redispatch).not.toHaveBeenCalled();
    },
  );

  it('persists startup recovery without waiting for the root runtime to become available', async () => {
    await agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      taskId: task.id,
      status: 'awaiting_human',
      awaitingPhase: 'dispatch-reconcile-attempts-exhausted',
      awaitingSince: AT,
      awaitingNonce: 'hold-generation-2',
      updatedAt: AT,
    });
    let releaseRuntime!: () => void;
    const runtimeGate = new Promise<void>(resolve => {
      releaseRuntime = resolve;
    });
    vi.spyOn(runtime, 'start').mockImplementation(async () => runtimeGate);

    await createCoordinator().start();
    expect(await recoveryStore.listActive()).toHaveLength(1);
    expect(runtime.notifications).toEqual([]);

    releaseRuntime();
    await vi.waitFor(() => expect(runtime.notifications).toHaveLength(1));
  });

  it('ignores task-bound terminal attach, input, detach, and close audit events', async () => {
    await createCoordinator().start();
    for (const phase of ['attach', 'input', 'detach', 'close']) {
      await eventBus.emit({
        id: '',
        type: 'human.intervention',
        timestamp: AT,
        projectId: 'proj',
        taskId: task.id,
        agentId: 'dev-1',
        data: { phase },
      });
    }

    expect(await recoveryStore.list()).toEqual([]);
    expect(runtime.startCalls).toBe(0);
  });

  it('ignores the informational event emitted after a git review hold is cleared', async () => {
    task = { ...task, status: 'review', updatedAt: AT };
    await taskStore.set(task);
    await createCoordinator().start();

    await eventBus.emit({
      id: 'evt-hold-cleared',
      type: 'human.intervention',
      timestamp: AT,
      projectId: 'proj',
      taskId: task.id,
      agentId: 'dev-1',
      data: {
        phase: 'git-review-dispatch-hold-cleared',
        previousPhase: 'dispatch-failed:ack_unknown',
      },
    });

    expect(await recoveryStore.list()).toEqual([]);
    expect(runtime.startCalls).toBe(0);
  });

  it('ignores the informational event emitted after an agent is resumed', async () => {
    await createCoordinator().start();

    await eventBus.emit({
      id: 'evt-resumed',
      type: 'human.intervention',
      timestamp: AT,
      projectId: 'proj',
      taskId: task.id,
      agentId: 'dev-1',
      data: {
        phase: 'resumed',
        previousPhase: 'dispatch-failed:ack_unknown',
      },
    });

    expect(await recoveryStore.list()).toEqual([]);
    expect(runtime.startCalls).toBe(0);
  });

  it('marks a PENDING_IDLE request stale when the runtime recovers without changing the task', async () => {
    await createCoordinator().start();
    statusStore.set('dev-1', {
      tmuxSessionStatus: 'present',
      runtimeStatusHint: 'idle',
      reason: 'PENDING_IDLE',
      observedAt: AT,
    });
    await vi.waitFor(() => expect(runtime.notifications).toHaveLength(1));
    const [record] = await recoveryStore.listActive();

    statusStore.set('dev-1', {
      tmuxSessionStatus: 'present',
      runtimeStatusHint: 'working',
      observedAt: '2026-07-21T01:03:00.000Z',
    });
    await vi.waitFor(async () => {
      expect((await recoveryStore.get(record!.id))?.outcome?.kind).toBe('stale');
    });

    runtime.responses.set(record!.id, responseFor(record!));
    await coordinator!.pollOnce();
    expect(redispatch).not.toHaveBeenCalled();
  });

  it('completes a stale trigger from inside kickChain without waiting on itself', async () => {
    const created = await recoveryStore.createIfIdle({
      taskId: task.id,
      projectId: task.projectId,
      trigger: {
        kind: 'runtime-stall',
        observedAt: AT,
        agentId: 'dev-1',
        reason: 'PENDING_IDLE',
      },
      guard: {
        status: task.status,
        phase: task.phase,
        signalToken: task.signalToken,
        agentId: task.agentId,
        reviewRound: task.reviewRound,
      },
    });
    const instance = createCoordinator();
    const internals = instance as unknown as {
      kickChain: Promise<void>;
      finishIfTriggerStale: (agentId: string) => Promise<void>;
    };
    const chain = Promise.resolve().then(() => internals.finishIfTriggerStale('dev-1'));
    internals.kickChain = chain;

    await expect(chain).resolves.toBeUndefined();
    expect(await recoveryStore.get(created.record.id)).toMatchObject({
      status: 'done',
      outcome: { kind: 'stale' },
    });
  });

  it('does not reopen an unchanged runtime stall when only observedAt advances', async () => {
    await createCoordinator().start();
    statusStore.set('dev-1', {
      tmuxSessionStatus: 'present',
      runtimeStatusHint: 'idle',
      reason: 'PENDING_IDLE',
      observedAt: AT,
    });
    await vi.waitFor(() => expect(runtime.notifications).toHaveLength(1));
    const [record] = await recoveryStore.listActive();

    statusStore.set('dev-1', {
      tmuxSessionStatus: 'present',
      runtimeStatusHint: 'idle',
      reason: 'PENDING_IDLE',
      observedAt: '2026-07-21T01:03:00.000Z',
    });
    runtime.responses.set(record!.id, responseFor(record!, 'no-op'));
    await coordinator!.pollOnce();

    expect((await recoveryStore.get(record!.id))?.outcome?.kind).toBe('ignored');
    expect(await recoveryStore.listActive()).toEqual([]);
    expect(await recoveryStore.list()).toHaveLength(1);
  });

  it('rechecks the same material stall after the task generation advances', async () => {
    await createCoordinator().start();
    statusStore.set('dev-1', {
      tmuxSessionStatus: 'present',
      runtimeStatusHint: 'idle',
      reason: 'PENDING_IDLE',
      observedAt: AT,
    });
    await vi.waitFor(() => expect(runtime.notifications).toHaveLength(1));
    const [first] = await recoveryStore.listActive();
    const successorUpdatedAt = '2026-07-21T01:03:00.000Z';
    task = {
      ...task,
      signalToken: 'successor-token',
      updatedAt: successorUpdatedAt,
    };
    await taskStore.set(task);

    await vi.waitFor(async () => {
      expect(await recoveryStore.get(first!.id)).toMatchObject({
        status: 'done',
        outcome: { kind: 'stale' },
      });
    });
    const rechecks = (coordinator as unknown as { runtimeRechecks: Set<string> }).runtimeRechecks;
    expect(rechecks.has('dev-1')).toBe(true);
    expect(await recoveryStore.listActive()).toEqual([]);

    statusStore.set('dev-1', {
      tmuxSessionStatus: 'present',
      runtimeStatusHint: 'idle',
      reason: 'PENDING_IDLE',
      observedAt: '2026-07-21T01:04:00.000Z',
    });
    await coordinator!.pollOnce();

    expect(await recoveryStore.listActive()).toEqual([
      expect.objectContaining({
        id: expect.not.stringMatching(first!.id),
        guard: expect.objectContaining({ signalToken: 'successor-token' }),
        trigger: expect.objectContaining({
          kind: 'runtime-stall',
          observedAt: AT,
          reason: 'PENDING_IDLE',
        }),
      }),
    ]);
    expect(runtime.notifications).toHaveLength(2);
  });

  it('queues a new recovery when the same stall reason recurs after a material state change', async () => {
    await createCoordinator().start();
    statusStore.set('dev-1', {
      tmuxSessionStatus: 'present',
      runtimeStatusHint: 'idle',
      reason: 'PENDING_IDLE',
      observedAt: AT,
    });
    await vi.waitFor(() => expect(runtime.notifications).toHaveLength(1));
    const [first] = await recoveryStore.listActive();
    runtime.responses.set(first!.id, responseFor(first!, 'no-op'));
    await coordinator!.pollOnce();
    expect(await recoveryStore.listActive()).toEqual([]);

    statusStore.set('dev-1', {
      tmuxSessionStatus: 'present',
      runtimeStatusHint: 'working',
      observedAt: '2026-07-21T01:03:00.000Z',
    });
    statusStore.set('dev-1', {
      tmuxSessionStatus: 'present',
      runtimeStatusHint: 'idle',
      reason: 'PENDING_IDLE',
      observedAt: '2026-07-21T01:04:00.000Z',
    });

    await vi.waitFor(async () => {
      expect(await recoveryStore.listActive()).toEqual([
        expect.objectContaining({
          id: expect.not.stringMatching(first!.id),
          trigger: expect.objectContaining({
            kind: 'runtime-stall',
            observedAt: '2026-07-21T01:04:00.000Z',
            reason: 'PENDING_IDLE',
          }),
        }),
      ]);
    });
  });

  it('defers a runtime-stall response until the observation covers the latest binding write', async () => {
    await createCoordinator().start();
    statusStore.set('dev-1', {
      tmuxSessionStatus: 'present',
      runtimeStatusHint: 'idle',
      reason: 'PENDING_IDLE',
      observedAt: AT,
    });
    await vi.waitFor(() => expect(runtime.notifications).toHaveLength(1));
    const [record] = await recoveryStore.listActive();
    const bindingUpdatedAt = '2026-07-21T01:03:00.000Z';
    await agentStore.set({
      ...(await agentStore.get('dev-1'))!,
      updatedAt: bindingUpdatedAt,
    });
    const rechecks = (coordinator as unknown as { runtimeRechecks: Set<string> }).runtimeRechecks;
    await vi.waitFor(() => expect(rechecks.has('dev-1')).toBe(true));
    runtime.responses.set(record!.id, responseFor(record!));
    rechecks.clear();

    await coordinator!.pollOnce();

    expect(redispatch).not.toHaveBeenCalled();
    expect(rechecks.has('dev-1')).toBe(true);
    const deferred = await recoveryStore.get(record!.id);
    expect(deferred?.status).toBe('inflight');
    expect(deferred?.decision).toBeUndefined();

    statusStore.set('dev-1', {
      tmuxSessionStatus: 'present',
      runtimeStatusHint: 'idle',
      reason: 'PENDING_IDLE',
      observedAt: bindingUpdatedAt,
    });
    await coordinator!.pollOnce();

    expect(redispatch).toHaveBeenCalledOnce();
    expect(await recoveryStore.get(record!.id)).toMatchObject({
      status: 'done',
      outcome: { kind: 'executed' },
    });
  });

  it('defers a runtime-stall response when the binding advances during response read', async () => {
    await createCoordinator().start();
    statusStore.set('dev-1', {
      tmuxSessionStatus: 'present',
      runtimeStatusHint: 'idle',
      reason: 'PENDING_IDLE',
      observedAt: AT,
    });
    await vi.waitFor(() => expect(runtime.notifications).toHaveLength(1));
    const [record] = await recoveryStore.listActive();
    const read = vi.spyOn(runtime, 'readResponse').mockImplementationOnce(async () => {
      await agentStore.set({
        ...(await agentStore.get('dev-1'))!,
        updatedAt: '2026-07-21T01:03:00.000Z',
      });
      return responseFor(record!);
    });

    await coordinator!.pollOnce();

    expect(read).toHaveBeenCalledOnce();
    expect(redispatch).not.toHaveBeenCalled();
    const deferred = await recoveryStore.get(record!.id);
    expect(deferred?.status).toBe('inflight');
    expect(deferred?.decision).toBeUndefined();
    const rechecks = (coordinator as unknown as { runtimeRechecks: Set<string> }).runtimeRechecks;
    expect(rechecks.has('dev-1')).toBe(true);
  });

  it('rejects a runtime-stall decision when the binding advances after decision claim', async () => {
    await createCoordinator().start();
    statusStore.set('dev-1', {
      tmuxSessionStatus: 'present',
      runtimeStatusHint: 'idle',
      reason: 'PENDING_IDLE',
      observedAt: AT,
    });
    await vi.waitFor(() => expect(runtime.notifications).toHaveLength(1));
    const [record] = await recoveryStore.listActive();
    runtime.responses.set(record!.id, responseFor(record!));
    const realClaim = recoveryStore.claimDecision.bind(recoveryStore);
    vi.spyOn(recoveryStore, 'claimDecision').mockImplementationOnce(async (...args) => {
      const result = await realClaim(...args);
      await agentStore.set({
        ...(await agentStore.get('dev-1'))!,
        updatedAt: '2026-07-21T01:03:00.000Z',
      });
      return result;
    });

    await coordinator!.pollOnce();

    expect(redispatch).not.toHaveBeenCalled();
    expect(await recoveryStore.get(record!.id)).toMatchObject({
      status: 'done',
      decision: { action: 'redispatch-current-phase' },
      outcome: { kind: 'stale' },
    });
    const rechecks = (coordinator as unknown as { runtimeRechecks: Set<string> }).runtimeRechecks;
    expect(rechecks.has('dev-1')).toBe(true);
  });

  it('marks a held request stale when Resume clears the original hold generation', async () => {
    await agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      taskId: task.id,
      status: 'awaiting_human',
      awaitingPhase: 'code-dispatch-failed',
      awaitingSince: AT,
      awaitingNonce: 'hold-before-resume',
      updatedAt: AT,
    });
    await createCoordinator().start();
    const [record] = await recoveryStore.listActive();
    await vi.waitFor(() => expect(runtime.notifications).toEqual([record!.id]));

    await agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      taskId: task.id,
      updatedAt: '2026-07-21T01:03:00.000Z',
    });
    await vi.waitFor(async () => {
      expect((await recoveryStore.get(record!.id))?.outcome?.kind).toBe('stale');
    });
    expect(redispatch).not.toHaveBeenCalled();
  });

  it('defers a released-hold stale check until prompt notification leaves the delivery guard', async () => {
    let releaseNotify!: () => void;
    const notifyGate = new Promise<void>(resolve => { releaseNotify = resolve; });
    vi.spyOn(runtime, 'notify').mockImplementation(async record => {
      runtime.notifications.push(record.id);
      await notifyGate;
    });
    await agentStore.set({
      ...(await agentStore.get('dev-1'))!,
      status: 'awaiting_human',
      awaitingPhase: 'code-dispatch-failed',
      awaitingSince: AT,
      awaitingNonce: 'hold-released-during-notify',
    });
    await createCoordinator().start();
    const [record] = await recoveryStore.listActive();
    await vi.waitFor(() => expect(runtime.notifications).toEqual([record!.id]));

    await agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      taskId: task.id,
      updatedAt: '2026-07-21T01:03:00.000Z',
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(await recoveryStore.get(record!.id)).toMatchObject({ status: 'inflight' });
    expect(runtime.cleanups).not.toContain(record!.id);

    releaseNotify();
    await vi.waitFor(async () => {
      expect((await recoveryStore.get(record!.id))?.outcome?.kind).toBe('stale');
    });
    expect(runtime.cleanups).toContain(record!.id);
  });

  it('attributes a root runtime startup failure to the blocked task and project', async () => {
    vi.spyOn(runtime, 'start').mockRejectedValue(new Error('root host unreachable'));
    await createCoordinator().start();
    const record = await emitIntervention();

    await vi.waitFor(async () => {
      const events = await eventBus.readRange('2026-07-21', '2026-07-21');
      expect(events).toContainEqual(expect.objectContaining({
        type: 'human.intervention',
        projectId: task.projectId,
        taskId: task.id,
        data: expect.objectContaining({
          source: 'root-agent',
          phase: 'root-runtime-unavailable',
          rootRecoveryId: record.id,
        }),
      }));
    });

    now = new Date(Date.parse(AT) + 16 * 60_000);
    await coordinator!.pollOnce();
    expect(await recoveryStore.get(record.id)).toMatchObject({
      status: 'done',
      outcome: { kind: 'timeout' },
    });
  });

  it('starts the response deadline only after prompt delivery is confirmed', async () => {
    let releaseNotify!: () => void;
    const notifyGate = new Promise<void>(resolve => {
      releaseNotify = resolve;
    });
    vi.spyOn(runtime, 'notify').mockImplementation(async record => {
      runtime.notifications.push(record.id);
      await notifyGate;
    });
    await createCoordinator().start();
    const record = await emitIntervention();
    await vi.waitFor(() => expect(runtime.notifications).toEqual([record.id]));

    now = new Date('2026-07-21T01:22:03.000Z');
    const polling = coordinator!.pollOnce();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect((await recoveryStore.get(record.id))?.outcome).toBeUndefined();

    releaseNotify();
    await polling;
    await vi.waitFor(async () => {
      expect((await recoveryStore.get(record.id))?.deliveredAt).toBe(now.toISOString());
    });
    now = new Date('2026-07-21T01:38:03.000Z');
    await coordinator!.pollOnce();
    expect((await recoveryStore.get(record.id))?.outcome?.kind).toBe('timeout');
  });

  it('does not process a root-done signal while its prompt is still being delivered', async () => {
    let releaseNotify!: () => void;
    const notifyGate = new Promise<void>(resolve => {
      releaseNotify = resolve;
    });
    vi.spyOn(runtime, 'notify').mockImplementation(async record => {
      runtime.notifications.push(record.id);
      await notifyGate;
    });
    await createCoordinator().start();
    const record = await emitIntervention();
    await vi.waitFor(() => expect(runtime.notifications).toEqual([record.id]));
    runtime.responses.set(record.id, responseFor(record, 'no-op'));

    runtime.signal(record.attemptToken);
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(redispatch).not.toHaveBeenCalled();
    expect(await recoveryStore.get(record.id)).toMatchObject({ status: 'inflight' });

    releaseNotify();
    await vi.waitFor(async () => {
      expect((await recoveryStore.get(record.id))?.deliveredAt).toBeDefined();
    });
    await vi.waitFor(() => {
      expect((coordinator as unknown as { delivering: Set<string> }).delivering.size).toBe(0);
    });
    await coordinator!.pollOnce();
    expect((await recoveryStore.get(record.id))?.outcome?.kind).toBe('ignored');
    expect(redispatch).not.toHaveBeenCalled();
  });

  it('rejects a response that arrives at the response deadline before claiming its decision', async () => {
    await createCoordinator().start();
    statusStore.set('dev-1', {
      tmuxSessionStatus: 'present',
      runtimeStatusHint: 'idle',
      reason: 'PENDING_IDLE',
      observedAt: AT,
    });
    await vi.waitFor(async () => {
      expect((await recoveryStore.listActive())[0]?.deliveredAt).toBeDefined();
    });
    const [record] = await recoveryStore.listActive();
    runtime.responses.set(record!.id, responseFor(record!));
    now = new Date(Date.parse(record!.deliveredAt!) + 15 * 60_000);

    await coordinator!.pollOnce();

    expect(redispatch).not.toHaveBeenCalled();
    expect(await recoveryStore.get(record!.id)).toMatchObject({
      status: 'done',
      outcome: { kind: 'timeout' },
    });
    expect((await recoveryStore.get(record!.id))?.decision).toBeUndefined();
    const events = await eventBus.readRange('2026-07-21', '2026-07-21');
    expect(events.some(event => event.data.phase === 'root-response-timeout')).toBe(true);
  });

  it('keeps an outcome-unknown mailbox write pending and retries within its delivery deadline', async () => {
    const writeRequest = vi.spyOn(runtime, 'writeRequest')
      .mockRejectedValueOnce(new ExecOutcomeUnknownError('ssh response was lost'))
      .mockRejectedValueOnce(new ExecOutcomeUnknownError('ssh response was lost'))
      .mockImplementation(async (record, body) => {
        runtime.requests.set(record.id, body);
      });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await createCoordinator().start();
    const record = await emitIntervention();

    await vi.waitFor(() => expect(writeRequest).toHaveBeenCalledOnce());
    expect(await recoveryStore.get(record.id)).toMatchObject({
      status: 'pending',
      dispatchedAt: AT,
    });
    expect(runtime.notifications).toEqual([]);

    now = new Date(Date.parse(AT) + 61_000);
    await coordinator!.pollOnce();

    expect(writeRequest).toHaveBeenCalledTimes(2);
    expect(await recoveryStore.get(record.id)).toMatchObject({ status: 'pending' });
    let events = await eventBus.readRange('2026-07-21', '2026-07-21');
    expect(events.filter(event =>
      event.data.phase === 'root-request-delivery-retrying'
      && event.data.rootRecoveryId === record.id,
    )).toHaveLength(1);

    now = new Date(Date.parse(AT) + 122_000);
    await coordinator!.pollOnce();

    expect(writeRequest).toHaveBeenCalledTimes(3);
    expect(await recoveryStore.get(record.id)).toMatchObject({
      status: 'inflight',
      dispatchedAt: AT,
      deliveredAt: now.toISOString(),
    });
    events = await eventBus.readRange('2026-07-21', '2026-07-21');
    expect(events.some(event => event.data.phase === 'root-request-delivery-failed')).toBe(false);
    expect(events.filter(event => event.data.phase === 'root-request-delivery-retrying')).toHaveLength(1);
    warn.mockRestore();
  });

  it('terminalizes a definitely failed mailbox write instead of retrying it', async () => {
    let rejectWrite!: (reason: Error) => void;
    const blockedWrite = new Promise<void>((_resolve, reject) => { rejectWrite = reject; });
    const writeRequest = vi.spyOn(runtime, 'writeRequest').mockImplementationOnce(() => blockedWrite);
    await createCoordinator().start();
    const record = await emitIntervention();
    await vi.waitFor(() => expect(writeRequest).toHaveBeenCalledOnce());

    rejectWrite(new Error('mailbox permission denied'));
    await vi.waitFor(async () => {
      expect(await recoveryStore.get(record.id)).toMatchObject({
        status: 'done',
        outcome: { kind: 'failed' },
      });
    });
    now = new Date(Date.parse(AT) + 61_000);
    await coordinator!.pollOnce();
    expect(writeRequest).toHaveBeenCalledOnce();
    const events = await eventBus.readRange('2026-07-21', '2026-07-21');
    expect(events.some(event =>
      event.data.phase === 'root-request-delivery-failed'
      && event.data.rootRecoveryId === record.id,
    )).toBe(true);
  });

  it('returns a definitely unsubmitted prompt to pending and retries it', async () => {
    const notify = vi.spyOn(runtime, 'notify')
      .mockRejectedValueOnce(new RootPromptNotSubmittedError('root repl not ready'))
      .mockImplementation(async record => {
        runtime.notifications.push(record.id);
      });
    await createCoordinator().start();
    const record = await emitIntervention();
    await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
    await vi.waitFor(async () => {
      expect(await recoveryStore.get(record.id)).toMatchObject({ status: 'pending' });
    });
    await vi.waitFor(() => expect(runtime.cleanups).toContain(record.id));
    expect(runtime.requests.has(record.id)).toBe(false);
    expect((await recoveryStore.get(record.id))?.dispatchedAt).toBe(AT);

    now = new Date(Date.parse(AT) + 61_000);
    await coordinator!.pollOnce();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(await recoveryStore.get(record.id)).toMatchObject({
      status: 'inflight',
      dispatchedAt: AT,
      deliveredAt: now.toISOString(),
    });
    const events = await eventBus.readRange('2026-07-21', '2026-07-21');
    expect(events.some(event => event.data.phase === 'root-prompt-delivery-unknown')).toBe(false);
  });

  it('keeps an unsubmitted prompt pending and warns when mailbox cleanup fails', async () => {
    vi.spyOn(runtime, 'notify')
      .mockRejectedValueOnce(new RootPromptNotSubmittedError('root repl not ready'));
    const writeRequest = vi.spyOn(runtime, 'writeRequest');
    const cleanup = vi.spyOn(runtime, 'cleanup').mockRejectedValue(new Error('mailbox is read-only'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await createCoordinator().start();
    const record = await emitIntervention();

    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledWith(expect.objectContaining({ id: record.id })));
    expect(await recoveryStore.get(record.id)).toMatchObject({ status: 'pending' });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`unsubmitted request mailbox cleanup failed for ${record.id}`),
      expect.any(Error),
    );
    now = new Date(Date.parse(AT) + 61_000);
    await coordinator!.pollOnce();
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(writeRequest).toHaveBeenCalledOnce();
    expect(await recoveryStore.get(record.id)).toMatchObject({ status: 'pending' });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`residual pending mailbox cleanup failed for ${record.id}`),
      expect.any(Error),
    );
    warn.mockRestore();
  });

  it.each(['requeue', 'complete'] as const)(
    'expires an undelivered inflight record after its %s reconciliation write fails',
    async (failedWrite) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      if (failedWrite === 'requeue') {
        vi.spyOn(runtime, 'notify').mockRejectedValueOnce(
          new RootPromptNotSubmittedError('root repl not ready'),
        );
        vi.spyOn(recoveryStore, 'requeueUndelivered').mockRejectedValueOnce(
          new Error('requeue EIO'),
        );
      } else {
        vi.spyOn(runtime, 'notify').mockRejectedValueOnce(new Error('submit outcome unknown'));
        vi.spyOn(recoveryStore, 'complete').mockRejectedValueOnce(new Error('complete ENOSPC'));
      }
      await createCoordinator().start();
      const first = await emitIntervention();
      await vi.waitFor(async () => {
        const stored = await recoveryStore.get(first.id);
        expect(stored).toMatchObject({
          status: 'inflight',
          dispatchedAt: AT,
        });
        expect(stored?.deliveredAt).toBeUndefined();
      });

      const secondTask = {
        ...task,
        id: 'task-2',
        signalToken: 'second-task-token',
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      await taskStore.set(secondTask);
      const second = await recoveryStore.createIfIdle({
        taskId: secondTask.id,
        projectId: secondTask.projectId,
        trigger: {
          kind: 'intervention',
          observedAt: now.toISOString(),
          phase: 'checkout-preparation-failed',
        },
        guard: {
          status: secondTask.status,
          phase: secondTask.phase,
          signalToken: secondTask.signalToken,
          agentId: secondTask.agentId,
          reviewRound: secondTask.reviewRound,
        },
      });

      now = new Date(Date.parse(AT) + 16 * 60_000);
      await coordinator!.pollOnce();
      await vi.waitFor(() => expect(runtime.notifications).toContain(second.record.id));

      expect(await recoveryStore.get(first.id)).toMatchObject({
        status: 'done',
        outcome: { kind: 'timeout' },
      });
      const events = await eventBus.readRange('2026-07-21', '2026-07-21');
      expect(events.some(event =>
        event.data.phase === 'root-prompt-delivery-timeout'
        && event.data.rootRecoveryId === first.id,
      )).toBe(true);
      warn.mockRestore();
    },
  );

  it('times out repeated pre-submit failures without charging the next request for queue wait', async () => {
    const notify = vi.spyOn(runtime, 'notify')
      .mockRejectedValueOnce(new RootPromptNotSubmittedError('root repl not ready'));
    await createCoordinator().start();
    const first = await emitIntervention();
    await vi.waitFor(async () => {
      expect(await recoveryStore.get(first.id)).toMatchObject({ status: 'pending' });
    });

    const secondTask = {
      ...task,
      id: 'task-2',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    await taskStore.set(secondTask);
    const second = await recoveryStore.createIfIdle({
      taskId: secondTask.id,
      projectId: secondTask.projectId,
      trigger: { kind: 'intervention', observedAt: now.toISOString(), phase: 'checkout-preparation-failed' },
      guard: {
        status: secondTask.status,
        phase: secondTask.phase,
        signalToken: secondTask.signalToken,
        agentId: secondTask.agentId,
        reviewRound: secondTask.reviewRound,
      },
    });

    now = new Date(Date.parse(AT) + 16 * 60_000);
    await coordinator!.pollOnce();
    await vi.waitFor(() => expect(runtime.notifications).toContain(second.record.id));
    expect(await recoveryStore.get(first.id)).toMatchObject({
      status: 'done',
      outcome: { kind: 'timeout' },
    });
    expect(await recoveryStore.get(second.record.id)).toMatchObject({ status: 'inflight' });
    expect((await recoveryStore.get(second.record.id))?.dispatchedAt).toBe(now.toISOString());
    expect(notify).toHaveBeenCalledTimes(2);
    const events = await eventBus.readRange('2026-07-21', '2026-07-21');
    expect(events.some(event =>
      event.data.phase === 'root-prompt-delivery-timeout'
      && event.data.rootRecoveryId === first.id,
    )).toBe(true);
  });

  it('checks the delivery deadline before deferring a stale runtime observation', async () => {
    statusStore.set('dev-1', {
      tmuxSessionStatus: 'present',
      runtimeStatusHint: 'idle',
      reason: 'PENDING_IDLE',
      observedAt: AT,
    });
    const created = await recoveryStore.createIfIdle({
      taskId: task.id,
      projectId: task.projectId,
      trigger: {
        kind: 'runtime-stall',
        observedAt: AT,
        agentId: 'dev-1',
        reason: 'PENDING_IDLE',
      },
      guard: {
        status: task.status,
        phase: task.phase,
        signalToken: task.signalToken,
        agentId: task.agentId,
        reviewRound: task.reviewRound,
      },
    });
    await recoveryStore.markDispatchStarted(created.record.id);
    await agentStore.set({
      ...(await agentStore.get('dev-1'))!,
      updatedAt: '2026-07-21T01:03:00.000Z',
    });
    now = new Date(Date.parse(AT) + 16 * 60_000);
    await createCoordinator().start();

    await coordinator!.pollOnce();

    expect(await recoveryStore.get(created.record.id)).toMatchObject({
      status: 'done',
      outcome: { kind: 'timeout' },
    });
    expect(runtime.notifications).toEqual([]);
    const events = await eventBus.readRange('2026-07-21', '2026-07-21');
    expect(events.some(event =>
      event.data.phase === 'root-prompt-delivery-timeout'
      && event.data.rootRecoveryId === created.record.id,
    )).toBe(true);
  });

  it('defers pending delivery while the runtime observation lags the binding', async () => {
    statusStore.set('dev-1', {
      tmuxSessionStatus: 'present',
      runtimeStatusHint: 'idle',
      reason: 'PENDING_IDLE',
      observedAt: AT,
    });
    const created = await recoveryStore.createIfIdle({
      taskId: task.id,
      projectId: task.projectId,
      trigger: {
        kind: 'runtime-stall',
        observedAt: AT,
        agentId: 'dev-1',
        reason: 'PENDING_IDLE',
      },
      guard: {
        status: task.status,
        phase: task.phase,
        signalToken: task.signalToken,
        agentId: task.agentId,
        reviewRound: task.reviewRound,
      },
    });
    await agentStore.set({
      ...(await agentStore.get('dev-1'))!,
      updatedAt: '2026-07-21T01:03:00.000Z',
    });
    await createCoordinator().start();

    await coordinator!.pollOnce();

    expect(await recoveryStore.get(created.record.id)).toMatchObject({
      status: 'pending',
      dispatchedAt: AT,
    });
    expect(runtime.notifications).toEqual([]);
    const rechecks = (coordinator as unknown as { runtimeRechecks: Set<string> }).runtimeRechecks;
    expect(rechecks.has('dev-1')).toBe(true);
  });

  it('terminalizes active recoveries and prevents relaunch after an explicit runtime stop', async () => {
    await createCoordinator().start();
    const inflight = await emitIntervention();
    await vi.waitFor(async () => {
      expect(await recoveryStore.get(inflight.id)).toMatchObject({
        status: 'inflight',
        deliveredAt: AT,
      });
    });
    const pendingTask = { ...task, id: 'task-2' };
    await taskStore.set(pendingTask);
    const pending = await recoveryStore.createIfIdle({
      taskId: pendingTask.id,
      projectId: pendingTask.projectId,
      trigger: { kind: 'runtime-stall', observedAt: AT, agentId: 'dev-2', reason: 'STUCK_BUSY' },
      guard: {
        status: pendingTask.status,
        phase: pendingTask.phase,
        signalToken: pendingTask.signalToken,
        agentId: pendingTask.agentId,
        reviewRound: pendingTask.reviewRound,
      },
    });
    const startCalls = runtime.startCalls;
    const alerts = coordinator as unknown as {
      runtimeAlerts: Map<string, string>;
      deliveryAlerts: Set<string>;
    };
    alerts.runtimeAlerts.set('stale-runtime-alert', 'failure');
    alerts.deliveryAlerts.add('stale-delivery-alert');

    await expect(coordinator!.stopRuntime()).resolves.toBeUndefined();
    expect(runtime.terminateCalls).toBe(1);
    expect(coordinator!.isRuntimeExplicitlyStopped()).toBe(true);
    expect(await recoveryStore.get(inflight.id)).toMatchObject({
      status: 'done',
      outcome: { kind: 'unknown' },
    });
    expect(await recoveryStore.get(pending.record.id)).toMatchObject({
      status: 'done',
      outcome: { kind: 'escalated' },
    });
    expect(alerts.runtimeAlerts.size).toBe(0);
    expect(alerts.deliveryAlerts.size).toBe(0);

    await eventBus.emit({
      id: 'evt-after-root-stop',
      type: 'human.intervention',
      timestamp: AT,
      projectId: 'proj',
      taskId: task.id,
      agentId: 'dev-1',
      data: { phase: 'checkout-preparation-failed' },
    });
    await coordinator!.pollOnce();
    expect(runtime.startCalls).toBe(startCalls);
    expect(await recoveryStore.listActive()).toEqual([]);
    const events = await eventBus.readRange('2026-07-21', '2026-07-21');
    expect(events.some(event => event.data.phase === 'root-recovery-stopped-unknown')).toBe(true);
    expect(events.some(event => event.data.phase === 'root-recovery-stopped')).toBe(true);
  });

  it('does not touch retained mailbox state after the root runtime is explicitly stopped', async () => {
    const created = await recoveryStore.createIfIdle({
      taskId: task.id,
      projectId: task.projectId,
      trigger: {
        kind: 'intervention',
        observedAt: AT,
        phase: 'checkout-preparation-failed',
      },
      guard: {
        status: task.status,
        phase: task.phase,
        signalToken: task.signalToken,
        agentId: task.agentId,
        reviewRound: task.reviewRound,
      },
    });
    await recoveryStore.complete(created.record.id, {
      kind: 'ignored',
      detail: 'retained result',
      at: AT,
    }, created.record);
    await createCoordinator().start();
    await coordinator!.stopRuntime();
    runtime.cleanups.length = 0;
    now = new Date(Date.parse(AT) + 31 * 24 * 60 * 60_000);

    await coordinator!.pollOnce();

    expect(runtime.cleanups).toEqual([]);
    expect(await recoveryStore.get(created.record.id)).not.toBeNull();
  });

  it('poll entry does not delegate pruning after runtime control leaves active', async () => {
    const instance = createCoordinator();
    await instance.start();
    const internals = instance as unknown as {
      runtimeControlStatus: string;
      pruneCompleted: () => Promise<void>;
    };
    internals.runtimeControlStatus = 'stopped-until-restart';
    const prune = vi.spyOn(internals, 'pruneCompleted');

    await instance.pollOnce();

    expect(prune).not.toHaveBeenCalled();
  });

  it('prune entry does not inspect retained records after runtime control leaves active', async () => {
    const instance = createCoordinator();
    const internals = instance as unknown as {
      runtimeControlStatus: string;
      pruneCompleted: () => Promise<void>;
    };
    internals.runtimeControlStatus = 'stopped-until-restart';
    const listDoneBefore = vi.spyOn(recoveryStore, 'listDoneBefore');

    await internals.pruneCompleted();

    expect(listDoneBefore).not.toHaveBeenCalled();
  });

  it('prune loop stops before trigger inspection when runtime control changes after listing', async () => {
    const retained = await createCompletedRecovery({
      kind: 'intervention',
      observedAt: AT,
      agentId: 'dev-1',
      holdPhase: 'checkout-preparation-failed',
      holdSince: AT,
      holdNonce: 'hold-nonce',
    });
    const instance = createCoordinator();
    const internals = instance as unknown as {
      runtimeControlStatus: string;
      pruneCompleted: () => Promise<void>;
      triggerStillActive: (record: RootRecoveryRecord) => Promise<boolean>;
    };
    now = new Date(Date.parse(AT) + 31 * 24 * 60 * 60_000);
    vi.spyOn(recoveryStore, 'listDoneBefore').mockImplementationOnce(async () => {
      internals.runtimeControlStatus = 'stopping';
      return [retained];
    });
    const triggerStillActive = vi.spyOn(internals, 'triggerStillActive').mockResolvedValue(true);

    await internals.pruneCompleted();

    expect(triggerStillActive).not.toHaveBeenCalled();
    expect(runtime.cleanups).toEqual([]);
  });

  it('prune loop stops before cleanup when runtime control changes during trigger inspection', async () => {
    const retained = await createCompletedRecovery({
      kind: 'intervention',
      observedAt: AT,
      agentId: 'dev-1',
      holdPhase: 'checkout-preparation-failed',
      holdSince: AT,
      holdNonce: 'hold-nonce',
    });
    const instance = createCoordinator();
    const internals = instance as unknown as {
      runtimeControlStatus: string;
      pruneCompleted: () => Promise<void>;
      triggerStillActive: (record: RootRecoveryRecord) => Promise<boolean>;
    };
    now = new Date(Date.parse(AT) + 31 * 24 * 60 * 60_000);
    vi.spyOn(recoveryStore, 'listDoneBefore').mockResolvedValueOnce([retained]);
    vi.spyOn(internals, 'triggerStillActive').mockImplementationOnce(async () => {
      internals.runtimeControlStatus = 'stopping';
      return false;
    });

    await internals.pruneCompleted();

    expect(runtime.cleanups).toEqual([]);
    expect(await recoveryStore.get(retained.id)).not.toBeNull();
  });

  it('keeps recovery disabled and terminalizes active work when runtime termination is uncertain', async () => {
    vi.spyOn(runtime, 'terminate').mockRejectedValueOnce(new Error('tmux ownership probe failed'));
    await createCoordinator().start();
    const record = await emitIntervention();
    await vi.waitFor(() => expect(runtime.notifications).toContain(record.id));
    const startCalls = runtime.startCalls;

    await expect(coordinator!.stopRuntime()).rejects.toThrow(RootRuntimeStopIncompleteError);
    expect(coordinator!.isRuntimeExplicitlyStopped()).toBe(false);
    expect(coordinator!.getRuntimeControlStatus()).toBe('stop-incomplete');
    expect(coordinator!.canRepairHostAfterIncompleteStop()).toBe(false);
    expect(await recoveryStore.get(record.id)).toMatchObject({
      status: 'done',
      outcome: { kind: 'unknown' },
    });

    await coordinator!.pollOnce();
    expect(runtime.startCalls).toBe(startCalls);
  });

  it('allows host repair only after a pure transient root endpoint failure', async () => {
    vi.spyOn(runtime, 'terminate').mockRejectedValueOnce(
      new RootAgentTerminationError('tmux probe outcome unknown: ssh connection timed out', true),
    );
    await createCoordinator().start();

    await expect(coordinator!.stopRuntime()).rejects.toThrow(RootRuntimeStopIncompleteError);

    expect(coordinator!.getRuntimeControlStatus()).toBe('stop-incomplete');
    expect(coordinator!.canRepairHostAfterIncompleteStop()).toBe(true);
  });

  it('does not allow host repair when transient termination and coordinator drain both fail', async () => {
    vi.spyOn(runtime, 'terminate').mockRejectedValueOnce(
      new RootAgentTerminationError('tmux endpoint is uncertain', true),
    );
    await createCoordinator().start();
    const drain = Promise.reject(new Error('coordinator intake drain failed'));
    void drain.catch(() => undefined);
    (coordinator as unknown as { intakeChain: Promise<void> }).intakeChain = drain;

    await expect(coordinator!.stopRuntime()).rejects.toThrow(RootRuntimeStopIncompleteError);

    expect(coordinator!.getRuntimeControlStatus()).toBe('stop-incomplete');
    expect(coordinator!.canRepairHostAfterIncompleteStop()).toBe(false);
    (coordinator as unknown as { intakeChain: Promise<void> }).intakeChain = Promise.resolve();
  });

  it('opens the config gate with a warning when only ledger reconciliation fails', async () => {
    await createCoordinator().start();
    const record = await emitIntervention();
    await vi.waitFor(() => expect(runtime.notifications).toContain(record.id));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const complete = vi.spyOn(recoveryStore, 'complete')
      .mockRejectedValueOnce(new Error('recovery ledger is read-only'));

    await expect(coordinator!.stopRuntime()).resolves.toBeUndefined();
    expect(coordinator!.getRuntimeControlStatus()).toBe('stopped-until-restart');
    expect(coordinator!.isRuntimeExplicitlyStopped()).toBe(true);
    expect(coordinator!.getRuntimeStopWarning()).toContain('recovery ledger is read-only');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('recovery ledger reconciliation failed'));
    expect(await recoveryStore.get(record.id)).toMatchObject({ status: 'inflight' });

    complete.mockRestore();
    await expect(coordinator!.stopRuntime()).resolves.toBeUndefined();
    expect(runtime.terminateCalls).toBe(2);
    expect(coordinator!.getRuntimeControlStatus()).toBe('stopped-until-restart');
    expect(coordinator!.getRuntimeStopWarning()).toBeUndefined();
    expect(await recoveryStore.get(record.id)).toMatchObject({
      status: 'done',
      outcome: { kind: 'unknown' },
    });
    warn.mockRestore();
  });

  it('does not reactivate recovery when termination fails during a stop-incomplete retry', async () => {
    await createCoordinator().start();
    const record = await emitIntervention();
    await vi.waitFor(() => expect(runtime.notifications).toContain(record.id));
    const terminate = vi.spyOn(runtime, 'terminate')
      .mockRejectedValueOnce(new Error('tmux ownership probe failed'))
      .mockRejectedValueOnce(new Error('ssh connection timed out'));

    await expect(coordinator!.stopRuntime()).rejects.toThrow(RootRuntimeStopIncompleteError);
    await expect(coordinator!.stopRuntime()).rejects.toThrow(/ssh connection timed out/);
    expect(coordinator!.getRuntimeControlStatus()).toBe('stop-incomplete');
    await coordinator!.pollOnce();
    expect(redispatch).not.toHaveBeenCalled();

    terminate.mockRestore();
    await expect(coordinator!.stopRuntime()).resolves.toBeUndefined();
    expect(coordinator!.getRuntimeControlStatus()).toBe('stopped-until-restart');
  });

  it('rechecks and stops a root session that reappears after a completed stop', async () => {
    await createCoordinator().start();

    await coordinator!.stopRuntime();
    await coordinator!.stopRuntime();

    expect(runtime.terminateCalls).toBe(2);
    expect(coordinator!.getRuntimeControlStatus()).toBe('stopped-until-restart');
  });

  it('reports disabled after a normal coordinator shutdown', async () => {
    await createCoordinator().start();
    const alerts = coordinator as unknown as {
      runtimeAlerts: Map<string, string>;
      deliveryAlerts: Set<string>;
    };
    alerts.runtimeAlerts.set('stale-runtime-alert', 'failure');
    alerts.deliveryAlerts.add('stale-delivery-alert');

    await coordinator!.stop();

    expect(runtime.stopCalls).toBe(1);
    expect(coordinator!.getRuntimeControlStatus()).toBe('disabled');
    expect(alerts.runtimeAlerts.size).toBe(0);
    expect(alerts.deliveryAlerts.size).toBe(0);
  });

  it('drains an in-flight runtime start without publishing a prompt during shutdown', async () => {
    let releaseStart!: () => void;
    const startBlocked = new Promise<void>(resolve => { releaseStart = resolve; });
    let enteredStart!: () => void;
    const startEntered = new Promise<void>(resolve => { enteredStart = resolve; });
    vi.spyOn(runtime, 'start').mockImplementationOnce(async () => {
      runtime.startCalls++;
      enteredStart();
      await startBlocked;
    });
    await createCoordinator().start();
    const record = await emitIntervention();
    await startEntered;

    const stop = coordinator!.stop();
    let stopSettled = false;
    void stop.finally(() => { stopSettled = true; }).catch(() => undefined);
    expect(stopSettled).toBe(false);
    releaseStart();
    await stop;

    expect(runtime.requests.has(record.id)).toBe(false);
    expect(runtime.notifications).not.toContain(record.id);
    expect(runtime.stopCalls).toBe(1);
    expect(coordinator!.getRuntimeControlStatus()).toBe('disabled');
  });

  it('waits for post-delivery reconciliation before stopping the root runtime', async () => {
    let releaseNotify!: () => void;
    const notifyGate = new Promise<void>(resolve => { releaseNotify = resolve; });
    vi.spyOn(runtime, 'notify').mockImplementation(async record => {
      runtime.notifications.push(record.id);
      await notifyGate;
    });
    const cleanup = runtime.cleanup.bind(runtime);
    let cleanupEntered!: () => void;
    const enteredCleanup = new Promise<void>(resolve => { cleanupEntered = resolve; });
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>(resolve => { releaseCleanup = resolve; });
    vi.spyOn(runtime, 'cleanup').mockImplementation(async record => {
      cleanupEntered();
      await cleanupGate;
      await cleanup(record);
    });
    await createCoordinator().start();
    const record = await emitIntervention();
    await vi.waitFor(() => expect(runtime.notifications).toContain(record.id));
    await taskStore.set({
      ...task,
      signalToken: 'new-task-generation',
      updatedAt: '2026-07-21T01:03:00.000Z',
    });

    releaseNotify();
    await enteredCleanup;
    const stop = coordinator!.stop();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(runtime.stopCalls).toBe(0);

    releaseCleanup();
    await stop;
    expect(runtime.stopCalls).toBe(1);
    expect(await recoveryStore.get(record.id)).toMatchObject({
      status: 'done',
      outcome: { kind: 'stale' },
    });
  });

  it('lets explicit stop drain stale post-delivery reconciliation without a kick-cycle deadlock', async () => {
    let releaseNotify!: () => void;
    const notifyGate = new Promise<void>(resolve => { releaseNotify = resolve; });
    vi.spyOn(runtime, 'notify').mockImplementation(async record => {
      runtime.notifications.push(record.id);
      await notifyGate;
    });
    await createCoordinator().start();
    const record = await emitIntervention();
    await vi.waitFor(() => expect(runtime.notifications).toContain(record.id));
    await taskStore.set({
      ...task,
      signalToken: 'new-task-generation',
      updatedAt: '2026-07-21T01:03:00.000Z',
    });

    const stop = coordinator!.stopRuntime();
    releaseNotify();
    await expect(stop).resolves.toBeUndefined();

    expect(runtime.terminateCalls).toBe(1);
    expect(coordinator!.getRuntimeControlStatus()).toBe('stopped-until-restart');
    expect(await recoveryStore.get(record.id)).toMatchObject({
      status: 'done',
      outcome: { kind: 'stale' },
    });
  });

  it('reports a post-delivery reconciliation failure through coordinator shutdown', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let releaseNotify!: () => void;
    const notifyGate = new Promise<void>(resolve => { releaseNotify = resolve; });
    vi.spyOn(runtime, 'notify').mockImplementation(async record => {
      runtime.notifications.push(record.id);
      await notifyGate;
    });
    await createCoordinator().start();
    const record = await emitIntervention();
    await vi.waitFor(() => expect(runtime.notifications).toContain(record.id));
    await taskStore.set({
      ...task,
      signalToken: 'new-task-generation',
      updatedAt: '2026-07-21T01:03:00.000Z',
    });
    await new Promise(resolve => setTimeout(resolve, 10));

    const listActive = recoveryStore.listActive.bind(recoveryStore);
    let reconciliationEntered!: () => void;
    const enteredReconciliation = new Promise<void>(resolve => { reconciliationEntered = resolve; });
    let releaseFailure!: () => void;
    const failureGate = new Promise<void>(resolve => { releaseFailure = resolve; });
    vi.spyOn(recoveryStore, 'listActive')
      .mockImplementationOnce(async () => {
        reconciliationEntered();
        await failureGate;
        throw new Error('recovery ledger unavailable');
      })
      .mockImplementation(listActive);

    releaseNotify();
    await enteredReconciliation;
    const stop = coordinator!.stop();
    releaseFailure();

    await expect(stop).rejects.toThrow('recovery ledger unavailable');
    expect(runtime.stopCalls).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`post-delivery reconciliation failed for ${record.id}`),
      expect.any(Error),
    );
    warn.mockRestore();
  });

  it('waits for an executing root decision before completing coordinator shutdown', async () => {
    await createCoordinator().start();
    const binding = await agentStore.get('dev-1');
    await agentStore.set({
      ...binding!,
      status: 'awaiting_human',
      awaitingPhase: 'checkout-preparation-failed',
      awaitingSince: AT,
      awaitingNonce: 'shutdown-drain-hold',
    });
    const record = await emitIntervention();
    await vi.waitFor(() => expect(runtime.notifications).toContain(record.id));
    runtime.responses.set(record.id, responseFor(record));
    let releaseRedispatch!: () => void;
    const redispatchBlocked = new Promise<void>(resolve => { releaseRedispatch = resolve; });
    let enteredRedispatch!: () => void;
    const redispatchEntered = new Promise<void>(resolve => { enteredRedispatch = resolve; });
    redispatch.mockImplementationOnce(async () => {
      enteredRedispatch();
      await redispatchBlocked;
      return 'dispatched';
    });

    const poll = coordinator!.pollOnce();
    await redispatchEntered;
    const stop = coordinator!.stop();
    let stopSettled = false;
    void stop.finally(() => { stopSettled = true; }).catch(() => undefined);

    expect(stopSettled).toBe(false);
    expect(runtime.stopCalls).toBe(0);
    releaseRedispatch();
    await Promise.all([poll, stop]);

    expect(await recoveryStore.get(record.id)).toMatchObject({
      status: 'done',
      outcome: { kind: 'executed' },
    });
    expect(runtime.stopCalls).toBe(1);
  });

  it('drains coordinator work that joins while shutdown is already waiting', async () => {
    await createCoordinator().start();
    await vi.waitFor(() => {
      expect((coordinator as unknown as { polling: Set<Promise<void>> }).polling.size).toBe(0);
    });
    let releaseIntake!: () => void;
    const intakeGate = new Promise<void>(resolve => { releaseIntake = resolve; });
    (coordinator as unknown as { intakeChain: Promise<void> }).intakeChain = intakeGate;

    const stop = coordinator!.stop();
    now = new Date(Date.parse(AT) + 25 * 60 * 60_000);
    const listDoneBefore = recoveryStore.listDoneBefore.bind(recoveryStore);
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
    let enterSecond!: () => void;
    const secondEntered = new Promise<void>(resolve => { enterSecond = resolve; });
    vi.spyOn(recoveryStore, 'listDoneBefore')
      .mockImplementationOnce(async cutoff => {
        enterSecond();
        await secondGate;
        return listDoneBefore(cutoff);
      })
      .mockImplementation(listDoneBefore);
    const secondPoll = coordinator!.pollOnce();
    await secondEntered;

    releaseIntake();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(runtime.stopCalls).toBe(0);

    releaseSecond();
    await Promise.all([secondPoll, stop]);
    expect(runtime.stopCalls).toBe(1);
  });

  it('waits for an intake already writing its record before completing an explicit stop', async () => {
    await createCoordinator().start();
    const createIfIdle = recoveryStore.createIfIdle.bind(recoveryStore);
    let releaseCreate!: () => void;
    const createBlocked = new Promise<void>(resolve => { releaseCreate = resolve; });
    let enteredCreate!: () => void;
    const createEntered = new Promise<void>(resolve => { enteredCreate = resolve; });
    vi.spyOn(recoveryStore, 'createIfIdle').mockImplementationOnce(async input => {
      enteredCreate();
      await createBlocked;
      return createIfIdle(input);
    });
    const intake = eventBus.emit({
      id: 'evt-stop-intake-race',
      type: 'human.intervention',
      timestamp: AT,
      projectId: 'proj',
      taskId: task.id,
      agentId: 'dev-1',
      data: { phase: 'checkout-preparation-failed' },
    });
    await createEntered;

    const stop = coordinator!.stopRuntime();
    await vi.waitFor(() => expect(runtime.terminateCalls).toBe(1));
    releaseCreate();
    await Promise.all([intake, stop]);

    expect(await recoveryStore.listActive()).toEqual([]);
    expect(coordinator!.isRuntimeExplicitlyStopped()).toBe(true);
  });

  it('retries stop completion against a concurrently advanced recovery generation', async () => {
    await createCoordinator().start();
    const record = await emitIntervention();
    await vi.waitFor(() => expect(runtime.notifications).toContain(record.id));
    const complete = recoveryStore.complete.bind(recoveryStore);
    vi.spyOn(recoveryStore, 'complete')
      .mockImplementationOnce(async (id, outcome, expected) => {
        await recoveryStore.claimDecision(id, record.attemptToken, {
          action: 'no-op',
          reason: 'Concurrent response claim.',
        });
        return complete(id, outcome, expected);
      })
      .mockImplementation(complete);

    await expect(coordinator!.stopRuntime()).resolves.toBeUndefined();

    expect(await recoveryStore.get(record.id)).toMatchObject({
      status: 'done',
      decision: { action: 'no-op' },
      outcome: { kind: 'unknown' },
    });
    expect(coordinator!.isRuntimeExplicitlyStopped()).toBe(true);
  });

  it('waits for an executing root decision before reporting the runtime stopped', async () => {
    await createCoordinator().start();
    const binding = await agentStore.get('dev-1');
    await agentStore.set({
      ...binding!,
      status: 'awaiting_human',
      awaitingPhase: 'checkout-preparation-failed',
      awaitingSince: AT,
      awaitingNonce: 'stop-drain-hold',
    });
    const record = await emitIntervention();
    await vi.waitFor(() => expect(runtime.notifications).toContain(record.id));
    runtime.responses.set(record.id, responseFor(record));
    let releaseRedispatch!: () => void;
    const redispatchBlocked = new Promise<void>(resolve => { releaseRedispatch = resolve; });
    let enteredRedispatch!: () => void;
    const redispatchEntered = new Promise<void>(resolve => { enteredRedispatch = resolve; });
    redispatch.mockImplementationOnce(async () => {
      enteredRedispatch();
      await redispatchBlocked;
      return 'dispatched';
    });

    const poll = coordinator!.pollOnce();
    await redispatchEntered;
    const stop = coordinator!.stopRuntime();
    let stopSettled = false;
    void stop.finally(() => { stopSettled = true; }).catch(() => undefined);
    await vi.waitFor(() => expect(runtime.terminateCalls).toBe(1));

    expect(stopSettled).toBe(false);
    expect(coordinator!.getRuntimeControlStatus()).toBe('stopping');
    releaseRedispatch();
    await Promise.all([poll, stop]);

    expect(await recoveryStore.get(record.id)).toMatchObject({
      status: 'done',
      outcome: { kind: 'executed' },
    });
    expect(coordinator!.getRuntimeControlStatus()).toBe('stopped-until-restart');
  });

  it('does not execute a root decision whose claim overlaps an explicit stop', async () => {
    await createCoordinator().start();
    const binding = await agentStore.get('dev-1');
    await agentStore.set({
      ...binding!,
      status: 'awaiting_human',
      awaitingPhase: 'checkout-preparation-failed',
      awaitingSince: AT,
      awaitingNonce: 'stop-overlap-hold',
    });
    const record = await emitIntervention();
    await vi.waitFor(() => expect(runtime.notifications).toContain(record.id));
    runtime.responses.set(record.id, responseFor(record));
    const claimDecision = recoveryStore.claimDecision.bind(recoveryStore);
    let releaseClaim!: () => void;
    const claimBlocked = new Promise<void>(resolve => { releaseClaim = resolve; });
    let enteredClaim!: () => void;
    const claimEntered = new Promise<void>(resolve => { enteredClaim = resolve; });
    vi.spyOn(recoveryStore, 'claimDecision').mockImplementationOnce(async (...args) => {
      const result = await claimDecision(...args);
      enteredClaim();
      await claimBlocked;
      return result;
    });

    const poll = coordinator!.pollOnce();
    await claimEntered;
    const stop = coordinator!.stopRuntime();
    await vi.waitFor(() => expect(runtime.terminateCalls).toBe(1));
    releaseClaim();
    await Promise.all([poll, stop]);

    expect(redispatch).not.toHaveBeenCalled();
    expect(await recoveryStore.get(record.id)).toMatchObject({
      status: 'done',
      decision: { action: 'redispatch-current-phase' },
      outcome: { kind: 'unknown' },
    });
  });

  it('retries transient response reads but immediately fails a published invalid response', async () => {
    const read = vi.spyOn(runtime, 'readResponse')
      .mockRejectedValueOnce(new Error('ssh transport reset'))
      .mockRejectedValueOnce(new RootAgentResponseInvalidError('root response is invalid JSON'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await createCoordinator().start();
    const record = await emitIntervention();
    await vi.waitFor(() => expect(runtime.notifications).toEqual([record.id]));

    await coordinator!.pollOnce();
    expect(await recoveryStore.get(record.id)).toMatchObject({ status: 'inflight' });
    await coordinator!.pollOnce();
    expect(await recoveryStore.get(record.id)).toMatchObject({
      status: 'done',
      outcome: { kind: 'failed', detail: 'root response is invalid JSON' },
    });
    const events = await eventBus.readRange('2026-07-21', '2026-07-21');
    expect(events.some(event =>
      event.data.source === 'root-agent'
      && event.data.phase === 'root-response-invalid'
      && event.data.rootRecoveryId === record.id,
    )).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('isolates a failing runtime recheck so response processing still advances', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await createCoordinator().start();
    const record = await emitIntervention();
    await vi.waitFor(() => expect(runtime.notifications).toEqual([record.id]));
    runtime.responses.set(record.id, responseFor(record, 'no-op'));
    statusStore.set('dev-1', {
      tmuxSessionStatus: 'present',
      runtimeStatusHint: 'idle',
      reason: 'PENDING_IDLE',
      observedAt: AT,
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    const rechecks = (coordinator as unknown as { runtimeRechecks: Set<string> }).runtimeRechecks;
    rechecks.add('dev-1');
    vi.spyOn(agentStore, 'get').mockRejectedValueOnce(new Error('binding store unavailable'));

    await expect(coordinator!.pollOnce()).resolves.toBeUndefined();
    expect(await recoveryStore.get(record.id)).toMatchObject({
      status: 'done',
      outcome: { kind: 'ignored' },
    });
    expect(rechecks.has('dev-1')).toBe(false);
    expect(await recoveryStore.listActive()).toEqual([
      expect.objectContaining({
        trigger: expect.objectContaining({
          kind: 'runtime-stall',
          agentId: 'dev-1',
          reason: 'PENDING_IDLE',
        }),
      }),
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('runtime recheck failed for dev-1'),
      expect.any(Error),
    );
    warn.mockRestore();
  });

  it('defers stale completion and mailbox cleanup until prompt delivery finishes', async () => {
    let releaseNotify!: () => void;
    const notifyGate = new Promise<void>(resolve => {
      releaseNotify = resolve;
    });
    vi.spyOn(runtime, 'notify').mockImplementation(async record => {
      runtime.notifications.push(record.id);
      await notifyGate;
    });
    await createCoordinator().start();
    const record = await emitIntervention();
    await vi.waitFor(() => expect(runtime.notifications).toEqual([record.id]));

    await taskStore.set({
      ...task,
      signalToken: 'fedcba654321',
      updatedAt: '2026-07-21T01:03:00.000Z',
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(await recoveryStore.get(record.id)).toMatchObject({ status: 'inflight' });
    expect(runtime.cleanups).not.toContain(record.id);

    releaseNotify();
    await vi.waitFor(async () => {
      expect((await recoveryStore.get(record.id))?.outcome?.kind).toBe('stale');
    });
    expect(runtime.cleanups).toContain(record.id);
  });

  it('rolls back a failed start so the coordinator can be started again', async () => {
    const realListActive = recoveryStore.listActive.bind(recoveryStore);
    vi.spyOn(recoveryStore, 'listActive')
      .mockRejectedValueOnce(new Error('corrupt recovery ledger'))
      .mockImplementation(realListActive);
    const instance = createCoordinator();

    await expect(instance.start()).rejects.toThrow('corrupt recovery ledger');
    expect(instance.getRuntimeControlStatus()).toBe('disabled');
    await expect(instance.start()).resolves.toBeUndefined();
    expect(instance.getRuntimeControlStatus()).toBe('active');
    const record = await emitIntervention();
    await vi.waitFor(() => expect(runtime.notifications).toContain(record.id));
    expect(runtime.stopCalls).toBe(1);
  });

  it('exposes an explicit stop after startup rollback instead of leaving config gates ambiguous', async () => {
    vi.spyOn(recoveryStore, 'listActive').mockRejectedValueOnce(new Error('corrupt recovery ledger'));
    const instance = createCoordinator();

    await expect(instance.start()).rejects.toThrow('corrupt recovery ledger');
    expect(instance.getRuntimeControlStatus()).toBe('disabled');

    const stop = instance.stopRuntime();
    expect(instance.getRuntimeControlStatus()).toBe('stopping');
    await expect(stop).resolves.toBeUndefined();
    expect(instance.getRuntimeControlStatus()).toBe('stopped-until-restart');
    expect(instance.isRuntimeExplicitlyStopped()).toBe(true);
  });

  it('opens the config gate after confirmed termination even when a corrupt ledger stays unreadable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(recoveryStore, 'listActive').mockRejectedValue(new Error('corrupt recovery ledger'));
    const instance = createCoordinator();

    await expect(instance.start()).rejects.toThrow('corrupt recovery ledger');
    expect(instance.getRuntimeControlStatus()).toBe('disabled');
    await expect(instance.stopRuntime()).resolves.toBeUndefined();

    expect(runtime.terminateCalls).toBe(1);
    expect(instance.getRuntimeControlStatus()).toBe('stopped-until-restart');
    expect(instance.isRuntimeExplicitlyStopped()).toBe(true);
    expect(instance.getRuntimeStopWarning()).toContain('corrupt recovery ledger');
  });
});
