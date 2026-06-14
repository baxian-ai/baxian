import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { AuthGate } from '../../src/components/auth-gate.tsx';
import { UNAUTHORIZED_EVENT } from '../../src/api.ts';

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type FetchSpy = ReturnType<typeof vi.fn>;

function installFetch(spy: FetchSpy) {
  vi.stubGlobal('fetch', spy);
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AuthGate', () => {
  it('renders children when initial probe succeeds', async () => {
    const fetchSpy: FetchSpy = vi.fn(async () => jsonResponse(200, { ok: true }));
    installFetch(fetchSpy);

    render(<AuthGate><div data-testid="app">app-loaded</div></AuthGate>);

    await waitFor(() => expect(screen.queryByTestId('app')).not.toBeNull());
    expect(fetchSpy).toHaveBeenCalledWith('/api/config', expect.any(Object));
  });

  it('shows login form when initial probe returns 401', async () => {
    const fetchSpy: FetchSpy = vi.fn(async () => jsonResponse(401, { error: 'Unauthorized' }));
    installFetch(fetchSpy);

    render(<AuthGate><div data-testid="app">app</div></AuthGate>);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '登录' })).toBeTruthy();
    });
    expect(screen.queryByTestId('app')).toBeNull();
    expect(screen.getByLabelText('访问令牌')).toBeTruthy();
  });

  it('blocks submit with empty token and shows inline validation', async () => {
    installFetch(vi.fn(async () => jsonResponse(401)));

    render(<AuthGate><div /></AuthGate>);
    const submit = await screen.findByRole('button', { name: '登录' });

    fireEvent.click(submit);

    expect(await screen.findByText('请输入访问令牌')).toBeTruthy();
  });

  it('saves token on successful login and renders children', async () => {
    let callCount = 0;
    const fetchSpy: FetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      callCount += 1;
      if (callCount === 1) return jsonResponse(401);
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      return auth === 'Bearer good-token' ? jsonResponse(200, {}) : jsonResponse(401);
    });
    installFetch(fetchSpy);

    render(<AuthGate><div data-testid="app">app</div></AuthGate>);
    const input = await screen.findByLabelText('访问令牌');

    fireEvent.change(input, { target: { value: 'good-token' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    await waitFor(() => expect(screen.queryByTestId('app')).not.toBeNull());
    expect(localStorage.getItem('baxian.token')).toBe('good-token');
  });

  it('clears token and shows error when submitted token is rejected as 401', async () => {
    installFetch(vi.fn(async () => jsonResponse(401)));

    render(<AuthGate><div /></AuthGate>);
    const input = await screen.findByLabelText('访问令牌');
    fireEvent.change(input, { target: { value: 'bad-token' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    await waitFor(() => expect(screen.getByText('令牌无效，请重试')).toBeTruthy());
    expect(localStorage.getItem('baxian.token')).toBeNull();
  });

  it('shows retry card on network error and recovers on retry', async () => {
    let mode: 'fail' | 'ok' = 'fail';
    const fetchSpy: FetchSpy = vi.fn(async () => {
      if (mode === 'fail') throw new TypeError('network down');
      return jsonResponse(200, {});
    });
    installFetch(fetchSpy);

    render(<AuthGate><div data-testid="app">app</div></AuthGate>);
    const retry = await screen.findByRole('button', { name: '重试' });
    expect(screen.getByText('network down')).toBeTruthy();

    mode = 'ok';
    fireEvent.click(retry);

    await waitFor(() => expect(screen.queryByTestId('app')).not.toBeNull());
  });

  it('flips back to login when global unauthorized event fires after login', async () => {
    installFetch(vi.fn(async () => jsonResponse(200, {})));

    render(<AuthGate><div data-testid="app">app</div></AuthGate>);
    await waitFor(() => expect(screen.queryByTestId('app')).not.toBeNull());

    act(() => {
      window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    });

    expect(await screen.findByText('登录已失效，请重新输入令牌')).toBeTruthy();
    expect(screen.queryByTestId('app')).toBeNull();
  });
});
