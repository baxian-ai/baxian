import type { BaxianEvent, EventType } from '../shared/index.js';
import type { EventLog } from './log.js';

export type EventHandler = (event: BaxianEvent) => void | Promise<void>;

export class EventBus {
  private handlers = new Map<string, EventHandler[]>();

  constructor(private log: EventLog) {}

  on(type: EventType | '*', handler: EventHandler): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  off(type: EventType | '*', handler: EventHandler): void {
    const list = this.handlers.get(type);
    if (list) {
      this.handlers.set(type, list.filter(h => h !== handler));
    }
  }

  async emit(event: BaxianEvent): Promise<void> {
    if (!event.id) {
      event.id = generateEventId();
    }
    await this.log.append(event);
    const specific = this.handlers.get(event.type) ?? [];
    const wildcard = this.handlers.get('*') ?? [];
    for (const handler of [...specific, ...wildcard]) {
      await handler(event);
    }
  }

  // Persisted events for date range [from, to] (YYYY-MM-DD). The log lives in its own files, so it
  // survives an agent-store-specific write failure — recover() uses it as durable delivery proof.
  async readRange(from: string, to: string): Promise<BaxianEvent[]> {
    return this.log.readRange(from, to);
  }
}

function generateEventId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `evt-${ts}-${rand}`;
}
