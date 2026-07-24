import type { FastifyInstance } from 'fastify';
import { buildAgentSnapshotById, buildAllAgentSnapshots } from '../state/snapshot.js';
import { decodeBase64Image, ImageValidationError } from '../agent/image-input.js';
import { RootRuntimeStopIncompleteError } from '../agent/root-recovery-coordinator.js';
import { IMAGE_UPLOAD_ROUTE_BODY_LIMIT, ROOT_AGENT_ID } from '../shared/index.js';

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  app.get('/agents', async () => buildAllAgentSnapshots(app.ctx));

  app.get(`/agents/${ROOT_AGENT_ID}/session`, async (_request, reply) => {
    const coordinator = app.ctx.rootRecoveryCoordinator;
    if (!coordinator) {
      return reply.status(404).send({ error: 'Root agent is not configured' });
    }
    const recoveryStatus = coordinator.getRuntimeControlStatus();
    const warning = coordinator.getRuntimeStopWarning();
    return {
      id: ROOT_AGENT_ID,
      recoveryStatus,
      recoveryEnabled: recoveryStatus === 'active',
      ...(warning ? { warning } : {}),
    };
  });

  app.get<{ Params: { id: string } }>('/agents/:id', async (request, reply) => {
    const configured = app.ctx.agentManager.getAgentConfig(request.params.id);
    if (!configured) {
      return reply.status(404).send({ error: 'Agent not found' });
    }
    void configured;
    return buildAgentSnapshotById(app.ctx, request.params.id);
  });

  app.delete<{ Params: { id: string } }>('/agents/:id/session', async (request, reply) => {
    if (request.params.id === ROOT_AGENT_ID) {
      if (!app.ctx.rootRecoveryCoordinator) {
        return reply.status(404).send({ error: 'Root agent is not configured' });
      }
      try {
        await app.ctx.rootRecoveryCoordinator.stopRuntime();
      } catch (err) {
        if (err instanceof RootRuntimeStopIncompleteError) {
          return reply.status(503).send({
            error: err.message,
            recoveryStatus: app.ctx.rootRecoveryCoordinator.getRuntimeControlStatus(),
            retryable: true,
          });
        }
        throw err;
      }
      const warning = app.ctx.rootRecoveryCoordinator.getRuntimeStopWarning();
      return reply.status(200).send({
        stopped: true,
        recoveryStatus: app.ctx.rootRecoveryCoordinator.getRuntimeControlStatus(),
        message: warning
          ? `Root recovery is disabled until the Baxian server restarts. ${warning}`
          : 'Root recovery is disabled until the Baxian server restarts.',
      });
    }
    const state = await app.ctx.agentStore.get(request.params.id);
    if (state?.taskId) {
      try {
        await app.ctx.agentManager.cancelTask(state.taskId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        app.log.warn({ err: message, agentId: request.params.id, taskId: state.taskId },
          'DELETE /agents/:id/session: cancelTask failed; proceeding with idle response');
      }
    }
    return reply.status(204).send();
  });

  app.post<{ Params: { id: string } }>('/agents/:id/compact', async (request, reply) => {
    await app.ctx.agentManager.compactAgent(request.params.id);
    return reply.status(200).send({ compacted: true });
  });

  app.post<{ Params: { id: string } }>('/agents/:id/clear', async (request, reply) => {
    await app.ctx.agentManager.clearAgent(request.params.id);
    return reply.status(200).send({ cleared: true });
  });

  app.post<{ Params: { id: string }; Body: { dataBase64?: unknown } }>(
    '/agents/:id/images',
    { bodyLimit: IMAGE_UPLOAD_ROUTE_BODY_LIMIT },
    async (request, reply) => {
      const dataBase64 = request.body?.dataBase64;
      if (typeof dataBase64 !== 'string' || dataBase64.length === 0) {
        return reply.status(400).send({ error: 'dataBase64 (base64-encoded image) is required' });
      }
      let decoded: { bytes: Buffer; ext: string };
      try {
        decoded = decodeBase64Image(dataBase64);
      } catch (err) {
        if (err instanceof ImageValidationError) return reply.status(400).send({ error: err.message });
        throw err;
      }
      const result = await app.ctx.agentManager.attachImageToRunningAgent(
        request.params.id,
        decoded.bytes,
        decoded.ext,
      );
      return reply.status(200).send(result);
    },
  );
}
