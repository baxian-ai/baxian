import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { TaskStatus } from '../../src/shared/index.js';
import {
  TaskStatusDot,
  formatTaskTimestamp,
  shortTaskId,
  taskDetailPath,
} from '../../src/components/task-status.tsx';

afterEach(() => cleanup());

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

describe('TaskStatusDot', () => {
  it('renders an img-role dot whose label and title are the status (hover text)', () => {
    render(<TaskStatusDot status="review" />);
    const dot = screen.getByRole('img', { name: 'review' });
    expect(dot.getAttribute('title')).toBe('review');
    expect(dot.className).toContain('rounded-full');
  });

  it('maps every status to a color, sharing one color across same-semantic statuses', () => {
    const cases: Array<[Parameters<typeof TaskStatusDot>[0]['status'], string]> = [
      ['pending', 'bg-og-300'],
      ['cancelled', 'bg-og-300'],
      ['in_progress', 'bg-success'],
      ['approved', 'bg-success'],
      ['merge-ready', 'bg-success'],
      ['merged', 'bg-success'],
      ['review', 'bg-accent'],
      ['fixing', 'bg-warn'],
      ['failed', 'bg-warn'],
      ['max_rounds', 'bg-warn'],
    ];
    for (const [status, cls] of cases) {
      cleanup();
      render(<TaskStatusDot status={status} />);
      expect(screen.getByRole('img', { name: status }).className).toContain(cls);
    }
  });

  it('falls back to a visible grey dot for an unknown status (still labeled via hover)', () => {
    render(<TaskStatusDot status={'whatever' as TaskStatus} />);
    const dot = screen.getByRole('img', { name: 'whatever' });
    expect(dot.className).toContain('bg-og-300');
    expect(dot.getAttribute('title')).toBe('whatever');
  });
});

describe('formatTaskTimestamp', () => {
  it('keeps date + time and pads missing seconds without timezone conversion', () => {
    expect(formatTaskTimestamp('2026-05-10T13:00+08:00')).toBe('2026-05-10 13:00:00');
    expect(formatTaskTimestamp('2026-05-10 14:30:45')).toBe('2026-05-10 14:30:45');
  });

  it('returns "" for null/undefined/blank values', () => {
    expect(formatTaskTimestamp(null)).toBe('');
    expect(formatTaskTimestamp(undefined)).toBe('');
    expect(formatTaskTimestamp('   ')).toBe('');
  });

  it('falls back to the raw string when it is not a parseable date', () => {
    expect(formatTaskTimestamp('not-a-date')).toBe('not-a-date');
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
