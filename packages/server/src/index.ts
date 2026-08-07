import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import {
  loadConfig,
  resolveHome,
  createDefaultConfig,
} from './config/loader.js';
import { auditPlatformBindings, platformEntries, type PlatformEntryDeps } from './platform/startup.js';
import { initStateDir } from './state/init.js';
import { AgentStore } from './state/agent-store.js';
import { TaskStore } from './state/task-store.js';
import { ErrorRecordStore } from './state/error-record-store.js';
import { PetStore } from './state/pet-store.js';
import { LockManager } from './state/lock.js';
import { ProcessLock, ProcessLockError } from './state/process-lock.js';
import { EventBus } from './event/bus.js';
import { EventLog } from './event/log.js';
import { AgentManager } from './agent/manager.js';
import { PaneStreamerManager } from './agent/pane-streamer-manager.js';
import { EventBroker } from './event/broker.js';
import { EventPublisher } from './event/publish.js';
import { autoBootstrapAgentIds, bootstrapAutoRepos } from './agent/bootstrap.js';
import { registerEventHandlers, recoverGitPostApprovePending } from './event/handlers.js';
import { PlatformPoller, platformTaskView, type PlatformPollerOptions } from './platform/platform-poller.js';
import { PrConversationCache } from './platform/pr-conversation-cache.js';
import { platformPollerStatePath } from './platform/comment-cursor.js';
import { buildProjectDriver, makeDriverExec, repoIdentityKey } from './platform/driver-host.js';
import { loadPlatformPlugins } from './platform/plugin-loader.js';
import { createRunner, resolveAgentHost } from './agent/runner.js';
import type { AgentRuntimeConfig, HostConfig } from './shared/index.js';
import { CONFIG_FILE } from './shared/index.js';
import { TmuxProbePoller, TmuxSessionStatusStore } from './agent/tmux-probe-poller.js';
import { PeriodicTaskRunner } from './timing/periodic-task-runner.js';
import { BootstrapPoller } from './agent/bootstrap-poller.js';
import { DispatchReconciler } from './agent/dispatch-reconciler.js';
import { buildApp } from './app.js';
import { RestartCoordinator } from './lifecycle/restart.js';
import { consumeRestartSentinel } from './lifecycle/restart-sentinel.js';

export function pickExistingPath(base: string, candidates: readonly string[]): string {
  for (const rel of candidates) {
    const p = resolve(base, rel);
    if (existsSync(p)) return p;
  }
  return resolve(base, candidates[0]);
}

function formatUrlHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

export function formatServerRunningMessage(host: string, port: number, https: boolean): string {
  const scheme = https ? 'https' : 'http';
  return `baxian server running on ${scheme}://${formatUrlHost(host)}:${port}`;
}

export function createPlatformPollerOptions(
  agentManager: AgentManager,
  eventBus: EventBus,
): PlatformPollerOptions {
  return {
    onEvent: async (projectId, mapped) => {
      const task = mapped.taskId === undefined ? undefined : await agentManager.getTask(mapped.taskId);
      await eventBus.emit({
        id: '',
        type: mapped.type,
        timestamp: new Date().toISOString(),
        projectId: task?.projectId ?? projectId,
        ...(task ? { taskId: task.id, ...(task.agentId ? { agentId: task.agentId } : {}) } : {}),
        data: mapped.data,
      });
    },
    tasks: async (projectId) =>
      (await agentManager.listTasksForPlatformEntry(projectId)).map(platformTaskView),
    task: async (taskId) => {
      const task = await agentManager.getTask(taskId);
      return task === null ? null : platformTaskView(task);
    },
    onCursorCommitted: (taskId, _prNumber, sourceKey, watermarkTime) =>
      agentManager.pruneConsumedFeedback(taskId, sourceKey, watermarkTime),
    onConversationRevision: (taskId, conversation) =>
      agentManager.noteReviewConversationRevision(taskId, conversation),
  };
}

