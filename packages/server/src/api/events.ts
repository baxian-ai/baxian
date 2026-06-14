import type { FastifyInstance } from 'fastify';

interface EventQuery {
  date?: string;
  from?: string;
  to?: string;
}

export async function eventRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: EventQuery }>('/events', async (request) => {
    const { date, from, to } = request.query;

    if (from && to) {
      return app.ctx.eventLog.readRange(from, to);
    }

    const targetDate = date ?? new Date().toISOString().slice(0, 10);
    return app.ctx.eventLog.readDate(targetDate);
  });
}
