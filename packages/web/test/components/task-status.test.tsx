import { describe, it, expect, afterEach } from 'vitest';
import { act, render, cleanup } from '@testing-library/react';
import {
  TaskStatusBadge,
  formatTaskTimestamp,
  shortTaskId,
  taskDetailPath,
  taskStatusLabel,
} from '../../src/components/task-status.tsx';
import { __resetI18nForTests, getMessages, I18nProvider, syncLocaleFromConfig } from '../../src/i18n/index.tsx';

afterEach(() => cleanup());
afterEach(() => __resetI18nForTests());

describe('shortTaskId', () => {
  it('strips the task- prefix down to the number, preserving zero padding', () => {
    expect(shortTaskId('task-001')).toBe('001');
    expect(shortTaskId('task-42')).toBe('42');
  });

  it('leaves ids that are not the canonical task-<number> form untouched', () => {
    expect(shortTaskId('hotfix-x')).toBe('hotfix-x');
    expect(shortTaskId('task-abc')).toBe('task-abc');
    expect(shortTaskId('task-12a')).toBe('task-12a');
    expect(shortTaskId('')).toBe('');
  });

  it('returns "" instead of crashing on malformed (null/undefined) ids', () => {
    expect(shortTaskId(null as unknown as string)).toBe('');
    expect(shortTaskId(undefined as unknown as string)).toBe('');
  });
});

describe('formatTaskTimestamp', () => {
  it('converts UTC timestamps to the local browser timezone', () => {
    expect(formatTaskTimestamp('2026-05-10T12:00:00.000Z')).toBe('2026-05-10 20:00:00');
    expect(formatTaskTimestamp('2026-05-10T13:00+08:00')).toBe('2026-05-10 13:00:00');
  });

  it('keeps a local date-time and pads missing seconds', () => {
    expect(formatTaskTimestamp('2026-05-10 14:30:45')).toBe('2026-05-10 14:30:45');
    expect(formatTaskTimestamp('2026-05-10 14:30')).toBe('2026-05-10 14:30:00');
  });

  it('parses space- and T-separated local datetimes identically (no reliance on engine leniency)', () => {
    expect(formatTaskTimestamp('2026-05-10 14:30')).toBe(formatTaskTimestamp('2026-05-10T14:30'));
    expect(formatTaskTimestamp('2026-05-10 14:30:45')).toBe(formatTaskTimestamp('2026-05-10T14:30:45'));
    expect(formatTaskTimestamp('2026-05-10T14:30')).toBe('2026-05-10 14:30:00');
  });

  it('returns "" for null/undefined/blank values', () => {
    expect(formatTaskTimestamp(null)).toBe('');
    expect(formatTaskTimestamp(undefined)).toBe('');
    expect(formatTaskTimestamp('   ')).toBe('');
  });

  it('falls back to the raw string when it is not a parseable date', () => {
    expect(formatTaskTimestamp('not-a-date')).toBe('not-a-date');
  });

  it('drops seconds down to minute precision when withSeconds is false', () => {
    expect(formatTaskTimestamp('2026-05-10T12:00:45.000Z', false)).toBe('2026-05-10 20:00');
    expect(formatTaskTimestamp('2026-05-10 14:30:45', false)).toBe('2026-05-10 14:30');
    expect(formatTaskTimestamp('2026-05-10 14:30', false)).toBe('2026-05-10 14:30');
  });

  it('still returns "" for empty values regardless of precision', () => {
    expect(formatTaskTimestamp(null, false)).toBe('');
    expect(formatTaskTimestamp('   ', false)).toBe('');
  });
});

describe('taskStatusLabel', () => {
  it('follows the active locale dictionary', () => {
    expect(taskStatusLabel('pending')).toBe(getMessages().status.pending);
    const english = taskStatusLabel('pending');
    syncLocaleFromConfig('zh-CN');
    expect(taskStatusLabel('pending')).toBe(getMessages().status.pending);
    expect(taskStatusLabel('pending')).not.toBe(english);
  });
});

describe('TaskStatusBadge', () => {
  it('updates the mounted badge when the language changes', () => {
    const { container } = render(<I18nProvider><TaskStatusBadge task={{ status: 'pending' }} /></I18nProvider>);
    const badge = container.querySelector('[data-status="pending"]')!;
    const english = badge.textContent;

    act(() => syncLocaleFromConfig('zh-CN'));

    expect(badge.textContent).toBe(taskStatusLabel('pending'));
    expect(badge.textContent).not.toBe(english);
  });
});

describe('taskDetailPath', () => {
  it('builds the canonical /project/<id>/task/<taskId> route', () => {
    expect(taskDetailPath('baxian', 'task-172')).toBe('/project/baxian/task/task-172');
  });

  it('encodes path segments to stay URL-safe', () => {
    expect(taskDetailPath('my proj', 'task/odd')).toBe('/project/my%20proj/task/task%2Fodd');
  });
});
