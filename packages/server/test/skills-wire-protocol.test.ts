import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PHASE_SIGNAL_KINDS } from '../src/agent/phase-signal.js';

const SKILLS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'skills');
const GH_SKILL = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'platform',
  'plugins',
  'github',
  'skills',
  'baxian-cli-gh',
  'SKILL.md',
);

describe('need-input wire protocol single source', () => {
  it('no skill outside baxian-signals hardcodes a need-input/input-received wire literal', async () => {
    const offenders: string[] = [];
    for (const dir of await readdir(SKILLS_ROOT)) {
      if (dir === 'baxian-signals') continue;
      const path = join(SKILLS_ROOT, dir, 'SKILL.md');
      let content: string;
      try {
        content = await readFile(path, 'utf8');
      } catch {
        continue;
      }
      if (/\[bx:(?:need-input|input-received)[:\]]/.test(content)) offenders.push(dir);
    }
    expect(offenders).toEqual([]);
  });

  it('baxian-signals defines both the ordinal ask and the paired answer form', async () => {
    const content = await readFile(join(SKILLS_ROOT, 'baxian-signals', 'SKILL.md'), 'utf8');
    expect(content).toContain('[bx:need-input:<token>:<n>]');
    expect(content).toContain('[bx:input-received:<token>:<n>]');
  });
});

describe('task completion route contract', () => {
  it('keeps every phase/exit mapping in baxian-signals and within the server watcher catalog', async () => {
    const content = await readFile(join(SKILLS_ROOT, 'baxian-signals', 'SKILL.md'), 'utf8');
    const routes = [...content.matchAll(/^\| `([^`]+)` \| `([^`]+)` \| `([^`]+)` \|$/gm)]
      .map(([, phase, exit, kind]) => ({ phase, exit, kind }));

    expect(routes).toEqual([
      { phase: 'develop', exit: '§Deliver', kind: 'pr-created' },
      { phase: 'develop', exit: '§SDD', kind: 'spec-done' },
      { phase: 'code', exit: '§Deliver', kind: 'pr-created' },
      { phase: 'fix', exit: '§Fix', kind: 'pr-fixed' },
      { phase: 'post-approve', exit: '§Post-Approve', kind: 'pr-merge-ready' },
    ]);
    for (const { kind } of routes) expect(PHASE_SIGNAL_KINDS).toContain(kind);
  });

  it('does not ask phase skills to read retired signal kind fields', async () => {
    for (const skill of ['baxian-task-check', 'baxian-pr-feedback']) {
      const content = await readFile(join(SKILLS_ROOT, skill, 'SKILL.md'), 'utf8');
      expect(content).not.toMatch(/`(?:spec-)?signal:`/);
    }
  });
});

describe('SDD-over-PR skill contract', () => {
  it('keeps PR specs collision-resistant without a server-files route', async () => {
    const content = await readFile(join(SKILLS_ROOT, 'baxian-task-check', 'SKILL.md'), 'utf8');
    expect(content).toContain('docs/specs/${slug}-${hash16}.md');
    expect(content).toContain("sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//'");
    expect(content).toContain('cut -c1-48');
    expect(content).toContain('openssl dgst -sha256 -r');
    expect(content).toContain('set -o noclobber');
    expect(content).not.toContain('.baxian/spec.md');
    expect(content).not.toContain('server-files');
  });

  it('requires actor-bound spec delivery and omits retired signals', async () => {
    const content = await readFile(join(SKILLS_ROOT, 'baxian-signals', 'SKILL.md'), 'utf8');
    expect(content).toContain('[bx:KIND:<pr_number>:<base64url-actor-id>:TOKEN]');
    expect(content).not.toContain('[bx:spec-done:TOKEN]');
    for (const kind of [
      'code-done', 'code-reviewed', 'code-fixed', 'code-ready', 'spec-reviewed', 'spec-fixed',
    ]) {
      expect(content).not.toContain(kind);
    }
  });

  it.each([
    'baxian-pr-review',
    'baxian-pr-recheck',
    'baxian-pr-feedback',
  ])('%s routes stage: spec to the spec artifact', async (skill) => {
    const content = await readFile(join(SKILLS_ROOT, skill, 'SKILL.md'), 'utf8');
    expect(content).toContain('stage: spec');
  });

  it('publishes through adopt-or-create and never replaces a bound PR', async () => {
    const content = await readFile(GH_SKILL, 'utf8');
    expect(content).toContain('gh pr list -R <cli-repo> --head "<branch>" --state open');
    expect(content).toContain('gh pr reopen <pr> -R <cli-repo>');
    expect(content).toContain('[bx:spec-done:<pr>:<base64url-id>:<token>]');
    expect(content).toContain('[bx:pr-created:<pr>:<base64url-id>:<token>]');
  });
});
