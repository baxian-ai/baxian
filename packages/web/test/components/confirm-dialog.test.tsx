import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { ConfirmProvider, useConfirm } from '../../src/components/confirm-dialog.tsx';
import { Modal } from '../../src/components/modal.tsx';

afterEach(cleanup);

function Harness({ body, confirmLabel }: { body?: string; confirmLabel?: string }) {
  const confirm = useConfirm();
  const [result, setResult] = useState('');
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          void confirm({ title: 'Delete this item?', body, confirmLabel }).then(ok => setResult(ok ? 'yes' : 'no'));
        }}
      >
        trigger
      </button>
      <output>{result}</output>
    </div>
  );
}

function renderHarness(props: Parameters<typeof Harness>[0] = {}) {
  render(
    <ConfirmProvider>
      <Harness {...props} />
    </ConfirmProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'trigger' }));
}

describe('ConfirmProvider / useConfirm', () => {
  it('opens a dialog with the title and resolves true on confirm', async () => {
    renderHarness({ body: 'This action cannot be undone.' });
    expect(screen.getByText('Delete this item?')).toBeTruthy();
    expect(screen.getByText('This action cannot be undone.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await screen.findByText('yes');
    expect(screen.queryByText('Delete this item?')).toBeNull();
  });

  it('resolves false on cancel and on Escape', async () => {
    renderHarness();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await screen.findByText('no');

    fireEvent.click(screen.getByRole('button', { name: 'trigger' }));
    expect(screen.getByText('Delete this item?')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    await screen.findByText('no');
    expect(screen.queryByText('Delete this item?')).toBeNull();
  });

  it('uses a custom confirm label and initial focus stays on the safe side (close button)', async () => {
    renderHarness({ confirmLabel: 'Delete' });
    expect((document.activeElement as HTMLElement | null)?.getAttribute('aria-label')).toBe('Close');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await screen.findByText('yes');
  });
});

function NestedHost() {
  const confirm = useConfirm();
  const [outcome, setOutcome] = useState('');
  return (
    <Modal open title="Outer modal" onClose={() => setOutcome('outer-closed')}>
      <button
        type="button"
        onClick={() => { void confirm({ title: 'Inner confirm?' }).then(ok => setOutcome(ok ? 'inner-yes' : 'inner-no')); }}
      >
        open-inner
      </button>
      <output>{outcome}</output>
    </Modal>
  );
}

describe('nested modal stack', () => {
  it('Escape only closes the top-most dialog, not the modal underneath', async () => {
    render(
      <ConfirmProvider>
        <NestedHost />
      </ConfirmProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'open-inner' }));
    expect(screen.getByText('Inner confirm?')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    await screen.findByText('inner-no');
    expect(screen.queryByText('Inner confirm?')).toBeNull();
    expect(screen.getByText('Outer modal')).toBeTruthy();
    expect(screen.queryByText('outer-closed')).toBeNull();
  });
});
