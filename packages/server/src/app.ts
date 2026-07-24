import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import type { BaxianConfig } from './shared/index.js';
import type { AgentManager } from './agent/manager.js';
import type { AgentStore } from './state/agent-store.js';
import type { TaskStore } from './state/task-store.js';
import type { LockManager } from './state/lock.js';
import type { EventBus } from './event/bus.js';
import type { EventLog } from './event/log.js';
import type { PlatformPoller } from './platform/platform-poller.js';
import type { PlatformEntryDeps } from './platform/startup.js';
import type { TmuxProbePoller, TmuxSessionStatusStore } from './agent/tmux-probe-poller.js';
import type { BootstrapPoller } from './agent/bootstrap-poller.js';
import type { DispatchReconciler } from './agent/dispatch-reconciler.js';
import type { PaneStreamerManager } from './agent/pane-streamer-manager.js';
import type { RestartCoordinator } from './lifecycle/restart.js';
import type { EventBroker } from './event/broker.js';
import type { ErrorRecordStore } from './state/error-record-store.js';
import type { PetStore } from './state/pet-store.js';
import type { RootRecoveryCoordinator } from './agent/root-recovery-coordinator.js';
import { agentRoutes } from './api/agents.js';
import { petRoutes } from './api/pets.js';
import { taskRoutes } from './api/tasks.js';
import { eventRoutes } from './api/events.js';
import { configRoutes } from './api/config.js';
import { hostRoutes } from './api/hosts.js';
import { projectRoutes } from './api/projects.js';
import { probeRoutes } from './api/probe.js';
import { restartRoutes } from './api/restart.js';
import { pollerRoutes } from './api/pollers.js';
import { streamWsPlugin } from './terminal/stream-ws.js';
import { eventsWsPlugin } from './event/ws.js';
import { closeSshMux } from './agent/runner.js';
import { ApiError } from './errors.js';

export interface AppContext {
  config: BaxianConfig;
  agentManager: AgentManager;
  agentStore: AgentStore;
  taskStore: TaskStore;
  lockManager: LockManager;
  eventBus: EventBus;
  eventLog: EventLog;
  tmuxSessionStatusStore: TmuxSessionStatusStore;
  tmuxProbePoller?: TmuxProbePoller;
  bootstrapPoller?: BootstrapPoller;
  dispatchReconciler?: DispatchReconciler;
  configPath?: string;
  stateDir?: string;
  poller?: PlatformPoller;
  platformEntryDeps?: PlatformEntryDeps;
  paneStreamerManager?: PaneStreamerManager;
  restartCoordinator?: RestartCoordinator;
  eventBroker?: EventBroker;
  errorRecordStore?: ErrorRecordStore;
  petStore?: PetStore;
  rootRecoveryCoordinator?: RootRecoveryCoordinator;
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
}

export interface BuildAppOpts {
  https?: { key: Buffer | string; cert: Buffer | string };
  webRoot?: string;
}

const IS_API_REQUEST = /^\/api(\/|\?|$)/;

const ASSET_EXTENSIONS = new Set([
  'js', 'mjs', 'cjs', 'css', 'map',
  'ico', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'json', 'txt', 'xml', 'wasm', 'pdf',
  'mp3', 'mp4', 'webm', 'ogg', 'wav',
]);

function lastPathExtension(rawUrl: string): string | undefined {
  const pathOnly = rawUrl.split('?')[0].split('#')[0];
  const seg = pathOnly.substring(pathOnly.lastIndexOf('/') + 1);
  const dot = seg.lastIndexOf('.');
  if (dot === -1 || dot === seg.length - 1) return undefined;
  return seg.slice(dot + 1).toLowerCase();
}

function normalizeHost(raw: string): string {
  const s = raw.trim().toLowerCase();
  if (s.startsWith('[')) {
    const close = s.indexOf(']');
    return close === -1 ? s.slice(1) : s.slice(1, close);
  }
  const firstColon = s.indexOf(':');
  if (firstColon !== -1 && s.indexOf(':', firstColon + 1) === -1) {
    return s.slice(0, firstColon);
  }
  return s;
}

function isApiRequest(rawUrl: string): { isApi: boolean; malformed: boolean } {
  let decoded: string;
  try {
    decoded = decodeURI(rawUrl);
  } catch {
    return { isApi: false, malformed: true };
  }
  return { isApi: IS_API_REQUEST.test(decoded) || IS_API_REQUEST.test(rawUrl), malformed: false };
}

