import { vi } from 'vitest';
import type { ReactNode } from 'react';

type ToastModule = typeof import('../../src/components/toast.tsx');

export const toastShowMock = vi.fn();

export function createToastMock(): ToastModule {
  return {
    ToastProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
    useToast: () => ({ show: toastShowMock }),
  };
}
