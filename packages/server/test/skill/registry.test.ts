import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillRegistry } from '../../src/skill/registry.js';

let tempDir: string;

async function createSkill(name: string, content: string): Promise<void> {
  await mkdir(join(tempDir, name), { recursive: true });
  await writeFile(join(tempDir, name, 'SKILL.md'), content);
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
    const registry = new SkillRegistry(tempDir);
    await registry.scan();
    expect(registry.has('task-check')).toBe(true);
    expect(registry.has('pr-review')).toBe(true);
    expect(registry.has('nonexistent')).toBe(false);
  });

  it('returns skill content', async () => {
    await createSkill('task-check', '# Task Check\nDo the thing.');
    const registry = new SkillRegistry(tempDir);
    await registry.scan();
    const skill = registry.get('task-check');
    expect(skill?.content).toContain('Task Check');
  });

  it('lists all skill names', async () => {
    await createSkill('a-skill', 'content');
    await createSkill('b-skill', 'content');
    const registry = new SkillRegistry(tempDir);
    await registry.scan();
    expect(registry.names().sort()).toEqual(['a-skill', 'b-skill']);
  });

  it('returns skills for a given role and phase', async () => {
    await createSkill('task-check', 'content');
    await createSkill('baxian-rules', 'content');
    await createSkill('pr-review', 'content');
    const registry = new SkillRegistry(tempDir);
    await registry.scan();
    const devSkills = registry.skillsForPhase('dev', 'develop');
    expect(devSkills).toContain('task-check');
    expect(devSkills).toContain('baxian-rules');
    expect(devSkills).not.toContain('pr-review');
  });

  it('handles empty skills directory', async () => {
    const registry = new SkillRegistry(tempDir);
    await registry.scan();
    expect(registry.names()).toEqual([]);
  });

  it('ignores non-directory entries', async () => {
    await writeFile(join(tempDir, 'README.md'), 'not a skill');
    await createSkill('real-skill', 'content');
    const registry = new SkillRegistry(tempDir);
    await registry.scan();
    expect(registry.names()).toEqual(['real-skill']);
  });

  it('survives a broken symlink at the top level', async () => {
    await createSkill('real-skill', 'content');
    await symlink(join(tempDir, 'does-not-exist'), join(tempDir, 'broken-link'));
    const registry = new SkillRegistry(tempDir);
    await registry.scan();
    expect(registry.has('real-skill')).toBe(true);
  });
});

describe('SkillRegistry edge cases', () => {
  it('a nonexistent skills directory yields an empty registry (no crash)', async () => {
    const registry = new SkillRegistry('/nonexistent/skills/path');
    await registry.scan();
    expect(registry.names()).toEqual([]);
  });

  it('no skills directory argument yields an empty registry', async () => {
    const registry = new SkillRegistry();
    await registry.scan();
    expect(registry.names()).toEqual([]);
  });
});
