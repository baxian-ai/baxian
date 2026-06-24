import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AgentSnapshot, PetMeta } from '../../src/shared/index.js';
import { PET_ATLAS_HEIGHT, PET_ATLAS_WIDTH } from '../../src/shared/index.js';
import { requesters, setupApiHarness, teardownApiHarness, expectStatus, type ApiHarness } from './helpers.js';

function makePng(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].forEach((v, i) => (b[i] = v));
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

const validSprite = (): string => makePng(PET_ATLAS_WIDTH, PET_ATLAS_HEIGHT).toString('base64');

let harness: ApiHarness;
let app: FastifyInstance;
const { get, post, put, del } = requesters(() => app);

async function createPet(displayName = 'Foxy'): Promise<PetMeta> {
  const res = await post('/api/pets', { petJson: { displayName, description: 'a fox' }, spritesheetBase64: validSprite() });
  expect(res.statusCode).toBe(201);
  return JSON.parse(res.body) as PetMeta;
}

beforeEach(async () => {
  harness = await setupApiHarness('pets');
  app = harness.app;
});

afterEach(() => teardownApiHarness(harness));

describe('POST /api/pets', () => {
  it('creates a pet from a valid manifest + spritesheet', async () => {
    const meta = await createPet('Foxy');
    expect(meta).toMatchObject({ displayName: 'Foxy', description: 'a fox', ext: 'png' });
    expect(meta.id).toBeTruthy();
    const list = JSON.parse((await get('/api/pets')).body) as PetMeta[];
    expect(list.map((p) => p.id)).toContain(meta.id);
  });

  it('rejects a bad manifest (400)', async () => {
    const res = await post('/api/pets', { petJson: { description: 'no name' }, spritesheetBase64: validSprite() });
    expectStatus(res, 400, /displayName is required/);
  });

  it('rejects a wrong-size spritesheet (400)', async () => {
    const res = await post('/api/pets', { petJson: { displayName: 'X' }, spritesheetBase64: makePng(100, 100).toString('base64') });
    expectStatus(res, 400, /1536×1872/);
  });

  it('rejects a missing spritesheet (400)', async () => {
    const res = await post('/api/pets', { petJson: { displayName: 'X' } });
    expectStatus(res, 400, /spritesheetBase64 is required/);
  });
});

describe('GET /api/pets/:id/spritesheet', () => {
  it('streams the bytes with the right content-type', async () => {
    const meta = await createPet();
    const res = await get(`/api/pets/${meta.id}/spritesheet`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.rawPayload.length).toBe(33);
  });

  it('404s for an unknown pet', async () => {
    expectStatus(await get('/api/pets/nope/spritesheet'), 404);
  });

  it('marks the response private (bearer-auth asset must not be shared-cacheable)', async () => {
    const meta = await createPet();
    const res = await get(`/api/pets/${meta.id}/spritesheet`);
    expect(res.headers['cache-control']).toContain('private');
    expect(res.headers['cache-control']).not.toContain('public');
  });
});

describe('DELETE /api/pets/:id', () => {
  it('deletes a pet and 404s afterwards', async () => {
    const meta = await createPet();
    expect((await del(`/api/pets/${meta.id}`)).statusCode).toBe(204);
    expectStatus(await del(`/api/pets/${meta.id}`), 404);
  });
});

describe('PUT /api/agents/:id/pet', () => {
  it('assigns a pet and the agent snapshot then carries petId', async () => {
    const meta = await createPet();
    const res = await put(`/api/agents/dev-1/pet`, { petId: meta.id });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ petId: meta.id });

    const agents = JSON.parse((await get('/api/agents')).body) as AgentSnapshot[];
    expect(agents.find((a) => a.id === 'dev-1')?.petId).toBe(meta.id);
  });

  it('clears the assignment with null', async () => {
    const meta = await createPet();
    await put(`/api/agents/dev-1/pet`, { petId: meta.id });
    expect((await put(`/api/agents/dev-1/pet`, { petId: null })).statusCode).toBe(200);
    const agents = JSON.parse((await get('/api/agents')).body) as AgentSnapshot[];
    expect(agents.find((a) => a.id === 'dev-1')?.petId).toBeUndefined();
  });

  it('deleting an assigned pet cascades petId off the snapshot', async () => {
    const meta = await createPet();
    await put(`/api/agents/dev-1/pet`, { petId: meta.id });
    await del(`/api/pets/${meta.id}`);
    const agents = JSON.parse((await get('/api/agents')).body) as AgentSnapshot[];
    expect(agents.find((a) => a.id === 'dev-1')?.petId).toBeUndefined();
  });

  it('404s for an unknown agent', async () => {
    const meta = await createPet();
    expectStatus(await put(`/api/agents/ghost/pet`, { petId: meta.id }), 404, /Agent not found/);
  });

  it('404s for an unknown pet', async () => {
    expectStatus(await put(`/api/agents/dev-1/pet`, { petId: 'ghost' }), 404, /pet not found/);
  });

  it('400s when petId is neither string nor null', async () => {
    expectStatus(await put(`/api/agents/dev-1/pet`, { petId: 42 }), 400, /must be a string or null/);
  });

  it('409s when the agent is being deleted (no stale assignment written)', async () => {
    const meta = await createPet();
    vi.spyOn(app.ctx.agentManager, 'isDeletionInFlight').mockReturnValue(true);
    expectStatus(await put(`/api/agents/dev-1/pet`, { petId: meta.id }), 409, /being deleted/);
    expect(await app.ctx.petStore!.getAssignment('dev-1')).toBeNull();
  });
});

describe('GET /api/agents resilience', () => {
  it('still returns 200 (pets degraded) when assignments.json is corrupt', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const petsDir = join(harness.tempDir, 'state', 'pets');
    await mkdir(petsDir, { recursive: true });
    await writeFile(join(petsDir, 'assignments.json'), 'not json at all');

    const res = await get('/api/agents');
    expect(res.statusCode).toBe(200);
    const agents = JSON.parse(res.body) as AgentSnapshot[];
    expect(agents.every((a) => a.petId === undefined)).toBe(true);
    warn.mockRestore();
  });
});
