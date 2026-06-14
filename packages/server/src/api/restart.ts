import type { FastifyInstance } from 'fastify';

export async function restartRoutes(app: FastifyInstance): Promise<void> {
  app.post('/restart', async (request, reply) => {
    const coord = app.ctx.restartCoordinator;
    if (!coord) {
      return reply.status(503).send({ error: 'Restart not configured' });
    }
    if (coord.isRestarting()) {
      return reply.status(409).send({ error: 'Restart already in progress' });
    }
    const actor =
      typeof request.headers['x-baxian-actor'] === 'string'
        ? request.headers['x-baxian-actor']
        : 'unknown';
    coord.beginRestart({ actor });
    reply.status(202).send({ acceptedAt: new Date().toISOString() });
    setImmediate(() => {
      void coord.execute();
    });
  });
}
