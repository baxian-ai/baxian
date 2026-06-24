import { useCallback, useEffect, useState } from 'react';
import type { PetMeta } from '../shared/index.js';
import { api } from '../api.ts';

export interface UsePetsResult {
  pets: PetMeta[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function usePets(): UsePetsResult {
  const [pets, setPets] = useState<PetMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setPets(await api.pets.list());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { pets, loading, error, refresh };
}

// Spritesheets are immutable per (UUID) petId, so one fetch+objectURL is shared across
// every card that renders the same pet; the blob URL outlives unmounts on purpose.
const spriteCache = new Map<string, Promise<string>>();
// Synchronous view of already-resolved URLs, so switching to an already-fetched pet shows it
// instantly (no flicker) while switching to a not-yet-fetched pet clears the previous one.
const resolvedSprites = new Map<string, string>();

export function usePetSpritesheet(petId: string | undefined): string | null {
  const [url, setUrl] = useState<string | null>(() => (petId ? resolvedSprites.get(petId) ?? null : null));
  useEffect(() => {
    if (!petId) {
      setUrl(null);
      return;
    }
    // Never keep the previous pet's sprite while the new one loads — show its cached URL if we
    // have it, otherwise clear immediately so a slow fetch can't render the wrong pet.
    const cached = resolvedSprites.get(petId);
    setUrl(cached ?? null);
    if (cached) return;
    let cancelled = false;
    let promise = spriteCache.get(petId);
    if (!promise) {
      promise = api.pets.fetchSpritesheet(petId).then((blob) => {
        const objectUrl = URL.createObjectURL(blob);
        resolvedSprites.set(petId, objectUrl);
        return objectUrl;
      });
      spriteCache.set(petId, promise);
    }
    promise.then(
      (resolved) => { if (!cancelled) setUrl(resolved); },
      () => { if (!cancelled) setUrl(null); spriteCache.delete(petId); },
    );
    return () => { cancelled = true; };
  }, [petId]);
  return url;
}
