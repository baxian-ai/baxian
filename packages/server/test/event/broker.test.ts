import { describe, it, expect, vi } from 'vitest';
import { EventBroker } from '../../src/event/broker.js';

describe('EventBroker', () => {
  it('publish fans out to all subscribers of a topic', () => {
    const b = new EventBroker();
    const a = vi.fn();
    const c = vi.fn();
    b.subscribe('agents', a);
    b.subscribe('agents', c);
    b.publish('agents', [{ id: 'dev-1' }]);
    expect(a).toHaveBeenCalledWith([{ id: 'dev-1' }]);
    expect(c).toHaveBeenCalledWith([{ id: 'dev-1' }]);
  });

  it('publish on a topic with no subscribers is a no-op (no throw)', () => {
    const b = new EventBroker();
    expect(() => b.publish('agent:nope', { id: 'nope' })).not.toThrow();
  });

  it('unsubscribe removes only the specific handler', () => {
    const b = new EventBroker();
    const a = vi.fn();
    const c = vi.fn();
    const unsubA = b.subscribe('agents', a);
    b.subscribe('agents', c);
    unsubA();
    b.publish('agents', []);
    expect(a).not.toHaveBeenCalled();
    expect(c).toHaveBeenCalled();
  });

  it('unsubscribe last subscriber drops the topic from hasSubscribers', () => {
    const b = new EventBroker();
    const unsub = b.subscribe('task:t1', () => undefined);
    expect(b.hasSubscribers('task:t1')).toBe(true);
    unsub();
    expect(b.hasSubscribers('task:t1')).toBe(false);
  });

  it('publish iterates a snapshot — handlers can unsubscribe mid-dispatch without skipping siblings', () => {
    const b = new EventBroker();
    const order: string[] = [];
    const unsubA = b.subscribe('agents', () => {
      order.push('a');
      unsubA();
    });
    b.subscribe('agents', () => {
      order.push('c');
    });
    b.publish('agents', []);
    expect(order).toEqual(['a', 'c']);
  });

  it('a throwing subscriber does not block sibling subscribers', () => {
    const b = new EventBroker();
    const c = vi.fn();
    b.subscribe('agents', () => {
      throw new Error('boom');
    });
    b.subscribe('agents', c);
    expect(() => b.publish('agents', [])).not.toThrow();
    expect(c).toHaveBeenCalled();
  });
});
