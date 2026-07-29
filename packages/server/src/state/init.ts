import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function initStateDir(baseDir: string): Promise<void> {
  await Promise.all([
    mkdir(join(baseDir, 'state', 'agents'), { recursive: true }),
    mkdir(join(baseDir, 'state', 'errors'), { recursive: true }),
    mkdir(join(baseDir, 'state', 'tasks'), { recursive: true }),
    mkdir(join(baseDir, 'state', 'post-approve'), { recursive: true }),
    mkdir(join(baseDir, 'events'), { recursive: true }),
    mkdir(join(baseDir, 'locks'), { recursive: true }),
  ]);
}
