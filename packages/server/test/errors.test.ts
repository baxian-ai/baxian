import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { ApiError } from '../src/errors.js';

function buildTestApp() {
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      reply.status(err.status).send({ error: err.message });
      return;
    }
    reply.status(500).send({ error: 'internal_error' });
  });
  return app;
}

describe('ApiError + setErrorHandler', () => {
  it('throws ApiError → reply with err.status + { error: msg }', async () => {
    const app = buildTestApp();
    app.get('/test-409', async () => {
      throw new ApiError(409, 'Conflict happened');
    });

    const res = await app.inject({ method: 'GET', url: '/test-409' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'Conflict happened' });

    await app.close();
  });

  it('throws regular Error → reply 500 internal_error', async () => {
    const app = buildTestApp();
    app.get('/test-500', async () => {
      throw new Error('boom');
    });

    const res = await app.inject({ method: 'GET', url: '/test-500' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal_error' });

    await app.close();
  });

  it('preserves custom status codes (400, 404, 422, etc.)', async () => {
    const app = buildTestApp();
    app.get('/bad', async () => {
      throw new ApiError(400, 'Bad request');
    });
    app.get('/missing', async () => {
      throw new ApiError(404, 'Not found');
    });

    const bad = await app.inject({ method: 'GET', url: '/bad' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: 'Bad request' });

    const missing = await app.inject({ method: 'GET', url: '/missing' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'Not found' });

    await app.close();
  });

  it('ApiError class fields', () => {
    const err = new ApiError(400, 'Bad request');
    expect(err.status).toBe(400);
    expect(err.message).toBe('Bad request');
    expect(err.name).toBe('ApiError');
    expect(err instanceof Error).toBe(true);
    expect(err instanceof ApiError).toBe(true);
  });
});
