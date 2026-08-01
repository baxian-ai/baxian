import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const SERVER_SRC = fileURLToPath(new URL('../src', import.meta.url));

const SHELL_RM = /\brm\s+-[a-zA-Z]*[rf]\b/;

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else files.push(path);
  }
  return files;
}

describe('no shell rm in runtime sources', () => {
  it('server runtime sources never spell rm -rf / rm -f', async () => {
    const files = await walk(SERVER_SRC);
    const offenders: string[] = [];
    for (const file of files) {
      const text = await readFile(file, 'utf-8');
      if (SHELL_RM.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
