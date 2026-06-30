import type { FastifyInstance } from 'fastify';
import { decodePetSpritesheet, PetValidationError, validatePetManifest } from '../agent/pet-input.js';
import { PET_UPLOAD_ROUTE_BODY_LIMIT } from '../shared/index.js';
import { withConfigLock } from '../config/mutex.js';

export async function petRoutes(app: FastifyInstance): Promise<void> {
  app.get('/pets', async () => (app.ctx.petStore ? app.ctx.petStore.list() : []));

  app.post<{ Body: { petJson?: unknown; spritesheetBase64?: unknown } }>(
    '/pets',
    { bodyLimit: PET_UPLOAD_ROUTE_BODY_LIMIT },
    async (request, reply) => {
      const store = app.ctx.petStore;
      if (!store) return reply.status(503).send({ error: 'pet store unavailable' });
      const spritesheetBase64 = request.body?.spritesheetBase64;
      if (typeof spritesheetBase64 !== 'string' || spritesheetBase64.length === 0) {
        return reply.status(400).send({ error: 'spritesheetBase64 is required' });
      }
      let manifest: ReturnType<typeof validatePetManifest>;
      let sprite: ReturnType<typeof decodePetSpritesheet>;
      try {
        manifest = validatePetManifest(request.body?.petJson);
        sprite = decodePetSpritesheet(spritesheetBase64);
      } catch (err) {
        if (err instanceof PetValidationError) return reply.status(400).send({ error: err.message });
        throw err;
      }
      const meta = await store.create({
        displayName: manifest.displayName,
        description: manifest.description,
        spritesheet: sprite,
      });
      return reply.status(201).send(meta);
    },
  );

  app.delete<{ Params: { id: string } }>('/pets/:id', async (request, reply) => {
    const store = app.ctx.petStore;
    if (!store) return reply.status(503).send({ error: 'pet store unavailable' });
    const meta = await store.getMeta(request.params.id);
    if (!meta) return reply.status(404).send({ error: 'pet not found' });
    await store.delete(request.params.id);
    return reply.status(204).send();
  });

  app.get<{ Params: { id: string } }>('/pets/:id/spritesheet', async (request, reply) => {
    const store = app.ctx.petStore;
    if (!store) return reply.status(503).send({ error: 'pet store unavailable' });
    const sprite = await store.readSpritesheet(request.params.id);
    if (!sprite) return reply.status(404).send({ error: 'pet not found' });
    reply.header('Content-Type', sprite.ext === 'png' ? 'image/png' : 'image/webp');
    reply.header('Cache-Control', 'private, max-age=31536000, immutable');
    return reply.send(sprite.bytes);
  });

  app.put<{ Params: { id: string }; Body: { petId?: unknown } }>(
    '/agents/:id/pet',
    async (request, reply) => {
      const store = app.ctx.petStore;
      if (!store) return reply.status(503).send({ error: 'pet store unavailable' });
      const agentId = request.params.id;
      const petId = request.body?.petId;
      if (petId !== null && typeof petId !== 'string') {
        return reply.status(400).send({ error: 'petId must be a string or null' });
      }
      if (typeof petId === 'string' && !(await store.getMeta(petId))) {
        return reply.status(404).send({ error: 'pet not found' });
      }
      return withConfigLock(async () => {
        if (app.ctx.agentManager.isDeletionInFlight(agentId)) {
          return reply.status(409).send({ error: `Agent "${agentId}" is being deleted; cannot set pet.` });
        }
        if (!app.ctx.agentManager.getAgentConfig(agentId)) {
          return reply.status(404).send({ error: 'Agent not found' });
        }
        await store.setAssignment(agentId, petId);
        return reply.status(200).send({ petId: petId ?? null });
      });
    },
  );
}
