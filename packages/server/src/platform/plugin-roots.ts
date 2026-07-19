import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { USER_STATE_REL } from '../shared/index.js';

export function builtinPluginRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'plugins');
}

export function userPluginRoot(): string {
  return join(homedir(), USER_STATE_REL, 'plugins');
}