export async function startServer(home?: string): Promise<void> {
  const stateDir = resolveHome(home);
  const cfgPath = join(stateDir, CONFIG_FILE);
  for (const plugin of await loadPlatformPlugins(stateDir)) {
    console.log(`[startup] platform plugin ${plugin.name}@${plugin.version} active (platform: ${plugin.platform})`);
  }
  if (await createDefaultConfig(cfgPath)) {
    console.log(`Initialized config at ${cfgPath}`);
  }
  const config = await loadConfig(cfgPath);

  await initStateDir(stateDir);

  const processLock = new ProcessLock(stateDir);
  try {
    await processLock.acquire();
  } catch (err) {
    if (err instanceof ProcessLockError) {
      console.error('[startup] process lock acquisition failed', err);
    }
    throw err;
  }
  const releaseLockStrict = (): Promise<void> => processLock.release();
  const releaseLockBestEffort = async (): Promise<void> => {
    try {
      await releaseLockStrict();
    } catch (e) {
      console.warn('[shutdown] processLock.release failed', e);
    }
  };
  let appRef: Awaited<ReturnType<typeof buildApp>> | null = null;
  let stopBackgroundRunners: () => void = () => undefined;
  let shuttingDown = false;
  const SHUTDOWN_GRACE_MS = 8000;
  const gracefulShutdown = async (exitCode: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      stopBackgroundRunners();
      if (appRef) {
        await Promise.race([
          appRef.close(),
          new Promise<void>((r) => { setTimeout(r, SHUTDOWN_GRACE_MS).unref?.(); }),
        ]);
      }
      await releaseLockBestEffort();
    } catch (e) {
      console.warn('[shutdown] graceful shutdown failed', e);
    } finally {
      process.exit(exitCode);
    }
  };
  process.once('exit', () => { processLock.releaseSync(); });
  process.once('SIGINT', () => { void gracefulShutdown(130); });
  process.once('SIGTERM', () => { void gracefulShutdown(143); });

  try {
    const sentinel = await consumeRestartSentinel(stateDir);
    if (sentinel) {
      console.log(
        `[startup] restart confirmed (parentPid=${sentinel.parentPid}, ` +
        `actor=${sentinel.actor}, age=${Date.now() - sentinel.createdAt}ms)`,
      );
    }

    const serverDistDir = dirname(fileURLToPath(import.meta.url));
    const agentStore = new AgentStore(`${stateDir}/state/agents`);
    const taskStore = new TaskStore(`${stateDir}/state/tasks`);
    const errorRecordStore = new ErrorRecordStore(`${stateDir}/state/errors`);
    const petStore = new PetStore(`${stateDir}/state/pets`);
    const lockManager = new LockManager(`${stateDir}/locks`);
    const eventLog = new EventLog(`${stateDir}/events`);
    const eventBus = new EventBus(eventLog);
    const eventBroker = new EventBroker();
    const tmuxSessionStatusStore = new TmuxSessionStatusStore();

    let resolveHostRef: (agent: AgentRuntimeConfig) => HostConfig | undefined = () => undefined;
    const paneStreamerManager = new PaneStreamerManager({
      runnerFactory: (agent) => createRunner(agent.mode, resolveHostRef(agent)),
      hostResolver: (agent) => resolveHostRef(agent),
    });

    const driverExec = makeDriverExec(createRunner('local'));
    const platformEntryDeps: PlatformEntryDeps = {
      driverFor: (project) => buildProjectDriver(project, driverExec),
      statePathFor: (repoUrl) => platformPollerStatePath(stateDir, repoUrl),
    };
    let defaultBranchOf: (projectId: string) => string | undefined = () => undefined;
    const prConversationCache = new PrConversationCache();
    const agentManager: AgentManager = new AgentManager({
      config,
      agentStore,
      taskStore,
      lockManager,
      eventBus,
      paneStreamerManager,
      errorRecordStore,
      imageStagingRoot: `${stateDir}/state/task-images`,
      platformDefaultBranchOf: (projectId) => defaultBranchOf(projectId),
      prConversationCache,
    });
    resolveHostRef = (agent) => resolveAgentHost(agentManager.getConfig().host, agent.host);

    const tmuxProbePoller = new TmuxProbePoller({
      config,
      store: tmuxSessionStatusStore,
      agentManager,
      agentStore,
      errorRecordStore,
    });
    await agentManager.recover();
    registerEventHandlers(eventBus, agentManager);
    await recoverGitPostApprovePending(eventBus, agentManager).catch(err => {
      console.warn('[index] recoverGitPostApprovePending failed:', err);
    });
    const gitOutboxFlusher = new PeriodicTaskRunner({
      name: 'GitMaintenance',
      intervalMs: 60_000,
      run: async () => {
        await agentManager.flushTaskOutboxes();
        await recoverGitPostApprovePending(eventBus, agentManager);
        await agentManager.retryPendingGitReviewDispatches();
        await agentManager.retryGitRemoteCleanupIntents();
      },
      onError: e => console.warn('[GitMaintenance] sweep failed:', e),
    });
    gitOutboxFlusher.start();
    stopBackgroundRunners = () => gitOutboxFlusher.stop();
    await agentManager.setupRecoveredPostApproveSignals();
    await agentManager.setupRecoveredSpecSignals();
    paneStreamerManager.startupScan((config.project ?? []).flatMap((p) => (p.agent ?? []).flat()));

    const snapshotCtx = { agentManager, agentStore, taskStore, tmuxSessionStatusStore, errorRecordStore, petStore };
    const eventPublisher = new EventPublisher(eventBroker, snapshotCtx, taskStore);
    agentStore.onChange((kind, id) => eventPublisher.publishAgentChange(kind, id));
    tmuxSessionStatusStore.onChange((kind, id) => eventPublisher.publishAgentChange(kind, id));
    taskStore.onChange((kind, id) => eventPublisher.publishTaskChange(kind, id));
    petStore.onChange((id) => eventPublisher.publishAgentChange('set', id));

    const onBootstrapAgentAffected = (ids: string[]) => {
      for (const id of ids) eventPublisher.publishAgentChange('set', id);
    };

    const dispatchReconciler = new DispatchReconciler({
      manager: agentManager,
      taskStore,
      agentStore,
      statusStore: tmuxSessionStatusStore,
      eventBus,
      intervalMs: config.server.dispatchReconcileIntervalMs,
      busyWaitBudgetMs: config.server.dispatchBusyWaitBudgetMs,
      maxAttempts: config.server.dispatchReconcileMaxAttempts,
    });

    const bootstrapPoller = new BootstrapPoller({
      config,
      agentStore,
      eventBus,
      repoCache: agentManager.getRepoCache(),
      errorRecordStore,
      onAgentAffected: onBootstrapAgentAffected,
      onPollComplete: () => agentManager.reconcileTaskBranches(),
    });

    try {
      const result = await errorRecordStore.sweepStaleBootstrapErrors(autoBootstrapAgentIds(config));
      if (result.removed > 0) {
        console.log(`[startup] swept ${result.removed} stale bootstrap error records for agents no longer in auto-bootstrap`);
      }
    } catch (err) {
      console.warn('[startup] sweepStaleBootstrapErrors failed:', err);
    }

    void bootstrapAutoRepos({
      config,
      agentStore,
      eventBus,
      repoCache: agentManager.getRepoCache(),
      errorRecordStore,
      onAgentAffected: onBootstrapAgentAffected,
    }).catch(err => console.error('[baxian] bootstrap failed:', err));

    const poller = new PlatformPoller(createPlatformPollerOptions(agentManager, eventBus));
    defaultBranchOf = (projectId) => {
      const repo = agentManager.getConfig().project.find(p => p.id === projectId)?.repo;
      return repo === undefined ? undefined : poller.defaultBranchSnapshot(repoIdentityKey(repo));
    };
    poller.setLifecycleHook(() => {
      eventPublisher.publishPollersChange(() => poller.snapshots());
    });
    await auditPlatformBindings(
      config,
      () => agentManager.listActiveGitTasks(),
      (task, mismatch) => agentManager.emitPlatformBindingIntervention(task, mismatch),
    );
    poller.reconcile(platformEntries(config, platformEntryDeps));
    poller.start(config.server.platformPollIntervalMs);

    const httpsOpts = config.server.https
      ? {
          key: readFileSync(config.server.https.keyFile),
          cert: readFileSync(config.server.https.certFile),
        }
      : undefined;
    const webRoot = pickExistingPath(serverDistDir, ['./web', '../../web/dist']);

    const app = await buildApp(
      {
        config,
        agentManager,
        agentStore,
        taskStore,
        lockManager,
        eventBus,
        eventLog,
        tmuxSessionStatusStore,
        tmuxProbePoller,
        bootstrapPoller,
        dispatchReconciler,
        configPath: cfgPath,
        stateDir,
        poller,
        platformEntryDeps,
        paneStreamerManager,
        eventBroker,
        errorRecordStore,
        petStore,
        prConversationCache,
      },
      {
        ...(httpsOpts ? { https: httpsOpts } : {}),
        webRoot,
      },
    );

    appRef = app;

    const restartCoordinator = new RestartCoordinator({
      app,
      configPath: cfgPath,
      stateDir,
      beforeExit: releaseLockStrict,
    });
    app.ctx.restartCoordinator = restartCoordinator;

    const host = config.server.host;
    if (host !== '127.0.0.1' && !config.server.token) {
      console.warn(
        `[baxian] server.host=${host} but no server.token configured — API is unauthenticated. Set a token before exposing the server.`,
      );
    }
    await app.listen({ port: config.server.port, host });
    tmuxProbePoller.start();
    bootstrapPoller.start();
    dispatchReconciler.start();
    console.log(formatServerRunningMessage(host, config.server.port, Boolean(config.server.https)));
  } catch (err) {
    stopBackgroundRunners();
    await releaseLockBestEffort();
    throw err;
  }
}

if (process.argv[1]?.endsWith('index.js')) {
  startServer().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
