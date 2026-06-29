import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillRegistry, assertCoreSkillsPresent } from '../../src/skill/registry.js';

let tempDir: string;

async function createSkill(name: string, content: string): Promise<void> {
  await mkdir(join(tempDir, name), { recursive: true });
  await writeFile(join(tempDir, name, 'SKILL.md'), content);
}

async function scanned(dir: string = tempDir): Promise<SkillRegistry> {
  const registry = new SkillRegistry(dir);
  await registry.scan();
  return registry;
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-skills-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true });
});

describe('SkillRegistry', () => {
  it('scans skills directory and finds all skills', async () => {
    await createSkill('task-check', '# Task Check\nAnalyze the task.');
    await createSkill('pr-review', '# PR Review\nReview the PR.');
    const registry = await scanned();
    expect(registry.has('task-check')).toBe(true);
    expect(registry.has('pr-review')).toBe(true);
    expect(registry.has('nonexistent')).toBe(false);
  });

  it('returns skill content', async () => {
    await createSkill('task-check', '# Task Check\nDo the thing.');
    const registry = await scanned();
    const skill = registry.get('task-check');
    expect(skill?.content).toContain('Task Check');
  });

  it('lists all skill names', async () => {
    await createSkill('a-skill', 'content');
    await createSkill('b-skill', 'content');
    const registry = await scanned();
    expect(registry.names().sort()).toEqual(['a-skill', 'b-skill']);
  });

  it('returns skills for a given role and phase', async () => {
    await createSkill('baxian-task-check', 'content');
    await createSkill('baxian-pr-review', 'content');
    const registry = await scanned();
    const devSkills = registry.skillsForPhase('dev', 'develop');
    expect(devSkills).toContain('baxian-task-check');
    expect(devSkills).not.toContain('baxian-pr-review');
  });

  it('handles empty skills directory', async () => {
    const registry = await scanned();
    expect(registry.names()).toEqual([]);
  });

  it('ignores non-directory entries', async () => {
    await writeFile(join(tempDir, 'README.md'), 'not a skill');
    await createSkill('real-skill', 'content');
    const registry = await scanned();
    expect(registry.names()).toEqual(['real-skill']);
  });

  it('survives a broken symlink at the top level', async () => {
    await createSkill('real-skill', 'content');
    await symlink(join(tempDir, 'does-not-exist'), join(tempDir, 'broken-link'));
    const registry = await scanned();
    expect(registry.has('real-skill')).toBe(true);
  });

  it('does not follow a symlinked directory at the top level into a skill', async () => {
    await createSkill('real-skill', 'content');
    await symlink(join(tempDir, 'real-skill'), join(tempDir, 'linked-skill'));
    const registry = await scanned();
    expect(registry.names()).toEqual(['real-skill']);
  });

  it('skips a skill whose SKILL.md is a symlink (not registered)', async () => {
    const foreignMd = join(tempDir, 'foreign.md');
    await writeFile(foreignMd, '# Foreign');
    await mkdir(join(tempDir, 'symlinked-md-skill'), { recursive: true });
    await symlink(foreignMd, join(tempDir, 'symlinked-md-skill', 'SKILL.md'));
    await createSkill('real-skill', 'content');
    const registry = await scanned();
    expect(registry.names()).toEqual(['real-skill']);
  });

  it('ignores a symlinked helper file inside a skill (does not inject it)', async () => {
    const secret = join(tempDir, 'outside.txt');
    await writeFile(secret, 'host secret');
    await createSkill('alpha', '# Alpha');
    await symlink(secret, join(tempDir, 'alpha', 'leak.txt'));
    const registry = await scanned();
    const recorded = new Map<string, Buffer>();
    await registry.materialize(async (path, content) => {
      recorded.set(path, content);
    }, '/dest');
    expect([...recorded.keys()]).toEqual(['/dest/alpha/SKILL.md']);
  });
});

describe('SkillRegistry edge cases', () => {
  it('a nonexistent skills directory yields an empty registry (no crash)', async () => {
    const registry = await scanned('/nonexistent/skills/path');
    expect(registry.names()).toEqual([]);
  });

  it('no skills directory argument yields an empty registry', async () => {
    const registry = new SkillRegistry();
    await registry.scan();
    expect(registry.names()).toEqual([]);
  });
});

describe('SkillRegistry.materialize', () => {
  it('writes SKILL.md and helper files under destRoot/<name>/<relPath> with exact Buffer contents', async () => {
    await createSkill('alpha', '# Alpha skill');
    await mkdir(join(tempDir, 'beta', 'helpers'), { recursive: true });
    await writeFile(join(tempDir, 'beta', 'SKILL.md'), '# Beta skill');
    await writeFile(join(tempDir, 'beta', 'helpers', 'x.sh'), '#!/bin/sh\necho hi');

    const registry = await scanned();

    const recorded = new Map<string, Buffer>();
    const recorder = async (path: string, content: Buffer): Promise<void> => {
      recorded.set(path, content);
    };
    const written = await registry.materialize(recorder, '/dest');

    expect(written).toContain('/dest/alpha/SKILL.md');
    expect(written).toContain('/dest/beta/SKILL.md');
    expect(written).toContain('/dest/beta/helpers/x.sh');

    expect(recorded.get('/dest/alpha/SKILL.md')).toEqual(Buffer.from('# Alpha skill'));
    expect(recorded.get('/dest/beta/SKILL.md')).toEqual(Buffer.from('# Beta skill'));
    expect(recorded.get('/dest/beta/helpers/x.sh')).toEqual(Buffer.from('#!/bin/sh\necho hi'));
  });
});

describe('SkillRegistry.contentHash', () => {
  it('returns a non-empty stable digest, identical across scans of identical content', async () => {
    await createSkill('alpha', '# Alpha');
    await createSkill('beta', '# Beta');

    const registry = await scanned();
    const first = registry.contentHash();
    expect(first).toBeTruthy();
    expect(first.length).toBeGreaterThan(0);

    await registry.scan();
    expect(registry.contentHash()).toBe(first);
  });

  it('changes when a skill content changes', async () => {
    await createSkill('alpha', '# Alpha');
    const registry = await scanned();
    const before = registry.contentHash();

    await writeFile(join(tempDir, 'alpha', 'SKILL.md'), '# Alpha edited');
    await registry.scan();
    const after = registry.contentHash();

    expect(after).not.toBe(before);
  });
});

describe('assertCoreSkillsPresent', () => {
  it('passes when both core skills are present', async () => {
    await createSkill('baxian-greeting', '# Greeting');
    await createSkill('baxian-signals', '# Signals');
    const registry = await scanned();
    expect(() => assertCoreSkillsPresent(registry, tempDir)).not.toThrow();
  });

  it('throws an EMPTY-registry error when no skills were scanned (dropped dir / bad path)', async () => {
    const registry = await scanned('/nonexistent/skills/path');
    expect(() => assertCoreSkillsPresent(registry, '/nonexistent/skills/path'))
      .toThrow(/EMPTY.*\/nonexistent\/skills\/path/s);
  });

  it('throws naming the missing core skill when only one is present', async () => {
    await createSkill('baxian-greeting', '# Greeting');
    const registry = await scanned();
    expect(() => assertCoreSkillsPresent(registry, tempDir))
      .toThrow(/missing core skill\(s\): baxian-signals/);
  });
});
