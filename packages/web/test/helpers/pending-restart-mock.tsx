import { vi } from 'vitest';
import type { ReactNode } from 'react';

type PendingRestartModule = typeof import('../../src/hooks/use-pending-restart.tsx');
type PendingRestartValue = ReturnType<PendingRestartModule['usePendingRestart']>;

export const flagDirtyMock = vi.fn();
export const triggerRestartMock = vi.fn(async () => {});

// 可变对象：测试内 Object.assign(pendingRestartValue, {...}) 调整 phase/count 等分支
export const pendingRestartValue: PendingRestartValue = {
  phase: 'idle',
  count: 0,
  flagDirty: flagDirtyMock,
  triggerRestart: triggerRestartMock,
};

export function resetPendingRestartValue(): void {
  Object.assign(pendingRestartValue, {
    phase: 'idle',
    count: 0,
    error: undefined,
    flagDirty: flagDirtyMock,
    triggerRestart: triggerRestartMock,
  });
}

export function createPendingRestartMock(): PendingRestartModule {
  return {
    PendingRestartProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
    usePendingRestart: () => pendingRestartValue,
  };
}
