import { appendFile, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentErrorSummary } from '../shared/index.js';

export interface ErrorRecordInput {
  agentId: string;
  projectId: string;
  taskId?: string;
  operation: string;
  reason: string;
  message: string;
  occurredAt?: string;
  observation?: Record<string, unknown>;
  recommendation?: string;
}

export interface ErrorRecord extends Required<Omit<ErrorRecordInput, 'taskId' | 'observation' | 'recommendation'>> {
  id: string;
  taskId?: string;
  observation?: Record<string, unknown>;
  recommendation?: string;
}

export class ErrorRecordStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private dir: string) {}

  async append(input: ErrorRecordInput): Promise<ErrorRecord> {
    const write = this.chain.then(async () => {
      const occurredAt = input.occurredAt ?? new Date().toISOString();
      const record: ErrorRecord = {
        id: `err_${randomUUID()}`,
        agentId: input.agentId,
        projectId: input.projectId,
        operation: input.operation,
        reason: input.reason,
        message: input.message,
        occurredAt,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        ...(input.observation ? { observation: input.observation } : {}),
        ...(input.recommendation ? { recommendation: input.recommendation } : {}),
      };
      await appendFile(join(this.dir, `${occurredAt.slice(0, 10)}.jsonl`), JSON.stringify(record) + '\n');
      return record;
    });
    this.chain = write.catch(() => undefined);
    return write;
  }

  async latestForAgent(agentId: string): Promise<ErrorRecord | undefined> {
    const records = await this.readAll();
    return records
      .filter(record => record.agentId === agentId)
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))[0];
  }

  async latestBootstrapForAgent(agentId: string): Promise<ErrorRecord | undefined> {
    const records = await this.readAll();
    return records
      .filter(record => record.agentId === agentId && record.operation === 'bootstrap')
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))[0];
  }

  // Batched variant for buildAllAgentSnapshots — one readAll() per snapshot pass instead of
  // N (agent count) × full-history scan. Returns the most recent bootstrap record per agentId.
  async latestBootstrapByAgent(): Promise<Map<string, ErrorRecord>> {
    const records = await this.readAll();
    const latest = new Map<string, ErrorRecord>();
    for (const record of records) {
      if (record.operation !== 'bootstrap') continue;
      const prev = latest.get(record.agentId);
      if (!prev || record.occurredAt > prev.occurredAt) {
        latest.set(record.agentId, record);
      }
    }
    return latest;
  }

  // Drops every record for an agentId by rewriting each affected jsonl. Called from
  // agent-delete so an id reused later (delete + recreate) doesn't inherit stale bootstrap
  // errors from the previous incarnation. Best-effort; partial failures are logged not thrown.
  async purgeAgent(agentId: string): Promise<{ removed: number }> {
    const idMarker = `"agentId":${JSON.stringify(agentId)}`;
    return this.rewriteFiltered({
      mayMatch: content => content.includes(idMarker),
      shouldDrop: record => record.agentId === agentId,
    });
  }

  // Narrower variant: drops only bootstrap-operation records for one agent, called from
  // runSingleTarget's success path on EVERY tick. Hot path — quickCheck must be cheap and
  // truly short-circuit (read alone, no parse, no rewrite) in the common no-stale case.
  async purgeBootstrapForAgent(agentId: string): Promise<{ removed: number }> {
    const idMarker = `"agentId":${JSON.stringify(agentId)}`;
    const opMarker = '"operation":"bootstrap"';
    return this.rewriteFiltered({
      mayMatch: content => content.includes(idMarker) && content.includes(opMarker),
      shouldDrop: record => record.agentId === agentId && record.operation === 'bootstrap',
    });
  }

  // One-shot sweep on startup / config-replace: drop bootstrap-operation records for every
  // agent NOT currently in the auto-bootstrap set. Covers:
  //   (a) agent transitioned from auto-mode to explicit workdir (id stays, leaves bootstrap)
  //   (b) agent deleted while server was down
  //   (c) PATCH /config saved then restartRequired — old poller appended a fresh stale record
  //       in the window before restart; sweep on next startup clears it
  // Done in a single rewriteFiltered pass — one full-history scan per startup rather than
  // N (stale agents) × full scans.
  async sweepStaleBootstrapErrors(activeAgentIds: Set<string>): Promise<{ removed: number }> {
    return this.rewriteFiltered({
      mayMatch: content => content.includes('"operation":"bootstrap"'),
      shouldDrop: record =>
        record.operation === 'bootstrap' && !activeAgentIds.has(record.agentId),
    });
  }

  // Shared rewrite-with-filter helper. shouldDrop returns true for records to remove.
  // Uses tmp file + atomic rename per jsonl to survive crash/disk-full mid-rewrite
  // (in-place writeFile would otherwise truncate the file and lose unrelated history).
  // mayMatch lets callers short-circuit per file BEFORE the parse loop — without it, every
  // call still parses the whole history even when nothing matches, defeating the rewrite skip.
  private rewriteFiltered(opts: {
    mayMatch: (content: string) => boolean;
    shouldDrop: (record: ErrorRecord) => boolean;
  }): Promise<{ removed: number }> {
    const result = this.chain.then(async () => {
      let files: string[];
      try {
        files = await readdir(this.dir);
      } catch {
        return { removed: 0 };
      }
      let removed = 0;
      for (const file of files.filter(f => f.endsWith('.jsonl'))) {
        const path = join(this.dir, file);
        let content: string;
        try {
          content = await readFile(path, 'utf-8');
        } catch (err) {
          console.warn(`[ErrorRecordStore] rewriteFiltered: skipping unreadable ${file}:`, err);
          continue;
        }
        if (!opts.mayMatch(content)) continue;
        const lines = content.split('\n');
        const kept: string[] = [];
        let fileRemoved = 0;
        for (const line of lines) {
          if (!line) continue;
          let record: ErrorRecord;
          try {
            record = JSON.parse(line) as ErrorRecord;
          } catch {
            kept.push(line);
            continue;
          }
          if (opts.shouldDrop(record)) {
            fileRemoved++;
            continue;
          }
          kept.push(line);
        }
        if (fileRemoved === 0) continue;
        const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
        try {
          await writeFile(tmp, kept.length > 0 ? kept.join('\n') + '\n' : '');
          await rename(tmp, path);
          // Only count records as removed after the atomic rename succeeds. If writeFile or
          // rename fails the original file is untouched, and callers (bootstrap.ts uses
          // removed > 0 as a state-change signal) must not be misled into publishing a
          // "stale error cleared" event for a purge that didn't actually happen.
          removed += fileRemoved;
        } catch (err) {
          console.warn(`[ErrorRecordStore] rewriteFiltered: atomic rewrite failed for ${file}:`, err);
          // Best-effort tmp cleanup so a partial write doesn't accumulate orphan .tmp files.
          try { await unlink(tmp); } catch { /* ignore — tmp may not exist if writeFile failed early */ }
        }
      }
      return { removed };
    });
    this.chain = result.catch(() => undefined);
    return result;
  }

  toSummary(record: ErrorRecord): AgentErrorSummary {
    return {
      id: record.id,
      reason: record.reason,
      message: record.message,
      occurredAt: record.occurredAt,
      ...(record.recommendation ? { recommendation: record.recommendation } : {}),
    };
  }

  private async readAll(): Promise<ErrorRecord[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return [];
    }
    const records: ErrorRecord[] = [];
    for (const file of files.filter(f => f.endsWith('.jsonl')).sort()) {
      try {
        const content = await readFile(join(this.dir, file), 'utf-8');
        for (const line of content.trim().split('\n').filter(Boolean)) {
          try {
            records.push(JSON.parse(line) as ErrorRecord);
          } catch (err) {
            console.warn(`[ErrorRecordStore] skipping unreadable line in ${file}:`, err);
          }
        }
      } catch (err) {
        console.warn(`[ErrorRecordStore] skipping unreadable file ${file}:`, err);
      }
    }
    return records;
  }
}
