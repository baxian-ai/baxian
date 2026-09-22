import { enUS } from '../../src/i18n/en-us.ts';
import { expect } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

export interface ExpectedToast {
  title: string;
  body?: string | RegExp;
  details?: string;
}

export function findToast(title: string): Promise<HTMLElement> {
  return waitFor(() => {
    const toast = screen.getAllByText(title).map((el) => el.closest<HTMLElement>('[role="status"]')).find(Boolean);
    if (!toast) throw new Error(`no toast titled "${title}"`);
    return toast;
  });
}

export async function expectToast({ title, body, details }: ExpectedToast): Promise<HTMLElement> {
  const toast = await findToast(title);
  if (body !== undefined) {
    expect(within(toast).getByText(typeof body === 'string' ? body.replace(/\s+/g, ' ') : body)).toBeTruthy();
  }
  if (details !== undefined) {
    const summary = within(toast).getByText(enUS.common.technicalDetails);
    const block = summary.closest('details')!;
    expect(block.open).toBe(false);
    fireEvent.click(summary);
    expect(block.open).toBe(true);
    expect(within(block).getByText(details)).toBeTruthy();
  }
  return toast;
}
