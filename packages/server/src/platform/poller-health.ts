import type { PollerHealth } from '../shared/types.js';

const DEGRADED_FAILURE_THRESHOLD = 1;
const FAILED_FAILURE_THRESHOLD = 3;

export function computePollerHealth(
  consecutiveFailures: number,
  lastPollEndedAt: string | undefined,
): PollerHealth {
  if (!lastPollEndedAt && consecutiveFailures === 0) return 'unknown';
  if (consecutiveFailures >= FAILED_FAILURE_THRESHOLD) return 'failed';
  if (consecutiveFailures >= DEGRADED_FAILURE_THRESHOLD) return 'degraded';
  return 'healthy';
}
