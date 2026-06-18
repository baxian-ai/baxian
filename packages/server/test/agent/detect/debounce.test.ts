import { describe, it, expect } from 'vitest';
import { WorkingToIdleDebounce } from '../../../src/agent/detect/debounce.js';

describe('WorkingToIdleDebounce', () => {
  it('publishes non-idle states immediately', () => {
    const debounce = new WorkingToIdleDebounce();
    expect(debounce.apply('working', 'idle', false)).toBe('working');
    expect(debounce.apply('pending', 'working', false)).toBe('pending');
  });

  it('holds working→idle transition until confirmed 3 times', () => {
    const debounce = new WorkingToIdleDebounce();
    expect(debounce.apply('idle', 'working', false)).toBe('working');
    expect(debounce.apply('idle', 'working', false)).toBe('working');
    expect(debounce.apply('idle', 'working', false)).toBe('idle');
  });

  it('resets confirmation count when non-idle reading appears', () => {
    const debounce = new WorkingToIdleDebounce();
    debounce.apply('idle', 'working', false);
    debounce.apply('idle', 'working', false);
    debounce.apply('working', 'working', false);
    expect(debounce.apply('idle', 'working', false)).toBe('working');
    expect(debounce.apply('idle', 'working', false)).toBe('working');
    expect(debounce.apply('idle', 'working', false)).toBe('idle');
  });

  it('publishes idle immediately when visibleIdle is true', () => {
    const debounce = new WorkingToIdleDebounce();
    expect(debounce.apply('idle', 'working', true)).toBe('idle');
  });

  it('publishes idle immediately when previous was not working', () => {
    const debounce = new WorkingToIdleDebounce();
    expect(debounce.apply('idle', 'pending', false)).toBe('idle');
  });

  it('resets on agent change via reset()', () => {
    const debounce = new WorkingToIdleDebounce();
    debounce.apply('idle', 'working', false);
    debounce.apply('idle', 'working', false);
    debounce.reset();
    expect(debounce.apply('idle', 'working', false)).toBe('working');
  });
});
