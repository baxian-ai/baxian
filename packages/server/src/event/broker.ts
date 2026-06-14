import type { EventsTopic } from '../shared/index.js';

type Subscriber = (data: unknown) => void;

// Non-durable hot-path pub/sub — see EventBus for the persisted audit log.
export class EventBroker {
  private topics = new Map<EventsTopic, Set<Subscriber>>();

  subscribe(topic: EventsTopic, fn: Subscriber): () => void {
    let set = this.topics.get(topic);
    if (!set) {
      set = new Set();
      this.topics.set(topic, set);
    }
    set.add(fn);
    return () => {
      const s = this.topics.get(topic);
      if (!s) return;
      s.delete(fn);
      if (s.size === 0) this.topics.delete(topic);
    };
  }

  publish(topic: EventsTopic, data: unknown): void {
    const set = this.topics.get(topic);
    if (!set) return;
    // Snapshot — subscribers may unsubscribe mid-dispatch.
    for (const fn of [...set]) {
      try {
        fn(data);
      } catch (err) {
        console.error(`[EventBroker] subscriber threw on topic ${topic}:`, err);
      }
    }
  }

  hasSubscribers(topic: EventsTopic): boolean {
    const set = this.topics.get(topic);
    return set !== undefined && set.size > 0;
  }

  subscribedTopicsByPrefix(prefix: string): EventsTopic[] {
    const out: EventsTopic[] = [];
    for (const topic of this.topics.keys()) {
      if (topic.startsWith(prefix)) out.push(topic);
    }
    return out;
  }
}
