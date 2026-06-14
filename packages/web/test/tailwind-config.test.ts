import { describe, it, expect } from 'vitest';

import tailwindConfig from '../tailwind.config.js';

const radius = (tailwindConfig.theme?.borderRadius ?? {}) as Record<string, string>;
const px = (token: string) => Number.parseInt(radius[token], 10);

describe('border-radius design tokens', () => {
  it('uses the reduced, more formal radius scale', () => {
    expect(radius).toMatchObject({
      sm: '2px',
      DEFAULT: '4px',
      md: '4px',
      lg: '6px',
    });
  });

  it('keeps every corner within the professional 2–6px band so the UI reads formal, not eliminated', () => {
    for (const token of ['sm', 'DEFAULT', 'md', 'lg']) {
      expect(px(token)).toBeGreaterThanOrEqual(2);
      expect(px(token)).toBeLessThanOrEqual(6);
    }
  });

  it('keeps the scale monotonic and DEFAULT aligned with md', () => {
    expect(px('DEFAULT')).toBe(px('md'));
    expect(px('sm')).toBeLessThanOrEqual(px('md'));
    expect(px('md')).toBeLessThanOrEqual(px('lg'));
  });

  it('replaces the scale at theme top-level (not under extend) so Tailwind drops its oversized rounded-xl/2xl/3xl utilities', () => {
    expect(tailwindConfig.theme?.borderRadius).toBeDefined();
    expect(tailwindConfig.theme?.extend?.borderRadius).toBeUndefined();
    for (const oversized of ['xl', '2xl', '3xl']) {
      expect(radius[oversized]).toBeUndefined();
    }
  });

  it('still exposes the circular and square anchors (full for pills/dots, none for square corners)', () => {
    expect(radius.full).toBe('9999px');
    expect(radius.none).toBe('0px');
  });
});
