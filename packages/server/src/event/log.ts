import { appendFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { BaxianEvent } from '../shared/index.js';

export class EventLog {
  constructor(private dir: string) {}

  async append(event: BaxianEvent): Promise<void> {
    const date = event.timestamp.slice(0, 10);
    const file = join(this.dir, `${date}.jsonl`);
    await appendFile(file, JSON.stringify(event) + '\n');
  }

  async readDate(date: string): Promise<BaxianEvent[]> {
    const file = join(this.dir, `${date}.jsonl`);
    try {
      const content = await readFile(file, 'utf-8');
      return content.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as BaxianEvent);
    } catch {
      return [];
    }
  }

  async readRange(from: string, to: string): Promise<BaxianEvent[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return [];
    }
    const matching = files
      .filter(f => f.endsWith('.jsonl'))
      .map(f => f.replace('.jsonl', ''))
      .filter(date => date >= from && date <= to)
      .sort();
    const events: BaxianEvent[] = [];
    for (const date of matching) {
      events.push(...(await this.readDate(date)));
    }
    return events;
  }
}
