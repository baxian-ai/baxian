import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/components/pr-review-entry.tsx', () => ({
  PrReviewEntry: () => <div>PR review entry</div>,
}));

import { ReviewConversation } from '../../src/components/review-conversation.tsx';
import { makeTask } from '../helpers/fixtures.ts';

describe('ReviewConversation', () => {
  it('renders the PR conversation for a task with a PR', () => {
    render(<ReviewConversation task={makeTask({ prNumber: 42 })} />);

    expect(screen.getByRole('region', { name: 'Review records' })).toBeTruthy();
    expect(screen.getByText('PR review entry')).toBeTruthy();
  });

  it('renders nothing before a PR exists', () => {
    const { container } = render(<ReviewConversation task={makeTask({ prNumber: undefined })} />);

    expect(container.firstChild).toBeNull();
  });
});
