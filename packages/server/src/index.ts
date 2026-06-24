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
import { SkillRegistry } from './skill/registry.js';
import { AgentManager } from './agent/manager.js';
import { PaneStreamerManager } from './agent/pane-streamer-manager.js';
import { EventBroker } from './event/broker.js';
import { EventPublisher } from './event/publish.js';
import { autoBootstrapAgentIds, bootstrapAutoRepos } from './agent/bootstrap.js';
import { registerEventHandlers } from './event/handlers.js';
import { registerServerEventHandlers } from './event/server-handlers.js';
import { GitHubPoller, pollerStatePathFor } from './github/poller.js';
import { resolveEventRouting } from './github/resolver.js';
import { createRunner, resolveAgentHost } from './agent/runner.js';
import type { AgentConfig, HostConfig } from './shared/index.js';
import { BRANCH_PREFIX, isGitHubRepo, repoSlug } from './shared/index.js';
import { TmuxProbePoller, TmuxSessionStatusStore } from './agent/tmux-probe-poller.js';
import { BootstrapPoller } from './agent/bootstrap-poller.js';
import { buildApp } from './app.js';
import { RestartCoordinator } from './lifecycle/restart.js';
import { consumeRestartSentinel } from './lifecycle/restart-sentinel.js';

// All-miss returns first candidate so caller surfaces ENOENT instead of silently using wrong path.
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
  // Zero-config first run: auto-create a minimal user-level config at ~/.baxian/config.json
  // so `baxian` works straight after `npm install -g baxian`. UI then populates project/agent
  // via saveConfig writebacks. Explicit -c <path> doesn't auto-create — surface ENOENT instead.
  let cfgPath = await resolveConfigPath(configPath);
  if (!cfgPath) {
    cfgPath = userConfigPath();
    await createDefaultConfig(cfgPath);
    console.log(`Initialized config at ${cfgPath} (no baxian.json found in cwd, no ~/.baxian/config.json yet)`);
  }
  const config = await loadConfig(cfgPath);

  const stateDir = resolveStateDir(cfgPath);
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
  // SIGINT/SIGTERM and /api/restart share one graceful path: app.close() runs the onClose chain
  // (stop pollers → destroy pane streamers/PTYs → converge SSH mux). The process lock is released
  // LAST — AFTER app.close() — so a supervisor restart can't grab the lock while this process is
  // still tearing down tmux/ssh sessions. (Fastify runs onClose hooks LIFO, so the lock release
  // can't live in an onClose hook without racing ahead of the cleanup hook.) Grace-race so a hung
  // PTY kill can't wedge exit.
  let appRef: Awaited<ReturnType<typeof buildApp>> | null = null;
  let shuttingDown = false;
  const SHUTDOWN_GRACE_MS = 8000;
  const gracefulShutdown = async (exitCode: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
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

    // Resolve host refs against the LIVE config (hot-reload swaps it). Pointed at agentManager.getConfig
    // once that exists — using a holder avoids the use-before-declaration cycle (manager needs the streamer).
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
    registerServerEventHandlers(eventBus, agentManager);
    // Set up signal watchers AFTER handlers register so emits land on live listeners.
    await agentManager.setupRecoveredPostApproveSignals();
    await agentManager.setupRecoveredSpecSignals();

    const snapshotCtx = { agentManager, agentStore, taskStore, tmuxSessionStatusStore, errorRecordStore, petStore };
    const eventPublisher = new EventPublisher(eventBroker, snapshotCtx, taskStore);
    agentStore.onChange((kind, id) => eventPublisher.publishAgentChange(kind, id));
    tmuxSessionStatusStore.onChange((kind, id) => eventPublisher.publishAgentChange(kind, id));
    taskStore.onChange((kind, id) => eventPublisher.publishTaskChange(kind, id));
    // Pet assignment changes (set/clear, and delete cascade) re-broadcast affected agent snapshots.
    petStore.onChange((id) => eventPublisher.publishAgentChange('set', id));

    // Notify subscribers when bootstrap touches an agent's error state; agentStore alone misses
    // failure paths since those don't mutate any binding. Must be wired AFTER publisher exists.
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
    });

    const migrationResult = await taskStore.migrateLegacyFiles();
    if (migrationResult.migrated > 0 || migrationResult.failed > 0) {
      console.log(
        `[startup] task-store migration: ${migrationResult.migrated} migrated, ${migrationResult.failed} failed`,
      );
    }

    // Sweep stale bootstrap errors for agents no longer in the auto-bootstrap set. Covers:
    // (a) agent deleted while server was down; (b) agent transitioned to explicit workdir
    // mode (id stays, leaves bootstrap); (c) PATCH /config restartRequired window where the
    // old poller appended a fresh stale record before the operator restarted.
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
      knownBranchesFor: async (projectId) => {
        const tasks = await agentManager.listTasksByProject(projectId);
        return new Set(
          tasks
            .filter(t => t.branch && !t.branch.startsWith(BRANCH_PREFIX) && t.agentId)
            .map(t => t.branch!),
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
      // Non-GitHub repos never produce a pollable PR (forced server mode, no afterDone:'pr');
      // polling would hammer `gh api` on a non-github URL forever. Skip — mirror replaceConfig.
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

    // Lock release is NOT an onClose hook: Fastify runs onClose LIFO, so a hook registered here
    // would fire BEFORE buildApp's cleanup hook (pollers/streamers/SSH mux). Instead the lock is
    // released after app.close() — by gracefulShutdown (signals) and by RestartCoordinator's
    // beforeExit (/api/restart) — guaranteeing cleanup completes first.
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
