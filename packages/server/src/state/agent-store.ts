import { readFile, writeFile, readdir, unlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentBindingFacts } from '../shared/index.js';

export type AgentStoreChangeKind = 'set' | 'delete';
export type AgentStoreListener = (kind: AgentStoreChangeKind, agentId: string) => void;

export const AGENT_STORE_NOOP = Symbol.for('@baxian/agent-store-noop');
export type AgentStoreUpdateResult = AgentBindingFacts | null | typeof AGENT_STORE_NOOP;

// a store id becomes a filename; constrain it so a path-like id can't escape the store dir
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

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

  async set(state: AgentBindingFacts): Promise<void> {
    const binding = normalizeBinding(state as unknown as Record<string, unknown>, state.id);
    const final = this.path(state.id);
    const tmp = `${final}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(binding, null, 2) + '\n');
    await rename(tmp, final);
    this.fire('set', state.id);
  }

  async update(
    id: string,
    updater: (existing: AgentBindingFacts | null) => AgentStoreUpdateResult,
  ): Promise<void> {
    const prev = this.mutex.get(id) ?? Promise.resolve();
    const task = prev.then(async () => {
      const existing = await this.get(id);
      const result = updater(existing);
      if (result === AGENT_STORE_NOOP) return;
      if (result === null) {
        await this.delete(id);
        return;
      }
      await this.set(result);
    });
    const chain: Promise<unknown> = task.catch(() => undefined).finally(() => {
      if (this.mutex.get(id) === chain) this.mutex.delete(id);
    });
    this.mutex.set(id, chain);
    return task;
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
    if (!SAFE_ID.test(id)) return;
    try {
      await unlink(this.path(id));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'ENOENT') {
        console.error(`[AgentStore] delete ${id} failed; not broadcasting:`, err);
        return;
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
  if (typeof raw.needInputAt === 'string') binding.needInputAt = raw.needInputAt;
  return binding;
}
