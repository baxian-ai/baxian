import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import type { AgentRuntimeStatus } from '../../src/shared/index.js';

const sprite = vi.hoisted(() => ({ url: 'blob:mock' as string | null }));
vi.mock('../../src/hooks/use-pets.ts', () => ({
  usePetSpritesheet: () => sprite.url,
}));

import { AgentPet, PET_ANIMATION_ROWS, petRowForStatus } from '../../src/components/agent-pet.tsx';

let reducedMotion = false;
function setMatchMedia(reduced: boolean): void {
  reducedMotion = reduced;
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: reducedMotion,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  sprite.url = 'blob:mock';
  setMatchMedia(true); // static by default — deterministic frame 0
});

describe('petRowForStatus', () => {
  it.each([
    ['working', false, 7],
    ['waiting', false, 6],
    ['pending', false, 6],
    ['idle', false, 0],
    ['error', false, 5],
    ['unknown', false, 0],
    ['idle', true, 3], // bootstrapping overrides → waving
    ['working', true, 3],
  ] as const)('maps %s (bootstrapping=%s) → row %i', (status, boot, row) => {
    expect(petRowForStatus(status as AgentRuntimeStatus, boot)).toBe(row);
  });
});

describe('PET_ANIMATION_ROWS (hatch-pet contract)', () => {
  it('has 9 rows with the exact per-row frame counts and durations', () => {
    expect(PET_ANIMATION_ROWS).toHaveLength(9);
    const frameCounts = PET_ANIMATION_ROWS.map((r) => r.durations.length);
    expect(frameCounts).toEqual([6, 8, 8, 4, 5, 8, 6, 6, 6]);
    expect(PET_ANIMATION_ROWS[0].durations).toEqual([280, 110, 110, 140, 140, 320]); // idle
    expect(PET_ANIMATION_ROWS[3].durations).toEqual([140, 140, 140, 280]); // waving
    expect(PET_ANIMATION_ROWS[7].durations).toEqual([120, 120, 120, 120, 120, 220]); // running
    PET_ANIMATION_ROWS.forEach((r, i) => expect(r.row).toBe(i));
  });
});

describe('AgentPet rendering', () => {
  it('renders a sprite with role=img, the status label, and the right row offset', () => {
    render(<AgentPet petId="p1" status="working" label="Working" />);
    const el = screen.getByRole('img', { name: 'Working' });
    expect(el.getAttribute('data-pet-row')).toBe('7'); // working → running
    expect(el.getAttribute('data-pet-col')).toBe('0');
    expect(el.style.backgroundImage).toContain('blob:mock');
    expect(el.style.backgroundPositionY).toBe('-252px'); // -(row 7 * 36px)
  });

  it('falls back to the status pill while the spritesheet is unavailable', () => {
    sprite.url = null;
    render(<AgentPet petId="p1" status="working" label="Working" />);
    expect(screen.queryByRole('img', { name: 'Working' })).toBeNull();
    const pill = screen.getByText('Working');
    expect(pill.className).toContain('pill');
  });

  it('stays on frame 0 when prefers-reduced-motion is set', () => {
    setMatchMedia(true);
    vi.useFakeTimers();
    try {
      render(<AgentPet petId="p1" status="working" label="Working" />);
      const el = screen.getByRole('img', { name: 'Working' });
      act(() => { vi.advanceTimersByTime(5000); });
      expect(el.getAttribute('data-pet-col')).toBe('0');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AgentPet animation only cycles a row\'s used frames', () => {
  function collectCols(status: AgentRuntimeStatus, bootstrapping: boolean): Set<number> {
    setMatchMedia(false);
    vi.useFakeTimers();
    const cols = new Set<number>();
    try {
      render(<AgentPet petId="p1" status={status} bootstrapping={bootstrapping} label="x" />);
      const el = screen.getByRole('img', { name: 'x' });
      cols.add(Number(el.getAttribute('data-pet-col')));
      for (let i = 0; i < 40; i++) {
        act(() => { vi.advanceTimersByTime(120); });
        cols.add(Number(el.getAttribute('data-pet-col')));
      }
    } finally {
      vi.useRealTimers();
    }
    return cols;
  }

  it('never advances past the used frames for the running row (6 frames)', () => {
    const cols = collectCols('working', false);
    expect(Math.max(...cols)).toBe(5);
    expect([...cols].every((c) => c < 6)).toBe(true);
  });

  it('never advances into transparent cells for the 4-frame waving row (bootstrapping)', () => {
    const cols = collectCols('idle', true);
    expect(Math.max(...cols)).toBe(3);
    expect([...cols].every((c) => c < 4)).toBe(true);
  });
});
