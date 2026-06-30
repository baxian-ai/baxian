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

const spriteCache = new Map<string, Promise<string>>();
const resolvedSprites = new Map<string, string>();

export function usePetSpritesheet(petId: string | undefined): string | null {
  const [url, setUrl] = useState<string | null>(() => (petId ? resolvedSprites.get(petId) ?? null : null));
  useEffect(() => {
    if (!petId) {
      setUrl(null);
      return;
    }
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
