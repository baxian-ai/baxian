import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  RESEARCH_DOCS_DIR,
  SPEC_DOC_RELPATH,
  isRecord,
  renderSpecDocuments,
  type ReviewPhase,
  type ReviewRound,
  type SpecDocument,
} from '../shared/index.js';

const ROUND_FILE_RE = /^round-(\d+)\.json$/;
const PHASES: readonly ReviewPhase[] = ['spec', 'code'];

function parseDocuments(value: unknown): SpecDocument[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('spec review round documents must be a non-empty array');
  }
  const documents = value.map((item, index) => {
    if (!isRecord(item) || typeof item.relPath !== 'string' || typeof item.content !== 'string') {
      throw new Error(`spec review round documents[${index}] is invalid`);
    }
    return { relPath: item.relPath, content: item.content };
  });
  if (documents[0]!.relPath !== SPEC_DOC_RELPATH) {
    throw new Error(`spec review round must start with ${SPEC_DOC_RELPATH}`);
  }
  const paths = documents.map(document => document.relPath);
  if (new Set(paths).size !== paths.length) throw new Error('spec review round document paths must be unique');
  const researchPrefix = `${RESEARCH_DOCS_DIR}/`;
  for (const path of paths.slice(1)) {
    const name = path.slice(researchPrefix.length);
    if (!path.startsWith(researchPrefix) || name === '' || name.includes('/') || !name.endsWith('.md')) {
      throw new Error(`invalid research document path: ${path}`);
    }
  }
  const sorted = [...paths.slice(1)].sort();
  if (paths.slice(1).some((path, index) => path !== sorted[index])) {
    throw new Error('research document paths must be sorted');
  }
  return documents;
}

function parseRound(value: unknown, phase: ReviewPhase, round: number): ReviewRound {
  if (!isRecord(value) || value.phase !== phase || value.round !== round) {
    throw new Error(`review round identity mismatch: expected ${phase}/${round}`);
  }
  if (typeof value.content !== 'string' || typeof value.startedAt !== 'string') {
    throw new Error(`review round ${phase}/${round} is missing required content or startedAt`);
  }
  if (phase === 'spec') {
    const documents = parseDocuments(value.documents);
    if (value.content !== renderSpecDocuments(documents)) {
      throw new Error(`spec review round ${round} content does not match documents`);
    }
    return { ...value, phase, round, documents } as unknown as ReviewRound;
  }
  if (value.documents !== undefined) throw new Error(`code review round ${round} must not contain documents`);
  return { ...value, phase, round } as unknown as ReviewRound;
}

export class ReviewStore {
  private readonly memory = new Map<string, ReviewRound>();

  constructor(private readonly dir?: string) {}

  async getRound(taskId: string, phase: ReviewPhase, round: number): Promise<ReviewRound | null> {
    if (!this.dir) {
      const value = this.memory.get(this.key(taskId, phase, round));
      return value ? parseRound(value, phase, round) : null;
    }
    let content: string;
    try {
      content = await readFile(this.path(taskId, phase, round), 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return null;
      throw err;
    }
    return parseRound(JSON.parse(content), phase, round);
  }

  async putRound(taskId: string, phase: ReviewPhase, data: ReviewRound): Promise<void> {
    const parsed = parseRound(data, phase, data.round);
    if (!this.dir) {
      this.memory.set(this.key(taskId, phase, parsed.round), parsed);
      return;
    }
    const phaseDir = join(this.dir, encodeURIComponent(taskId), phase);
    await mkdir(phaseDir, { recursive: true });
    const final = join(phaseDir, `round-${parsed.round}.json`);
    const tmp = `${final}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(parsed, null, 2) + '\n');
    await rename(tmp, final);
  }

  async listRounds(taskId: string, phase?: ReviewPhase): Promise<ReviewRound[]> {
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

  private key(taskId: string, phase: ReviewPhase, round: number): string {
    return `${taskId}::${phase}::${round}`;
  }

  private path(taskId: string, phase: ReviewPhase, round: number): string {
    return join(this.dir!, encodeURIComponent(taskId), phase, `round-${round}.json`);
  }
}
