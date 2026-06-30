import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReviewRound, TaskPhase } from '../shared/index.js';

const ROUND_FILE_RE = /^round-(\d+)\.json$/;
const PHASES: readonly TaskPhase[] = ['spec', 'code'];

export class ReviewStore {
  private readonly memory = new Map<string, ReviewRound>();

  constructor(private readonly dir?: string) {}

  async getRound(taskId: string, phase: TaskPhase, round: number): Promise<ReviewRound | null> {
    if (!this.dir) return this.memory.get(this.key(taskId, phase, round)) ?? null;
    let content: string;
    try {
      content = await readFile(this.path(taskId, phase, round), 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return null;
      throw err;
    }
    return JSON.parse(content) as ReviewRound;
  }

  async putRound(taskId: string, phase: TaskPhase, data: ReviewRound): Promise<void> {
    if (!this.dir) {
      this.memory.set(this.key(taskId, phase, data.round), data);
      return;
    }
    const phaseDir = join(this.dir, encodeURIComponent(taskId), phase);
    await mkdir(phaseDir, { recursive: true });
    const final = join(phaseDir, `round-${data.round}.json`);
    const tmp = `${final}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
    await rename(tmp, final);
  }

  async listRounds(taskId: string, phase?: TaskPhase): Promise<ReviewRound[]> {
    const phases = phase ? [phase] : PHASES;
    const out: ReviewRound[] = [];
    for (const p of phases) {
      if (!this.dir) {
        const prefix = `${taskId}::${p}::`;
        const rounds = [...this.memory.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(([, v]) => v)
          .sort((a, b) => a.round - b.round);
        out.push(...rounds);
        continue;
      }
      let files: string[];
      try {
        files = await readdir(join(this.dir, encodeURIComponent(taskId), p));
      } catch (err) {
        if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') continue;
        throw err;
      }
      const rounds = files
        .map(f => ROUND_FILE_RE.exec(f)?.[1])
        .filter((n): n is string => n !== undefined)
        .map(n => Number.parseInt(n, 10))
        .sort((a, b) => a - b);
      for (const r of rounds) {
        const data = await this.getRound(taskId, p, r);
        if (data) out.push(data);
      }
    }
    return out;
  }

  async clear(taskId: string): Promise<void> {
    if (!this.dir) {
      for (const k of [...this.memory.keys()]) {
        if (k.startsWith(`${taskId}::`)) this.memory.delete(k);
      }
      return;
    }
    await rm(join(this.dir, encodeURIComponent(taskId)), { recursive: true, force: true });
  }

  private key(taskId: string, phase: TaskPhase, round: number): string {
    return `${taskId}::${phase}::${round}`;
  }

  private path(taskId: string, phase: TaskPhase, round: number): string {
    return join(this.dir!, encodeURIComponent(taskId), phase, `round-${round}.json`);
  }
}
