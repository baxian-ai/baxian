import { readFile, writeFile, readdir, unlink, rename } from 'node:fs/promises';
import { assertInsideManagedDir } from './managed-path.js';
import { join } from 'node:path';
import type { AgentBindingFacts, NeedInputWatermark } from '../shared/index.js';

export type AgentStoreChangeKind = 'set' | 'delete';
export type AgentStoreListener = (kind: AgentStoreChangeKind, agentId: string) => void;

export const AGENT_STORE_NOOP = Symbol.for('@baxian/agent-store-noop');
export type AgentStoreUpdateResult = AgentBindingFacts | null | typeof AGENT_STORE_NOOP;
export type AgentStoreCommit = 'committed' | 'noop' | 'deleted';

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

let tmpCounter = 0;

export class AgentStore {
  private listeners = new Set<AgentStoreListener>();
  private mutex = new Map<string, Promise<unknown>>();

  constructor(private dir: string) {}

  onChange(fn: AgentStoreListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async get(id: string): Promise<AgentBindingFacts | null> {
    if (!SAFE_ID.test(id)) return null;
    let content: string;
    try {
      content = await readFile(this.path(id), 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return null;
      throw err;
    }
    return normalizeBinding(JSON.parse(content) as Record<string, unknown>, id);
  }

  private async runExclusive<T>(id: string, body: () => Promise<T>): Promise<T> {
    const prev = this.mutex.get(id) ?? Promise.resolve();
    const task = prev.then(body, body);
    const chain: Promise<unknown> = task.then(() => undefined, () => undefined).finally(() => {
      if (this.mutex.get(id) === chain) this.mutex.delete(id);
    });
    this.mutex.set(id, chain);
    return task;
  }

  async set(state: AgentBindingFacts): Promise<void> {
    await this.runExclusive(state.id, () => this.setLocked(state));
  }

  private async setLocked(state: AgentBindingFacts): Promise<void> {
    const binding = normalizeBinding(state as unknown as Record<string, unknown>, state.id);
    const final = this.path(state.id);
    const tmp = `${final}.${process.pid}.${tmpCounter++}.tmp`;
    await writeFile(tmp, JSON.stringify(binding, null, 2) + '\n');
    await rename(tmp, final);
    this.fire('set', state.id);
  }

  async update(
    id: string,
    updater: (existing: AgentBindingFacts | null) => AgentStoreUpdateResult,
  ): Promise<AgentStoreCommit> {
    return this.runExclusive(id, async () => {
      const existing = await this.get(id);
      const result = updater(existing);
      if (result === AGENT_STORE_NOOP) return 'noop';
      if (result === null) {
        await this.deleteLocked(id);
        return 'deleted';
      }
      await this.setLocked(result);
      return 'committed';
    });
  }

  async list(): Promise<AgentBindingFacts[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return [];
    }
    const states: AgentBindingFacts[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const content = await readFile(join(this.dir, file), 'utf-8');
        states.push(normalizeBinding(JSON.parse(content) as Record<string, unknown>, file.replace(/\.json$/, '')));
      } catch (err) {
        console.warn(`[AgentStore] skipping unreadable file ${file}:`, err);
      }
    }
    return states;
  }

  async delete(id: string): Promise<void> {
    await this.runExclusive(id, () => this.deleteLocked(id));
  }

  private async deleteLocked(id: string): Promise<void> {
    if (!SAFE_ID.test(id)) return;
    try {
      await unlink(assertInsideManagedDir(this.dir, this.path(id)));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'ENOENT') {
        throw new Error(`[AgentStore] delete ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.fire('delete', id);
  }

  private path(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private fire(kind: AgentStoreChangeKind, id: string): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(kind, id);
      } catch (err) {
        console.error(`[AgentStore] listener threw on ${kind} ${id}:`, err);
      }
    }
  }
}

function normalizeBinding(raw: Record<string, unknown>, fallbackId: string): AgentBindingFacts {
  const id = typeof raw.id === 'string' ? raw.id : fallbackId;
  const projectId = typeof raw.projectId === 'string' ? raw.projectId : '';
  const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date(0).toISOString();
  const binding: AgentBindingFacts = { id, projectId, updatedAt };
  if (typeof raw.taskId === 'string') binding.taskId = raw.taskId;
  if (typeof raw.lockToken === 'string') binding.lockToken = raw.lockToken;
  if (typeof raw.workdir === 'string') binding.workdir = raw.workdir;
  if (typeof raw.startedAt === 'string') binding.startedAt = raw.startedAt;
  if (typeof raw.bootstrappingTaskId === 'string') binding.bootstrappingTaskId = raw.bootstrappingTaskId;
  if (typeof raw.paneId === 'string') binding.paneId = raw.paneId;
  if (typeof raw.creationToken === 'string') binding.creationToken = raw.creationToken;
  if (raw.status === 'awaiting_human') binding.status = 'awaiting_human';
  if (typeof raw.awaitingPhase === 'string') binding.awaitingPhase = raw.awaitingPhase;
  if (typeof raw.awaitingReason === 'string') binding.awaitingReason = raw.awaitingReason;
  if (typeof raw.awaitingSince === 'string') binding.awaitingSince = raw.awaitingSince;
  if (typeof raw.awaitingNonce === 'string') binding.awaitingNonce = raw.awaitingNonce;
  const needInput = normalizeNeedInput(raw);
  if (needInput) binding.needInput = needInput;
  return binding;
}

function normalizeNeedInput(raw: Record<string, unknown>): NeedInputWatermark | undefined {
  const nested = raw.needInput;
  if (nested && typeof nested === 'object') {
    const o = nested as Record<string, unknown>;
    if (typeof o.epoch === 'number' && Number.isInteger(o.epoch) && o.epoch >= 0) {
      const w: NeedInputWatermark = { epoch: o.epoch };
      if (typeof o.askSeq === 'number' && Number.isInteger(o.askSeq) && o.askSeq >= 0) w.askSeq = o.askSeq;
      if (typeof o.answeredSeq === 'number' && Number.isInteger(o.answeredSeq) && o.answeredSeq >= 0) {
        w.answeredSeq = o.answeredSeq;
      }
      if (typeof o.at === 'string') w.at = o.at;
      return w;
    }
  }
  if (typeof raw.needInputAt === 'string') {
    return { epoch: 0, askSeq: 1, answeredSeq: 0, at: raw.needInputAt };
  }
  return undefined;
}
