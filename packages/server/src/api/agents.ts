import type { FastifyInstance } from 'fastify';
import { buildAgentSnapshotById, buildAllAgentSnapshots } from '../state/snapshot.js';
import { decodeBase64Image, ImageValidationError } from '../agent/image-input.js';
import { IMAGE_UPLOAD_ROUTE_BODY_LIMIT } from '../shared/index.js';

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  // Use the startup agent index so /agents matches preview/stop until restart.
  app.get('/agents', async () => buildAllAgentSnapshots(app.ctx));

  app.get<{ Params: { id: string } }>('/agents/:id', async (request, reply) => {
    const configured = app.ctx.agentManager.getAgentConfig(request.params.id);
    if (!configured) {
      return reply.status(404).send({ error: 'Agent not found' });
    }
    void configured;
    return buildAgentSnapshotById(app.ctx, request.params.id);
  });

  app.delete<{ Params: { id: string } }>('/agents/:id/session', async (request, reply) => {
    const state = await app.ctx.agentStore.get(request.params.id);
    if (state?.taskId) {
      try {
        await app.ctx.agentManager.cancelTask(state.taskId);
      } catch (err) {
        // Task may already be terminal (cancel during merge race); 204 is the right
        // response either way — the route's contract is "no active session for this agent".
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

  // Upload an image to a running agent; server writes it to the agent
  // host and pastes the absolute path into the live pane (no Enter).
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
