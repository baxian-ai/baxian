import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rename, stat } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import {
  loadConfig,
  resolveConfigPath,
  resolveStateDir,
  userConfigPath,
  createDefaultConfig,
} from './config/loader.js';
import { loadPluginsOrExplain } from './platform/startup.js';
import { initStateDir } from './state/init.js';
import { AgentStore } from './state/agent-store.js';
import { TaskStore } from './state/task-store.js';
import { ErrorRecordStore } from './state/error-record-store.js';
import { PostApproveStore } from './state/post-approve-store.js';
import { ReviewStore } from './state/review-store.js';
import { PetStore } from './state/pet-store.js';
import { LockManager } from './state/lock.js';
import { ProcessLock, ProcessLockError } from './state/process-lock.js';
import { EventBus } from './event/bus.js';
import { EventLog } from './event/log.js';
import { SkillRegistry, assertCoreSkillsPresent } from './skill/registry.js';
import { AgentManager } from './agent/manager.js';
import { PaneStreamerManager } from './agent/pane-streamer-manager.js';
import { EventBroker } from './event/broker.js';
import { EventPublisher } from './event/publish.js';
import { autoBootstrapAgentIds, bootstrapAutoRepos } from './agent/bootstrap.js';
import { registerEventHandlers, recoverGitPostApprovePending } from './event/handlers.js';
import { registerServerEventHandlers } from './event/server-handlers.js';
import { GitHubPoller, pollerStatePathFor } from './github/poller.js';
import { resolveEventRouting } from './github/resolver.js';
import { createRunner, resolveAgentHost } from './agent/runner.js';
import type { AgentConfig, HostConfig } from './shared/index.js';
import { isGitHubRepo, repoSlug } from './shared/index.js';
import { TmuxProbePoller, TmuxSessionStatusStore } from './agent/tmux-probe-poller.js';
import { PeriodicTaskRunner } from './timing/periodic-task-runner.js';
import { BootstrapPoller } from './agent/bootstrap-poller.js';
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

