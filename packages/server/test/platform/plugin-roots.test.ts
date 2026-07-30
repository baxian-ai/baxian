import { describe, it, expect } from 'vitest';
import { builtinPluginRoot, userPluginRoot } from '../../src/platform/plugin-roots.js';
import { join, isAbsolute } from 'node:path';

describe('plugin roots', () => {
  it('builtinPluginRoot resolves to the module-relative plugins dir', () => {
    const root = builtinPluginRoot();
    expect(isAbsolute(root)).toBe(true);
    expect(root.endsWith(join('platform', 'plugins'))).toBe(true);
  });

  it('places user plugins under the selected instance home', () => {
    expect(userPluginRoot('/var/lib/baxian-blue')).toBe(join('/var/lib/baxian-blue', 'plugins'));
  });
});
