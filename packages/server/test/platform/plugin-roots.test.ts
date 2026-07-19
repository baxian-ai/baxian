import { describe, it, expect } from 'vitest';
import { builtinPluginRoot, userPluginRoot } from '../../src/platform/plugin-roots.js';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';

describe('plugin roots', () => {
  it('builtinPluginRoot resolves to the module-relative plugins dir', () => {
    const root = builtinPluginRoot();
    expect(isAbsolute(root)).toBe(true);
    expect(root.endsWith(join('platform', 'plugins'))).toBe(true);
  });

  it('userPluginRoot is ~/.baxian/plugins', () => {
    expect(userPluginRoot()).toBe(join(homedir(), '.baxian', 'plugins'));
  });
});
