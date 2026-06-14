import type { FastifyInstance } from 'fastify';

export async function pollerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/pollers', async () => app.ctx.poller?.snapshots() ?? []);
}
