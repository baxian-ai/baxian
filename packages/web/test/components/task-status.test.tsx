import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { TaskState } from '../../src/shared/index.js';
import {
  TaskStatusBadge,
  formatTaskTimestamp,
  getTaskAttentionCopy,
  shortTaskId,
  taskDetailPath,
  taskStatusLabel,
} from '../../src/components/task-status.tsx';
import { __resetI18nForTests, getMessages, syncLocaleFromConfig } from '../../src/i18n/index.tsx';

afterEach(() => cleanup());
afterEach(() => __resetI18nForTests());

function attention(
  reason: string,
  recommendedActions: NonNullable<TaskState['attention']>['recommendedActions'],
): NonNullable<TaskState['attention']> {
  return {
    reason,
    runbook: 'Inspect the task.',
    occurredAt: '2026-05-10T12:00:00.000Z',
    recommendedActions,
  };
}

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
  it('returns the English label by default (no I18nProvider / default locale)', () => {
    expect(taskStatusLabel('pending')).toBe('Waiting to start');
  });

  it('returns the Chinese label after syncLocaleFromConfig switches locale to zh-CN', () => {
    syncLocaleFromConfig('zh-CN');
    expect(taskStatusLabel('pending')).toBe('待开始');
  });

  it('uses phase and assignment context to describe what is happening', () => {
    expect(taskStatusLabel({ status: 'pending', preferredAgentId: '' })).toBe('Unassigned');
    expect(taskStatusLabel({ status: 'in_progress', phase: 'spec' })).toBe('Drafting plan');
    expect(taskStatusLabel({ status: 'in_progress', phase: 'code' })).toBe('Developing');
    expect(taskStatusLabel({ status: 'review', phase: 'code' })).toBe('Reviewing code');
    expect(taskStatusLabel({ status: 'fixing', phase: 'spec' })).toBe('Revising plan');
    expect(taskStatusLabel({ status: 'max_rounds', phase: 'code' })).toBe('Code review needs a decision');
  });
});

describe('TaskStatusBadge', () => {
  it('shows a readable contextual pill while preserving the machine status as data', () => {
    render(<TaskStatusBadge task={{ status: 'review', phase: 'spec' }} />);
    const badge = screen.getByText('Reviewing plan');
    expect(badge.className).toContain('pill-review');
    expect(badge.getAttribute('data-status')).toBe('review');
    expect(badge.getAttribute('title')).toBe('Reviewing plan');
  });
});

describe('getTaskAttentionCopy', () => {
  it.each([
    ['confirm-merge-timeout', 'The final checks could not finish'],
    ['review-verdict-overdue', 'Review needs your attention'],
    ['runtime-session-missing', 'The linked agent was interrupted'],
    ['delivery-not-confirmed', 'The next step did not start'],
    ['unexpected-condition', 'This task needs your attention'],
  ])('maps %s to a user-facing title', (reason, title) => {
    expect(getTaskAttentionCopy(getMessages(), attention(reason, ['cancel'])).title).toBe(title);
  });

  it('selects guidance by recommended-action priority and has retry/cancel fallbacks', () => {
    expect(getTaskAttentionCopy(getMessages(), attention('unknown', ['retry', 'advance', 'verdict'])).guidance)
      .toBe('Review the PR and the discussion below, then confirm the result or request changes.');
    expect(getTaskAttentionCopy(getMessages(), attention('unknown', ['retry'])).guidance)
      .toBe('This task cannot continue in its current run. Run it again from the beginning when you are ready.');
    expect(getTaskAttentionCopy(getMessages(), attention('unknown', ['cancel'])).guidance)
      .toBe('Review the task details, then cancel it if you no longer want it to continue.');
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
