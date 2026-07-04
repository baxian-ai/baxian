import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  api,
  ApiError,
  UNAUTHORIZED_EVENT,
  clearAuthToken,
  setAuthToken,
} from '../api.ts';

type GateState =
  | { kind: 'probing' }
  | { kind: 'authorized' }
  | { kind: 'unauthorized'; message?: string }
  | { kind: 'error'; message: string };

interface Props {
  children: ReactNode;
}

export function AuthGate({ children }: Props) {
  const [state, setState] = useState<GateState>({ kind: 'probing' });
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);

  const probe = useCallback(async () => {
    setState({ kind: 'probing' });
    try {
      await api.config.get();
      setState({ kind: 'authorized' });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setState({ kind: 'unauthorized' });
        return;
      }
      const message = e instanceof Error ? e.message : '无法连接服务器';
      setState({ kind: 'error', message });
    }
  }, []);

  useEffect(() => { void probe(); }, [probe]);

  useEffect(() => {
    const onUnauthorized = () => {
      if (stateRef.current.kind === 'probing') return;
      setState({ kind: 'unauthorized', message: '登录已失效，请重新输入令牌' });
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  if (state.kind === 'authorized') return <>{children}</>;

  if (state.kind === 'error') {
    return (
      <CenteredCard title="无法连接服务器">
        <p className="text-sm text-og-600">{state.message}</p>
        <button type="button" onClick={() => { void probe(); }} className="btn-primary mt-4 w-full">
          重试
        </button>
      </CenteredCard>
    );
  }

  if (state.kind === 'probing') {
    return (
      <CenteredCard title="加载中">
        <p className="text-sm text-og-500">正在检查登录状态…</p>
      </CenteredCard>
    );
  }

  return (
    <LoginForm
      message={state.message}
      onSubmit={async (token) => {
        setAuthToken(token);
        try {
          await api.config.get();
          setState({ kind: 'authorized' });
        } catch (e) {
          clearAuthToken();
          if (e instanceof ApiError && e.status === 401) {
            setState({ kind: 'unauthorized', message: '令牌无效，请重试' });
            return;
          }
          const message = e instanceof Error ? e.message : '登录失败';
          setState({ kind: 'error', message });
        }
      }}
    />
  );
}

function CenteredCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-page px-4">
      <div className="w-full max-w-sm rounded-lg border border-hairline bg-surface px-6 py-6">
        <h1 className="mb-3 font-display text-sm font-semibold tracking-tight text-og-1000">{title}</h1>
        {children}
      </div>
    </div>
  );
}

function LoginForm({
  message,
  onSubmit,
}: {
  message?: string;
  onSubmit: (token: string) => void | Promise<void>;
}) {
  const [token, setToken] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | undefined>(undefined);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = token.trim();
    if (!trimmed) {
      setLocalError('请输入访问令牌');
      return;
    }
    setLocalError(undefined);
    setSubmitting(true);
    try {
      await onSubmit(trimmed);
    } finally {
      setSubmitting(false);
    }
  };

  const displayError = localError ?? message;

  return (
    <CenteredCard title="登录 baxian">
      <p className="mb-4 text-sm text-og-600">服务器开启了访问鉴权，请输入访问令牌继续。</p>
      <form onSubmit={(e) => { void handleSubmit(e); }}>
        <label className="mb-1.5 block text-xs font-medium text-og-700" htmlFor="baxian-token">
          访问令牌
        </label>
        <input
          id="baxian-token"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={token}
          onChange={(e) => setToken(e.target.value)}
          className="w-full rounded-md border border-og-100 bg-surface px-2.5 py-1.5 font-mono text-sm text-og-800 placeholder:text-og-400 focus:border-accent focus:outline-none focus:ring-[3px] focus:ring-accent-soft disabled:cursor-not-allowed disabled:opacity-50"
          placeholder="请输入服务器配置的 token"
          disabled={submitting}
        />
        {displayError && (
          <p role="alert" className="mt-2 text-xs text-accent">{displayError}</p>
        )}
        <button type="submit" disabled={submitting} className="btn-primary mt-4 w-full">
          {submitting ? '登录中…' : '登录'}
        </button>
      </form>
    </CenteredCard>
  );
}
