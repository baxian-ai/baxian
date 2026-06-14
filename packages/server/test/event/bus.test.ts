import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../../src/event/bus.js';
import { EventLog } from '../../src/event/log.js';
import { initStateDir } from '../../src/state/init.js';
import type { BaxianEvent } from '../../src/shared/index.js';

let tempDir: string;
let log: EventLog;
let bus: EventBus;

function makeEvent(overrides: Partial<BaxianEvent> = {}): BaxianEvent {
  return {
    id: 'evt-test',
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
  bus = new EventBus(log);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true });
});

describe('EventBus', () => {
  it('calls handler for matching event type', async () => {
    const handler = vi.fn();
    bus.on('task.created', handler);
    const event = makeEvent();
    await bus.emit(event);
    expect(handler).toHaveBeenCalledWith(event);
  });

  it('does not call handler for non-matching type', async () => {
    const handler = vi.fn();
    bus.on('pr.created', handler);
    await bus.emit(makeEvent({ type: 'task.created' }));
    expect(handler).not.toHaveBeenCalled();
  });

  it('wildcard handler receives all events', async () => {
    const handler = vi.fn();
    bus.on('*', handler);
    await bus.emit(makeEvent({ type: 'task.created' }));
    await bus.emit(makeEvent({ type: 'pr.created' }));
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('persists events to log', async () => {
    await bus.emit(makeEvent());
    const events = await log.readDate('2026-04-28');
    expect(events).toHaveLength(1);
  });

  it('supports multiple handlers for same type', async () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.on('task.created', h1);
    bus.on('task.created', h2);
    await bus.emit(makeEvent());
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes handler', async () => {
    const handler = vi.fn();
    bus.on('task.created', handler);
    bus.off('task.created', handler);
    await bus.emit(makeEvent());
    expect(handler).not.toHaveBeenCalled();
  });

  it('unsubscribes wildcard handler', async () => {
    const handler = vi.fn();
    bus.on('*', handler);
    bus.off('*', handler);
    await bus.emit(makeEvent());
    expect(handler).not.toHaveBeenCalled();
  });

  it('generates event IDs when not provided', async () => {
    const event = makeEvent({ id: '' });
    await bus.emit(event);
    const events = await log.readDate('2026-04-28');
    expect(events[0].id).toMatch(/^evt-/);
  });
});
