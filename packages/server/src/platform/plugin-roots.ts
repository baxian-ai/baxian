import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function builtinPluginRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'plugins');
}

export function userPluginRoot(home: string): string {
  return join(home, 'plugins');
}
