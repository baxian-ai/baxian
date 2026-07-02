import { describe, it, expect } from 'vitest';

import tailwindConfig from '../tailwind.config.js';

const radius = (tailwindConfig.theme?.borderRadius ?? {}) as Record<string, string>;
const px = (token: string) => Number.parseInt(radius[token], 10);
type FontSizeToken = string | [string, { lineHeight: string }];
const fontSize = (tailwindConfig.theme?.fontSize ?? {}) as Record<string, FontSizeToken>;
const fontPx = (token: string) => {
  const value = fontSize[token];
  return Number.parseInt(Array.isArray(value) ? value[0] : value, 10);
};

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

describe('font-size design tokens', () => {
  it('uses a compact three-step UI scale', () => {
    expect(fontSize).toMatchObject({
      xs: ['12px', { lineHeight: '1.4' }],
      sm: ['14px', { lineHeight: '1.55' }],
      base: ['15px', { lineHeight: '1.5' }],
    });
  });

  it('replaces the default font scale so larger text utilities are unavailable', () => {
    expect(Object.keys(fontSize).sort()).toEqual(['base', 'sm', 'xs']);
    for (const oversized of ['lg', 'xl', '2xl', '3xl']) {
      expect(fontSize[oversized]).toBeUndefined();
    }
  });

  it('keeps headings above body text without returning to the enlarged task-177 scale', () => {
    expect(fontPx('xs')).toBeLessThan(fontPx('sm'));
    expect(fontPx('sm')).toBeLessThan(fontPx('base'));
    expect(fontPx('base')).toBeLessThanOrEqual(15);
  });
});
