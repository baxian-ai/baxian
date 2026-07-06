import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { TerminalKeyPad } from '../../src/components/terminal-key-pad.tsx';

describe('TerminalKeyPad', () => {
  it('renders four arrow buttons with accessible labels', () => {
    render(<TerminalKeyPad onKey={() => undefined} />);
    expect(screen.getByRole('group', { name: /Terminal keys/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Arrow key up/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Arrow key down/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Arrow key left/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Arrow key right/ })).toBeTruthy();
  });

  it('emits the semantic arrow key per button (PaneTerminal owns the CSI/SS3 encoding so DECCKM is honored)', () => {
    const onKey = vi.fn();
    render(<TerminalKeyPad onKey={onKey} />);
    fireEvent.click(screen.getByRole('button', { name: /Arrow key up/ }));
    fireEvent.click(screen.getByRole('button', { name: /Arrow key down/ }));
    fireEvent.click(screen.getByRole('button', { name: /Arrow key left/ }));
    fireEvent.click(screen.getByRole('button', { name: /Arrow key right/ }));
    expect(onKey.mock.calls.map((c) => c[0])).toEqual(['up', 'down', 'left', 'right']);
  });

  it('prevents default on mousedown so the terminal keeps focus', () => {
    render(<TerminalKeyPad onKey={() => undefined} />);
    const button = screen.getByRole('button', { name: /Arrow key up/ });
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    const defaultPrevented = !button.dispatchEvent(event);
    expect(defaultPrevented).toBe(true);
  });

  it('lays out the four arrows in a single row in the documented DOM order', () => {
    render(<TerminalKeyPad onKey={() => undefined} />);
    const group = screen.getByRole('group', { name: /Terminal keys/ });
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(4);
    for (const button of buttons) {
      expect(button.parentElement).toBe(group);
    }
    expect(buttons.map((b) => b.getAttribute('data-arrow'))).toEqual([
      'left',
      'up',
      'down',
      'right',
    ]);
  });

  it('hides the Esc button unless onEscape is provided', () => {
    render(<TerminalKeyPad onKey={() => undefined} />);
    expect(screen.queryByRole('button', { name: /Esc key/ })).toBeNull();
  });

  it('renders the Esc button first and emits onEscape on click', () => {
    const onKey = vi.fn();
    const onEscape = vi.fn();
    render(<TerminalKeyPad onKey={onKey} onEscape={onEscape} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(5);
    expect(buttons[0].getAttribute('data-key')).toBe('escape');
    fireEvent.click(screen.getByRole('button', { name: /Esc key/ }));
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(onKey).not.toHaveBeenCalled();
  });

  it('prevents default on Esc mousedown so the terminal keeps focus', () => {
    render(<TerminalKeyPad onKey={() => undefined} onEscape={() => undefined} />);
    const button = screen.getByRole('button', { name: /Esc key/ });
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    const defaultPrevented = !button.dispatchEvent(event);
    expect(defaultPrevented).toBe(true);
  });
});
