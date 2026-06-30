import { describe, it, expect } from 'vitest';
import { sanitizeWebInput } from '../../src/terminal/key-sanitizer.js';

const PFX = '\x02';

describe('sanitizeWebInput', () => {
  it('passes plain text through unchanged', () => {
    expect(sanitizeWebInput('hello world')).toBe('hello world');
  });

  it('passes the empty string through', () => {
    expect(sanitizeWebInput('')).toBe('');
  });

  it('strips a stray prefix byte (length-1 message — xterm.js emits these per keystroke)', () => {
    expect(sanitizeWebInput(PFX)).toBe('');
  });

  it('strips a prefix even when the follow-up key arrives in a separate message', () => {
    expect(sanitizeWebInput(PFX)).toBe('');
    expect(sanitizeWebInput('d')).toBe('d');
  });

  it.each([
    ['d', 'detach-client'],
    ['D', 'choose-client'],
    ['s', 'choose-tree (sessions)'],
    ['w', 'choose-tree -Zw'],
    ['(', 'switch-client -p'],
    [')', 'switch-client -n'],
    ['L', 'switch-client -l (last session)'],
    [':', 'command-prompt — could run arbitrary tmux commands'],
    ['c', 'new-window'],
    ['n', 'next-window'],
    ['p', 'previous-window'],
    [',', 'rename-window'],
    ['.', 'move-window'],
    ['<', 'display-menu'],
    ['&', 'kill-window'],
    ['[', 'copy-mode entry — even safe keys lose their prefix to keep policy uniform'],
  ])('strips C-b %s (%s) — chunk-merged form', (key) => {
    expect(sanitizeWebInput(PFX + key)).toBe(key);
  });

  it('strips embedded prefix bytes from a longer chunk', () => {
    expect(sanitizeWebInput(`hello${PFX}dworld`)).toBe('hellodworld');
  });

  it('strips multiple prefix bytes in one chunk', () => {
    expect(sanitizeWebInput(`a${PFX}d${PFX}sb${PFX}wc`)).toBe('adsbwc');
  });

  it('preserves SGR mouse-event sequences (CSI <Pb;Px;Py M) verbatim', () => {
    const wheelUp = '\x1b[<64;42;7M';
    expect(sanitizeWebInput(wheelUp)).toBe(wheelUp);
  });

  it('preserves arrow-key sequences and other ESC-prefixed input', () => {
    expect(sanitizeWebInput('\x1b[A')).toBe('\x1b[A');
    expect(sanitizeWebInput('\x1b[B')).toBe('\x1b[B');
  });
});
