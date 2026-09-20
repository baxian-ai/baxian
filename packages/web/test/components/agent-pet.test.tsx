import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { AgentRuntimeStatus } from '../../src/shared/index.js';

vi.mock('../../src/api.ts', async () => (await import('../helpers/api-mock.ts')).createApiMock());

import { api } from '../../src/api.ts';
import { usePetSpritesheet } from '../../src/hooks/use-pets.ts';
import { AgentPet, PET_ANIMATION_ROWS, petRowForStatus } from '../../src/components/agent-pet.tsx';

const fetchSpritesheetMock = vi.mocked(api.pets.fetchSpritesheet);

class StubURL extends URL {
  static createObjectURL = vi.fn(() => 'blob:mock');
  static revokeObjectURL = vi.fn();
}

// The spritesheet cache is module-level, so p1 is warmed once and the fake-timer cases mount it synchronously.
async function loadSprite(petId: string): Promise<void> {
  const { result, unmount } = renderHook(() => usePetSpritesheet(petId));
  await waitFor(() => expect(result.current).toBe('blob:mock'));
  unmount();
}

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

beforeEach(async () => {
  vi.stubGlobal('URL', StubURL);
  fetchSpritesheetMock.mockReset().mockResolvedValue(new Blob(['sprite']));
  setMatchMedia(true);
  await loadSprite('p1');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('petRowForStatus', () => {
  it.each([
    ['working', false, 7],
    ['waiting', false, 6],
    ['pending', false, 6],
    ['idle', false, 0],
    ['error', false, 5],
    ['unknown', false, 0],
    ['idle', true, 3],
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
    expect(PET_ANIMATION_ROWS[0].durations).toEqual([280, 110, 110, 140, 140, 320]);
    expect(PET_ANIMATION_ROWS[3].durations).toEqual([140, 140, 140, 280]);
    expect(PET_ANIMATION_ROWS[7].durations).toEqual([120, 120, 120, 120, 120, 220]);
    PET_ANIMATION_ROWS.forEach((r, i) => expect(r.row).toBe(i));
  });
});

describe('AgentPet rendering', () => {
  it('renders a sprite with role=img, the status label, and the right row offset', () => {
    render(<AgentPet petId="p1" status="working" label="Working" />);
    const el = screen.getByRole('img', { name: 'Working' });
    expect(el.getAttribute('data-pet-row')).toBe('7');
    expect(el.getAttribute('data-pet-col')).toBe('0');
    expect(el.style.backgroundImage).toContain('blob:mock');
    expect(el.style.backgroundPositionY).toBe('-252px');
  });

  it('scales sprite geometry from an explicit display height', () => {
    render(<AgentPet petId="p1" status="working" label="Working" displayHeight={72} />);
    const el = screen.getByRole('img', { name: 'Working' });
    expect(el.style.height).toBe('72px');
    expect(Number.parseFloat(el.style.width)).toBeCloseTo(66.46, 2);
    expect(el.style.backgroundPositionY).toBe('-504px');
  });

  it.each([
    ['fails to load', 'p-missing', () => Promise.reject(new Error('404'))],
    ['is still loading', 'p-slow', () => new Promise<Blob>(() => {})],
  ])('falls back to the status label while the spritesheet %s', async (_case, petId, fetchImpl) => {
    fetchSpritesheetMock.mockImplementation(fetchImpl);
    render(<AgentPet petId={petId} status="working" label="Working" />);
    await waitFor(() => expect(fetchSpritesheetMock).toHaveBeenCalledWith(petId));
    expect(screen.queryByRole('img', { name: 'Working' })).toBeNull();
    expect(screen.getByText('Working')).toBeTruthy();
  });

  it('fetches a spritesheet once and serves later mounts of the same pet from the shared cache', async () => {
    render(<AgentPet petId="p-shared" status="idle" label="First" />);
    await screen.findByRole('img', { name: 'First' });

    render(<AgentPet petId="p-shared" status="idle" label="Second" />);

    expect(screen.getByRole('img', { name: 'Second' })).toBeTruthy();
    // 只数这个 pet 的请求:beforeEach 预热过 p1,按总次数断言会随执行顺序和模块缓存残留而变
    const sharedCalls = fetchSpritesheetMock.mock.calls.filter(([id]) => id === 'p-shared');
    expect(sharedCalls).toHaveLength(1);
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
