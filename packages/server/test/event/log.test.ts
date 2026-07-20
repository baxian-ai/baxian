import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventLog } from '../../src/event/log.js';
import { initStateDir } from '../../src/state/init.js';
import type { BaxianEvent } from '../../src/shared/index.js';

let tempDir: string;
let log: EventLog;

function makeEvent(overrides: Partial<BaxianEvent> = {}): BaxianEvent {
  return {
    id: 'evt-test-001',
    type: 'task.created',
    timestamp: '2026-04-28T10:00:00Z',
    projectId: 'proj',
    data: {},
    ...overrides,
  };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-test-'));
  await initStateDir(tempDir);
  log = new EventLog(join(tempDir, 'events'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true });
});

describe('EventLog', () => {
  it('appends and reads events', async () => {
    const event = makeEvent();
    await log.append(event);
    const events = await log.readDate('2026-04-28');
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(event);
  });

  it('appends multiple events to same date', async () => {
    await log.append(makeEvent({ id: 'evt-1', timestamp: '2026-04-28T10:00:00Z' }));
    await log.append(makeEvent({ id: 'evt-2', timestamp: '2026-04-28T11:00:00Z' }));
    const events = await log.readDate('2026-04-28');
    expect(events).toHaveLength(2);
  });

  it('separates events by date', async () => {
    await log.append(makeEvent({ id: 'evt-1', timestamp: '2026-04-28T10:00:00Z' }));
    await log.append(makeEvent({ id: 'evt-2', timestamp: '2026-04-29T10:00:00Z' }));
    expect(await log.readDate('2026-04-28')).toHaveLength(1);
    expect(await log.readDate('2026-04-29')).toHaveLength(1);
  });

  it('returns empty array for date with no events', async () => {
    expect(await log.readDate('2026-01-01')).toEqual([]);
  });

  it('reads events across date range', async () => {
    await log.append(makeEvent({ id: 'evt-1', timestamp: '2026-04-27T10:00:00Z' }));
    await log.append(makeEvent({ id: 'evt-2', timestamp: '2026-04-28T10:00:00Z' }));
    await log.append(makeEvent({ id: 'evt-3', timestamp: '2026-04-29T10:00:00Z' }));
    const events = await log.readRange('2026-04-27', '2026-04-29');
    expect(events).toHaveLength(3);
    expect(events.map(e => e.id)).toEqual(['evt-1', 'evt-2', 'evt-3']);
  });

  it('keeps distinct events that collide on a random id, collapsing only the outbox namespace', async () => {
    await log.append(makeEvent({ id: 'evt-collide', timestamp: '2026-04-28T10:00:00Z', type: 'pr.created' }));
    await log.append(makeEvent({ id: 'evt-collide', timestamp: '2026-04-28T10:00:00Z', type: 'pr.merged' }));
    const day = await log.readDate('2026-04-28');
    expect(day).toHaveLength(2);
    expect(day.map(e => e.type)).toEqual(['pr.created', 'pr.merged']);
  });

  it('collapses redelivered rows sharing one deterministic id on the read path', async () => {
    await log.append(makeEvent({ id: 'outbox:t1:42:mr-closed-unmerged:1', timestamp: '2026-04-28T10:00:00Z' }));
    await log.append(makeEvent({ id: 'evt-plain', timestamp: '2026-04-28T10:01:00Z' }));
    await log.append(makeEvent({ id: 'outbox:t1:42:mr-closed-unmerged:1', timestamp: '2026-04-28T10:02:00Z' }));
    await log.append(makeEvent({ id: 'outbox:t1:42:mr-closed-unmerged:1', timestamp: '2026-04-29T00:00:01Z' }));

    const day = await log.readDate('2026-04-28');
    expect(day.map(e => e.id)).toEqual(['outbox:t1:42:mr-closed-unmerged:1', 'evt-plain']);

    const range = await log.readRange('2026-04-28', '2026-04-29');
    expect(range.filter(e => e.id === 'outbox:t1:42:mr-closed-unmerged:1')).toHaveLength(1);
    expect(range).toHaveLength(2);
  });
});