export async function migrateLegacyPollerStateFile(
  stateDir: string,
  legacyProjectIds: string[],
  newStatePath: string,
): Promise<void> {
  try {
    await stat(newStatePath);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[startup] poller cursor migration: stat(${newStatePath}) failed:`, err);
      return;
    }
  }
  for (const legacyId of legacyProjectIds) {
    const legacyPath = join(stateDir, 'state', `poller-${legacyId}.json`);
    try {
      await rename(legacyPath, newStatePath);
      console.log(`[startup] migrated poller cursor ${legacyPath} → ${newStatePath}`);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') continue;
      console.warn(`[startup] poller cursor migration ${legacyPath} → ${newStatePath} failed:`, err);
      return;
    }
  }
}

function formatUrlHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

export function formatServerRunningMessage(host: string, port: number, https: boolean): string {
  const scheme = https ? 'https' : 'http';
  return `baxian server running on ${scheme}://${formatUrlHost(host)}:${port}`;
}

export async function startServer(configPath?: string): Promise<void> {
  let cfgPath = await resolveConfigPath(configPath);
  if (!cfgPath) {
    cfgPath = userConfigPath();
    await createDefaultConfig(cfgPath);
    console.log(`Initialized config at ${cfgPath} (no baxian.json found in cwd, no ~/.baxian/config.json yet)`);
  }
  const config = await loadConfig(cfgPath);

  const stateDir = resolveStateDir(cfgPath);
  const [pluginsResult] = await Promise.all([loadPluginsOrExplain(config), initStateDir(stateDir)]);
  if ('fatal' in pluginsResult) {
    for (const line of pluginsResult.fatal) console.error(line);
    process.exit(1);
  }
  // M3a：registry 注入 AgentManager 供 'git' 路径 live 解析；poller 装配切换留 M3c。
  const pluginRegistry = pluginsResult.registry;

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
    const skillsDir = pickExistingPath(serverDistDir, ['./skills', '../../../skills']);

    const agentStore = new AgentStore(`${stateDir}/state/agents`);
    const taskStore = new TaskStore(`${stateDir}/state/tasks`);
    const errorRecordStore = new ErrorRecordStore(`${stateDir}/state/errors`);
    const postApproveStore = new PostApproveStore(`${stateDir}/state/post-approve`);
    const petStore = new PetStore(`${stateDir}/state/pets`);
    const lockManager = new LockManager(`${stateDir}/locks`);
    const eventLog = new EventLog(`${stateDir}/events`);
    const eventBus = new EventBus(eventLog);
    const eventBroker = new EventBroker();
    const tmuxSessionStatusStore = new TmuxSessionStatusStore();

    const registry = new SkillRegistry(skillsDir);
    await registry.scan();
    assertCoreSkillsPresent(registry, skillsDir);

    let resolveHostRef: (agent: AgentConfig) => HostConfig | undefined = (agent) =>
      (typeof agent.host === 'object' ? agent.host : undefined);
    const paneStreamerManager = new PaneStreamerManager({
      runnerFactory: (agent) => createRunner(agent.mode, resolveHostRef(agent)),
      hostResolver: (agent) => resolveHostRef(agent),
    });

    const reviewStore = new ReviewStore(`${stateDir}/state/reviews`);
    const agentManager = new AgentManager({
      config,
      agentStore,
      taskStore,
      lockManager,
      eventBus,
      skillRegistry: registry,
      paneStreamerManager,
      postApproveStore,
      pluginRegistry,
      errorRecordStore,
      reviewStore,
      imageStagingRoot: `${stateDir}/state/task-images`,
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
    // 'git' 专属恢复（阀关下无任务恒 no-op）：durable pendingRedispatch 的补派
    await recoverGitPostApprovePending(eventBus, agentManager).catch(err => {
      console.warn('[index] recoverGitPostApprovePending failed:', err);
    });
    // outbox 的进程内重试（spec §6 至少一次）：closed-unmerged 锚会停子轮询、observed 缓存抑制
    // 重复观察，滞留条目不能只等重启补投
    const gitOutboxFlusher = new PeriodicTaskRunner({
      name: 'GitMaintenance',
      intervalMs: 60_000,
      // durable pending 的运行时消费（spec §6 至少一次）：outbox 补投 + post-approve 补派 + 评审派发重试
      run: async () => {
        await agentManager.flushGitOutbox();
        await recoverGitPostApprovePending(eventBus, agentManager);
        await agentManager.retryPendingGitReviewDispatches();
      },
      onError: e => console.warn('[GitMaintenance] sweep failed:', e),
    });
    gitOutboxFlusher.start();
    stopBackgroundRunners = () => gitOutboxFlusher.stop();
    registerServerEventHandlers(eventBus, agentManager);
    await agentManager.setupRecoveredPostApproveSignals();
    await agentManager.setupRecoveredSpecSignals();

    const snapshotCtx = { agentManager, agentStore, taskStore, tmuxSessionStatusStore, errorRecordStore, petStore };
    const eventPublisher = new EventPublisher(eventBroker, snapshotCtx, taskStore);
    agentStore.onChange((kind, id) => eventPublisher.publishAgentChange(kind, id));
    tmuxSessionStatusStore.onChange((kind, id) => eventPublisher.publishAgentChange(kind, id));
    taskStore.onChange((kind, id) => eventPublisher.publishTaskChange(kind, id));
    petStore.onChange((id) => eventPublisher.publishAgentChange('set', id));

    const onBootstrapAgentAffected = (ids: string[]) => {
      for (const id of ids) eventPublisher.publishAgentChange('set', id);
    };

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

    const poller = new GitHubPoller({
      runner: createRunner('local'),
      knownPrNumbersFor: async (projectId) => {
        const tasks = await agentManager.listTasksByProject(projectId);
        return new Set(
          tasks
            .filter(t => typeof t.prNumber === 'number' && t.agentId)
            .map(t => t.prNumber!),
        );
      },
      onEvent: async (projectId, mapped) => {
        const routing = await resolveEventRouting(agentManager, mapped);
        await eventBus.emit({
          id: '',
          type: mapped.type,
          timestamp: new Date().toISOString(),
          projectId,
          ...(routing.taskId ? { taskId: routing.taskId } : {}),
          ...(routing.agentId ? { agentId: routing.agentId } : {}),
          data: mapped.data,
        });
      },
    });
    const seenRepos = new Set<string>();
    for (const project of config.project) {
      if (!isGitHubRepo(project.repo)) continue;
      const repoKey = repoSlug(project.repo).toLowerCase();
      if (seenRepos.has(repoKey)) continue;
      seenRepos.add(repoKey);
      const newStatePath = pollerStatePathFor(stateDir, repoKey);
      const legacyIds = config.project
        .filter(p => repoSlug(p.repo).toLowerCase() === repoKey)
        .map(p => p.id);
      await migrateLegacyPollerStateFile(stateDir, legacyIds, newStatePath);
      poller.add({ projectId: project.id, repo: project.repo, statePath: newStatePath });
    }
    poller.setLifecycleHook(() => {
      eventPublisher.publishPollersChange(() => poller.snapshots());
    });
    poller.start(config.server.githubPollIntervalMs);

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
        configPath: cfgPath,
        stateDir,
        poller,
        githubRunner: createRunner('local'),
        paneStreamerManager,
        eventBroker,
        errorRecordStore,
        petStore,
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
    console.log(formatServerRunningMessage(host, config.server.port, Boolean(config.server.https)));
  } catch (err) {
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
