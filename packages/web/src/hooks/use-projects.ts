import { useEffect, useState } from 'react';
import { api, UNAUTHORIZED_EVENT } from '../api.ts';
import type { ProjectConfig } from '../shared/index.js';

let cache: ProjectConfig[] | null = null;
let inflight: Promise<void> | null = null;
let lastError: string | null = null;
let epoch = 0;
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((fn) => fn());
}

async function doFetch(): Promise<void> {
  const myEpoch = epoch;
  try {
    const data = await api.projects.list();
    if (myEpoch !== epoch) return;
    cache = data;
    lastError = null;
  } catch (err) {
    if (myEpoch !== epoch) return;
    lastError = err instanceof Error ? err.message : String(err);
  } finally {
    if (myEpoch === epoch) {
      inflight = null;
      notify();
    }
  }
}

export function refreshProjects(): Promise<void> {
  if (inflight) return inflight;
  inflight = doFetch();
  return inflight;
}

function clearForAuthChange(): void {
  epoch += 1;
  cache = null;
  inflight = null;
  lastError = null;
  notify();
}

if (typeof window !== 'undefined') {
  window.addEventListener(UNAUTHORIZED_EVENT, clearForAuthChange);
}

export function __resetProjectsCacheForTests(): void {
  epoch += 1;
  cache = null;
  inflight = null;
  lastError = null;
  listeners.clear();
}

export interface UseProjectsResult {
  projects: ProjectConfig[] | null;
  error: string | null;
  refresh: () => Promise<void>;
}

async function refreshSeesMutation(): Promise<void> {
  const hadInflightWhenCalled = inflight !== null;
  await refreshProjects();
  if (hadInflightWhenCalled) {
    await refreshProjects();
  }
}

export function useProjects(): UseProjectsResult {
  const [, bump] = useState(0);
  useEffect(() => {
    const sub = (): void => bump((n) => n + 1);
    listeners.add(sub);
    if (cache === null && !inflight) void refreshProjects();
    return () => {
      listeners.delete(sub);
    };
  }, []);
  return { projects: cache, error: lastError, refresh: refreshSeesMutation };
}
