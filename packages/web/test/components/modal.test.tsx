import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState, type FormEvent } from 'react';
import { Modal } from '../../src/components/modal.tsx';

describe('Modal', () => {
  it('autofocuses the first focusable element on open (the close button)', () => {
    render(
      <Modal open onClose={() => {}} title="t">
        <input data-testid="input-1" />
        <input data-testid="input-2" />
      </Modal>,
    );
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
  });

  it('does not steal focus when parent re-renders with a fresh inline onClose', () => {
    function Parent() {
      const [tick, setTick] = useState(0);
      return (
        <>
          <button data-testid="bump" onClick={() => setTick(t => t + 1)}>
            bump {tick}
          </button>
          <Modal open onClose={() => {}} title="t">
            <input data-testid="input-1" />
            <input data-testid="input-2" />
          </Modal>
        </>
      );
    }
    render(<Parent />);
    const second = screen.getByTestId('input-2');
    second.focus();
    expect(document.activeElement).toBe(second);
    fireEvent.click(screen.getByTestId('bump'));
    expect(document.activeElement).toBe(second);
  });

  it('Escape calls the latest onClose even if it changed since open', () => {
    function Parent({ handler }: { handler: () => void }) {
      return (
        <Modal open onClose={handler} title="t">
          <input />
        </Modal>
      );
    }
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Parent handler={first} />);
    rerender(<Parent handler={second} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('overlay click and ✕ button call the latest onClose', () => {
    const handler = vi.fn();
    render(
      <Modal open onClose={handler} title="t">
        <input />
      </Modal>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('closes on a genuine backdrop click (press and release on the backdrop itself)', () => {
    const handler = vi.fn();
    render(
      <Modal open onClose={handler} title="t">
        <input data-testid="field" />
      </Modal>,
    );
    const backdrop = screen.getByRole('presentation');
    fireEvent.mouseDown(backdrop);
    fireEvent.click(backdrop);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not close when a text selection starts inside the content and the mouse is released on the backdrop', () => {
    const handler = vi.fn();
    render(
      <Modal open onClose={handler} title="t">
        <input data-testid="field" />
      </Modal>,
    );
    fireEvent.mouseDown(screen.getByTestId('field'));
    fireEvent.click(screen.getByRole('presentation'));
    expect(handler).not.toHaveBeenCalled();
  });

  it('dismissOnBackdrop=false makes the backdrop click a no-op so a half-typed draft is not lost to a stray click outside the content box', () => {
    const handler = vi.fn();
    render(
      <Modal open onClose={handler} title="t" dismissOnBackdrop={false}>
        <input />
      </Modal>,
    );
    const backdrop = screen.getByRole('presentation');
    fireEvent.click(backdrop);
    expect(handler).not.toHaveBeenCalled();
  });

  it('dismissOnBackdrop=false still lets Escape close (deliberate keystroke) and the ✕ button still closes', () => {
    const handler = vi.fn();
    render(
      <Modal open onClose={handler} title="t" dismissOnBackdrop={false}>
        <input />
      </Modal>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(handler).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('caps height to the dynamic viewport (max-h-[90dvh]) so a tall modal stays usable on mobile', () => {
    render(
      <Modal open onClose={() => {}} title="t">
        <input />
      </Modal>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('max-h-[90dvh]');
    expect(dialog.className).not.toContain('max-h-[90vh]');
  });

  it('exposes the full title via a title attribute so a truncated long header stays readable on hover', () => {
    const long = 'A very long modal title that will be visually truncated by the truncate class';
    render(
      <Modal open onClose={() => {}} title={long}>
        <input />
      </Modal>,
    );
    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading.className).toContain('truncate');
    expect(heading.getAttribute('title')).toBe(long);
  });

  it('can render structured title content while preserving the plain title for dialog labeling', () => {
    render(
      <Modal
        open
        onClose={() => {}}
        title="task-010 Clean tests"
        titleContent={<><span className="text-og-400">task-010</span> <span>Clean tests</span></>}
      >
        <input />
      </Modal>,
    );

    expect(screen.getByRole('dialog', { name: 'task-010 Clean tests' })).toBeTruthy();
    const id = screen.getByText('task-010');
    expect(id.className).toContain('text-og-400');
    expect(screen.getByRole('heading', { level: 2 }).getAttribute('title')).toBe('task-010 Clean tests');
  });

  it('renders the footer in a pinned region (border-separated, non-scrolling) so action buttons never scroll away', () => {
    render(
      <Modal open onClose={() => {}} title="t" footer={<button>Save</button>}>
        <input />
      </Modal>,
    );
    const footerBtn = screen.getByRole('button', { name: 'Save' });
    const region = footerBtn.parentElement!;
    expect(region.className).toContain('border-t');
    expect(region.className).toContain('shrink-0');
    expect(region.className).not.toContain('overflow-auto');
  });

  it('renders no footer region when footer is omitted', () => {
    render(
      <Modal open onClose={() => {}} title="t">
        <input data-testid="body-input" />
      </Modal>,
    );
    expect(screen.getByRole('dialog').querySelector('.border-t')).toBeNull();
  });

  it('a footer submit button associated via form= submits the body form across the body/footer split', () => {
    const onSubmit = vi.fn((e: FormEvent) => e.preventDefault());
    render(
      <Modal
        open
        onClose={() => {}}
        title="t"
        footer={<button type="submit" form="modal-form">Save</button>}
      >
        <form id="modal-form" onSubmit={onSubmit}>
          <input aria-label="field" />
        </form>
      </Modal>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('Tab with no visible focusable element inside is swallowed so focus cannot escape the dialog', () => {
    render(
      <Modal open onClose={() => {}} title="t">
        <p>read-only body</p>
      </Modal>,
    );
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);

    const notCancelled = fireEvent.keyDown(document, { key: 'Tab' });
    expect(notCancelled).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });
});

describe('Modal focus trap (visible elements)', () => {
  // jsdom 不做布局，offsetParent 恒为 null；垫一个 getter 让可见性过滤通过
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent');
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
      configurable: true,
      get(this: HTMLElement) { return this.parentElement; },
    });
  });
  afterAll(() => {
    if (original) Object.defineProperty(HTMLElement.prototype, 'offsetParent', original);
    else Reflect.deleteProperty(HTMLElement.prototype, 'offsetParent');
  });

  function renderTrap() {
    render(
      <Modal open onClose={() => {}} title="t">
        <input data-testid="input-1" />
        <input data-testid="input-2" />
      </Modal>,
    );
    return {
      closeBtn: screen.getByRole('button', { name: 'Close' }),
      lastInput: screen.getByTestId('input-2'),
    };
  }

  it('Tab on the last focusable wraps to the first (the close button in header order)', () => {
    const { closeBtn, lastInput } = renderTrap();
    lastInput.focus();
    const notCancelled = fireEvent.keyDown(document, { key: 'Tab' });
    expect(notCancelled).toBe(false);
    expect(document.activeElement).toBe(closeBtn);
  });

  it('Shift+Tab on the first focusable wraps to the last', () => {
    const { closeBtn, lastInput } = renderTrap();
    closeBtn.focus();
    const notCancelled = fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(notCancelled).toBe(false);
    expect(document.activeElement).toBe(lastInput);
  });

  it('Tab pressed while focus sits outside the dialog pulls focus back to the first focusable', () => {
    const { closeBtn } = renderTrap();
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(closeBtn);
  });

  it('Shift+Tab pressed while focus sits outside the dialog pulls focus back to the last focusable', () => {
    const { lastInput } = renderTrap();
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(lastInput);
  });

  it('Tab between interior focusables is left to the browser (not swallowed by the trap)', () => {
    const { closeBtn } = renderTrap();
    closeBtn.focus();
    const notCancelled = fireEvent.keyDown(document, { key: 'Tab' });
    expect(notCancelled).toBe(true);
  });
});
