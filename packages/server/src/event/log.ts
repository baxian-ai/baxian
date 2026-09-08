import { appendFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { BaxianEvent } from '../shared/index.js';
import { EVENT_TYPES, isRecord, mapWithConcurrency, FS_READ_CONCURRENCY } from '../shared/index.js';

const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set(EVENT_TYPES);

export interface EventLogReadResult {
  events: BaxianEvent[];
  complete: boolean;
}

export class EventLog {
  constructor(private dir: string) {}

  async append(event: BaxianEvent): Promise<void> {
    const date = event.timestamp.slice(0, 10);
    const file = join(this.dir, `${date}.jsonl`);
    // A crash may have left an unterminated record at the end of the file.
    await appendFile(file, '\n' + JSON.stringify(event) + '\n');
  }

  async readDate(date: string): Promise<BaxianEvent[]> {
    try {
      return (await this.readDateWithStatus(date)).events;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
      throw err;
    }
  }

  async readRange(from: string, to: string): Promise<BaxianEvent[]> {
    return (await this.readRangeWithStatus(from, to)).events;
  }

  async readRangeWithStatus(from: string, to: string): Promise<EventLogReadResult> {
    const files = await readdir(this.dir);
    const matching = files
      .filter(f => f.endsWith('.jsonl'))
      .map(f => f.replace('.jsonl', ''))
      .filter(date => date >= from && date <= to)
      .sort();
    const perDate = await mapWithConcurrency(matching, FS_READ_CONCURRENCY, date => this.readDateWithStatus(date));
    return {
      events: dedupeById(perDate.flatMap(result => result.events)),
      complete: perDate.every(result => result.complete),
    };
  }

  private async readDateWithStatus(date: string): Promise<EventLogReadResult> {
    const file = join(this.dir, `${date}.jsonl`);
    const content = await readFile(file, 'utf-8');
    const events: BaxianEvent[] = [];
    let complete = true;
    for (const [index, line] of content.split('\n').entries()) {
      if (!line.trim()) continue;
      try {
        const event: unknown = JSON.parse(line);
        if (!isEvent(event)) throw new Error('invalid event');
        events.push(event);
        if (!KNOWN_EVENT_TYPES.has(event.type)) {
          complete = false;
          console.warn(`[EventLog] unknown event type at ${file}:${index + 1}`);
        }
      } catch {
        complete = false;
        console.warn(`[EventLog] skipping invalid event at ${file}:${index + 1}`);
      }
    }
    return { events: dedupeById(events), complete };
  }
}

function isEvent(value: unknown): value is BaxianEvent {
  return isRecord(value)
    && typeof value.id === 'string' && value.id.length > 0
    && typeof value.type === 'string' && value.type.length > 0
    && typeof value.timestamp === 'string' && Number.isFinite(Date.parse(value.timestamp))
    && typeof value.projectId === 'string'
    && (value.agentId === undefined || typeof value.agentId === 'string')
    && (value.taskId === undefined || typeof value.taskId === 'string')
    && isRecord(value.data);
}

function dedupeById(events: BaxianEvent[]): BaxianEvent[] {
  const seen = new Set<string>();
  const out: BaxianEvent[] = [];
  for (const event of events) {
    if (typeof event.id === 'string' && event.id.startsWith('outbox:')) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
    }
    out.push(event);
  }
  return out;
}
