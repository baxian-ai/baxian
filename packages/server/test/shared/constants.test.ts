import { describe, expect, it } from 'vitest';
import {
  TASK_ACTIVE_STATUS_SET,
  TASK_TERMINAL_STATUS_SET,
  isTaskOpen,
} from '../../src/shared/index.js';

describe('task status sets (task-097: max_rounds is non-terminal)', () => {
  it('classifies max_rounds as active, not terminal', () => {
    expect(TASK_ACTIVE_STATUS_SET.has('max_rounds')).toBe(true);
    expect(TASK_TERMINAL_STATUS_SET.has('max_rounds')).toBe(false);
  });

  it('treats max_rounds as open (it stays in the working set, not terminal/history)', () => {
    expect(isTaskOpen('max_rounds')).toBe(true);
  });

  it('keeps the real terminal statuses terminal', () => {
    for (const s of ['merged', 'failed', 'cancelled'] as const) {
      expect(TASK_TERMINAL_STATUS_SET.has(s)).toBe(true);
      expect(isTaskOpen(s)).toBe(false);
    }
  });
});
