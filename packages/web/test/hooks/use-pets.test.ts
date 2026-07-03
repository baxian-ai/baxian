import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

vi.mock('../../src/api.ts', async () => (await import('../helpers/api-mock.ts')).createApiMock());

import { api } from '../../src/api.ts';
import { usePetSpritesheet } from '../../src/hooks/use-pets.ts';

const fetchSpritesheetMock = vi.mocked(api.pets.fetchSpritesheet);

beforeEach(() => {
  fetchSpritesheetMock.mockReset();
  (URL as unknown as { createObjectURL: () => string }).createObjectURL = vi.fn(() => 'blob:created');
});

describe('usePetSpritesheet', () => {
  it('fetches once and shares the object URL across renders of the same petId', async () => {
    fetchSpritesheetMock.mockResolvedValue(new Blob(['x']));
    const a = renderHook(() => usePetSpritesheet('pet-cache-shared'));
    const b = renderHook(() => usePetSpritesheet('pet-cache-shared'));
    await waitFor(() => expect(a.result.current).toBe('blob:created'));
    await waitFor(() => expect(b.result.current).toBe('blob:created'));
    expect(fetchSpritesheetMock).toHaveBeenCalledTimes(1);
  });

  it('returns null and never fetches when petId is undefined', () => {
    const { result } = renderHook(() => usePetSpritesheet(undefined));
    expect(result.current).toBeNull();
    expect(fetchSpritesheetMock).not.toHaveBeenCalled();
  });

  it('clears the previous sprite immediately when switching to a not-yet-fetched pet', async () => {
    let resolveB: ((b: Blob) => void) | undefined;
    fetchSpritesheetMock.mockImplementation((id: string) =>
      id === 'switch-A'
        ? Promise.resolve(new Blob(['a']))
        : new Promise<Blob>((res) => { resolveB = res; }),
    );
    const { result, rerender } = renderHook(({ id }) => usePetSpritesheet(id), {
      initialProps: { id: 'switch-A' },
    });
    await waitFor(() => expect(result.current).toBe('blob:created'));

    rerender({ id: 'switch-B' });
    expect(result.current).toBeNull();

    await act(async () => { resolveB?.(new Blob(['b'])); });
    await waitFor(() => expect(result.current).toBe('blob:created'));
  });
});
