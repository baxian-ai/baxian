import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SKILLS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'skills');

// The need-input wire grammar lives in baxian-signals ONLY. A bare literal hardcoded in
// another skill would keep provisioning the pre-ordinal protocol and silently reopen the
// replay window the ordinal pairing closed.
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
