import { describe, expect, it } from 'vitest';
import { assertInsideManagedDir } from '../../src/state/managed-path.js';

describe('assertInsideManagedDir', () => {
  it('returns the resolved path for a target inside the base', () => {
    expect(assertInsideManagedDir('/base/.baxian', '/base/.baxian/state/tasks/task-1.json'))
      .toBe('/base/.baxian/state/tasks/task-1.json');
  });

  it('normalizes dot segments before deciding', () => {
    expect(assertInsideManagedDir('/base/.baxian', '/base/.baxian/state/../state/x'))
      .toBe('/base/.baxian/state/x');
  });

  it.each([
    ['escape via ..', '/base/.baxian/../victim'],
    ['absolute path outside', '/etc/passwd'],
    ['sibling with the base as name prefix', '/base/.baxian-evil/x'],
    ['the base dir itself', '/base/.baxian'],
  ])('rejects %s', (_label, target) => {
    expect(() => assertInsideManagedDir('/base/.baxian', target)).toThrow(/outside managed dir/);
  });
});
