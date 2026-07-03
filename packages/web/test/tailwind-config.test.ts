import { describe, it, expect } from 'vitest';

import tailwindConfig from '../tailwind.config.js';

const radius = (tailwindConfig.theme?.borderRadius ?? {}) as Record<string, string>;
const px = (token: string) => Number.parseInt(radius[token], 10);
type FontSizeToken = string | [string, { lineHeight: string }];
const fontSize = (tailwindConfig.theme?.fontSize ?? {}) as unknown as Record<string, FontSizeToken>;
const extend = (tailwindConfig.theme?.extend ?? {}) as Record<string, unknown>;
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
    expect(extend.borderRadius).toBeUndefined();
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
  it('uses a two-step UI scale (12px meta, 14px primary)', () => {
    expect(fontSize).toMatchObject({
      xs: ['12px', { lineHeight: '1.4' }],
      sm: ['14px', { lineHeight: '1.55' }],
    });
  });

  it('replaces the default font scale so no third UI size utility exists', () => {
    expect(Object.keys(fontSize).sort()).toEqual(['sm', 'xs']);
    expect(extend.fontSize).toBeUndefined();
    for (const dropped of ['base', 'lg', 'xl', '2xl', '3xl']) {
      expect(fontSize[dropped]).toBeUndefined();
    }
  });

  it('keeps both steps distinct from each other and from the 13px web terminal, so the site has exactly three sizes', () => {
    expect(fontPx('xs')).toBeLessThan(fontPx('sm'));
    for (const token of Object.keys(fontSize)) {
      expect(fontPx(token)).not.toBe(13);
    }
  });
});
