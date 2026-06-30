export interface BackoffParams {
  baseMs: number;
  maxMs: number;
  factor?: number;
  jitter?: number;
  random?: () => number;
}

export function computeBackoffMs(attempt: number, params: BackoffParams): number {
  const factor = params.factor ?? 2;
  const exponent = Math.max(0, Math.trunc(attempt) - 1);
  const capped = Math.min(params.baseMs * Math.pow(factor, exponent), params.maxMs);
  const rawJitter = params.jitter ?? 0;
  const jitter = Number.isFinite(rawJitter) ? Math.min(1, Math.max(0, rawJitter)) : 0;
  if (jitter <= 0) return Math.round(capped);
  const r = (params.random ?? Math.random)();
  return Math.round(capped * (1 - jitter * r));
}
