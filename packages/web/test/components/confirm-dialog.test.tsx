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
          void confirm({ title: '删除这一项？', body, confirmLabel }).then(ok => setResult(ok ? 'yes' : 'no'));
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
    renderHarness({ body: '此操作不可撤销。' });
    expect(screen.getByText('删除这一项？')).toBeTruthy();
    expect(screen.getByText('此操作不可撤销。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    await screen.findByText('yes');
    expect(screen.queryByText('删除这一项？')).toBeNull();
  });

  it('resolves false on cancel and on Escape', async () => {
    renderHarness();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await screen.findByText('no');

    fireEvent.click(screen.getByRole('button', { name: 'trigger' }));
    expect(screen.getByText('删除这一项？')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    await screen.findByText('no');
    expect(screen.queryByText('删除这一项？')).toBeNull();
  });

  it('uses a custom confirm label and initial focus stays on the safe side (close button)', async () => {
    renderHarness({ confirmLabel: '删除' });
    expect((document.activeElement as HTMLElement | null)?.getAttribute('aria-label')).toBe('关闭');
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    await screen.findByText('yes');
  });
});

function NestedHost() {
  const confirm = useConfirm();
  const [outcome, setOutcome] = useState('');
  return (
    <Modal open title="外层弹窗" onClose={() => setOutcome('outer-closed')}>
      <button
        type="button"
        onClick={() => { void confirm({ title: '内层确认？' }).then(ok => setOutcome(ok ? 'inner-yes' : 'inner-no')); }}
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
    expect(screen.getByText('内层确认？')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    await screen.findByText('inner-no');
    expect(screen.queryByText('内层确认？')).toBeNull();
    expect(screen.getByText('外层弹窗')).toBeTruthy();
    expect(screen.queryByText('outer-closed')).toBeNull();
  });
});