export async function buildApp(ctx: AppContext, opts: BuildAppOpts = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    ...(opts.https ? { https: opts.https } : {}),
  });
  const startedAt = new Date().toISOString();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      reply.status(err.status).send({ error: err.message });
      return;
    }
    const statusCode = (err as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      const msg = (err as { message?: unknown }).message;
      reply.status(statusCode).send({ error: typeof msg === 'string' ? msg : 'bad_request' });
      return;
    }
    console.error('[fastify] unhandled error:', err);
    reply.status(500).send({ error: 'internal_error' });
  });
  await app.register(cors, { origin: false });
  await app.register(websocket);
  app.decorate('ctx', ctx);
  app.addHook('onClose', async () => {
    app.ctx.tmuxProbePoller?.stop();
    app.ctx.bootstrapPoller?.stop();
    app.ctx.dispatchReconciler?.stop();
    app.ctx.poller?.stop();
    try {
      await app.ctx.rootRecoveryCoordinator?.stop();
    } catch (err) {
      console.error('[app] rootRecoveryCoordinator.stop on close failed:', err);
    }
    try {
      await app.ctx.paneStreamerManager?.destroyAll();
    } catch (err) {
      console.error('[app] paneStreamerManager.destroyAll on close failed:', err);
    }
    try {
      await closeSshMux();
    } catch (err) {
      console.error('[app] closeSshMux on close failed:', err);
    }
  });

  let allowedHostsMemo: { ref: readonly string[]; set: Set<string> } | null = null;
  app.addHook('onRequest', async (request, reply) => {
    const list = app.ctx.config.server.allowedHosts;
    if (!list || list.length === 0) return;
    if (allowedHostsMemo === null || allowedHostsMemo.ref !== list) {
      allowedHostsMemo = { ref: list, set: new Set(list.map(normalizeHost)) };
    }
    const host = normalizeHost(request.hostname ?? '');
    if (!allowedHostsMemo.set.has(host)) {
      return reply.status(404).send();
    }
  });

  app.addHook('onRequest', async (request, reply) => {
    const token = app.ctx.config.server.token;
    if (!token) return;
    const { isApi, malformed } = isApiRequest(request.url);
    if (malformed) return reply.status(400).send({ error: 'malformed_url' });
    if (!isApi) return;
    let decodedUrl: string;
    try {
      decodedUrl = decodeURI(request.url);
    } catch {
      return reply.status(400).send({ error: 'malformed_url' });
    }
    if (decodedUrl === '/api/stream' || decodedUrl.startsWith('/api/stream?')) return;
    if (decodedUrl === '/api/realtime' || decodedUrl.startsWith('/api/realtime?')) return;
    const auth = request.headers.authorization ?? '';
    if (auth !== `Bearer ${token}`) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
  });

  app.get('/health', async () => ({ status: 'ok', startedAt }));
  await app.register(agentRoutes, { prefix: '/api' });
  await app.register(petRoutes, { prefix: '/api' });
  await app.register(taskRoutes, { prefix: '/api' });
  await app.register(eventRoutes, { prefix: '/api' });
  await app.register(configRoutes, { prefix: '/api' });
  await app.register(hostRoutes, { prefix: '/api' });
  await app.register(projectRoutes, { prefix: '/api' });
  await app.register(probeRoutes, { prefix: '/api' });
  await app.register(restartRoutes, { prefix: '/api' });
  await app.register(pollerRoutes, { prefix: '/api' });
  await app.register(streamWsPlugin, { prefix: '/api' });
  await app.register(eventsWsPlugin, { prefix: '/api' });

  if (opts.webRoot) {
    await app.register(fastifyStatic, {
      root: opts.webRoot,
      prefix: '/',
      wildcard: false,
      cacheControl: false,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        } else {
          res.setHeader('Cache-Control', 'public, max-age=3600');
        }
      },
    });
    app.setNotFoundHandler(async (request, reply) => {
      const { isApi, malformed } = isApiRequest(request.url);
      if (malformed) return reply.status(400).send({ error: 'malformed_url' });
      if (isApi) return reply.status(404).send({ error: 'not_found' });
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return reply.status(404).send({ error: 'not_found' });
      }
      const ext = lastPathExtension(request.url);
      if (ext !== undefined && ASSET_EXTENSIONS.has(ext)) {
        return reply.status(404).send({ error: 'not_found' });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}
