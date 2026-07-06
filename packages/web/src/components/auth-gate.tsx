import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  api,
  ApiError,
  UNAUTHORIZED_EVENT,
  clearAuthToken,
  setAuthToken,
} from '../api.ts';
import { useT, syncLocaleFromConfig } from '../i18n/index.tsx';
import { inputCls, labelCls } from './form-styles.ts';

type GateState =
  | { kind: 'probing' }
  | { kind: 'authorized' }
  | { kind: 'unauthorized'; reason?: 'expired' | 'invalid' }
  | { kind: 'error'; message?: string; fallback: 'connectFallback' | 'loginFailed' };

interface Props {
  children: ReactNode;
}

export function AuthGate({ children }: Props) {
  const t = useT();
  const [state, setState] = useState<GateState>({ kind: 'probing' });
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);

  const probe = useCallback(async () => {
    setState({ kind: 'probing' });
    try {
      const cfg = await api.config.get();
      syncLocaleFromConfig(cfg.language);
      setState({ kind: 'authorized' });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setState({ kind: 'unauthorized' });
        return;
      }
      setState({ kind: 'error', message: e instanceof Error ? e.message : undefined, fallback: 'connectFallback' });
    }
  }, []);

  useEffect(() => { void probe(); }, [probe]);

  useEffect(() => {
    const onUnauthorized = () => {
      if (stateRef.current.kind === 'probing') return;
      setState({ kind: 'unauthorized', reason: 'expired' });
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  if (state.kind === 'authorized') return <>{children}</>;

  if (state.kind === 'error') {
    return (
      <CenteredCard title={t.auth.connectFailedTitle}>
        <p className="text-sm text-og-600">{state.message ?? t.auth[state.fallback]}</p>
        <button type="button" onClick={() => { void probe(); }} className="btn-primary mt-4 w-full">
          {t.common.retry}
        </button>
      </CenteredCard>
    );
  }

  if (state.kind === 'probing') {
    return (
      <CenteredCard title={t.auth.checkingTitle}>
        <p className="text-sm text-og-500">{t.auth.checkingBody}</p>
      </CenteredCard>
    );
  }

  const unauthorizedMessage =
    state.reason === 'expired' ? t.auth.sessionExpired
    : state.reason === 'invalid' ? t.auth.tokenInvalid
    : undefined;

  return (
    <LoginForm
      message={unauthorizedMessage}
      onSubmit={async (token) => {
        setAuthToken(token);
        try {
          const cfg = await api.config.get();
          syncLocaleFromConfig(cfg.language);
          setState({ kind: 'authorized' });
        } catch (e) {
          clearAuthToken();
          if (e instanceof ApiError && e.status === 401) {
            setState({ kind: 'unauthorized', reason: 'invalid' });
            return;
          }
          setState({ kind: 'error', message: e instanceof Error ? e.message : undefined, fallback: 'loginFailed' });
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
  const t = useT();
  const [token, setToken] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | undefined>(undefined);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = token.trim();
    if (!trimmed) {
      setLocalError(t.auth.tokenRequired);
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
    <CenteredCard title={t.auth.loginTitle}>
      <p className="mb-4 text-sm text-og-600">{t.auth.loginDescription}</p>
      <form onSubmit={(e) => { void handleSubmit(e); }}>
        <label className={labelCls} htmlFor="baxian-token">
          {t.auth.tokenLabel}
        </label>
        <input
          id="baxian-token"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={token}
          onChange={(e) => setToken(e.target.value)}
          className={`${inputCls} font-mono`}
          placeholder={t.auth.tokenPlaceholder}
          disabled={submitting}
        />
        {displayError && (
          <p role="alert" className="mt-2 text-xs text-accent">{displayError}</p>
        )}
        <button type="submit" disabled={submitting} className="btn-primary mt-4 w-full">
          {submitting ? t.auth.submitting : t.auth.submit}
        </button>
      </form>
    </CenteredCard>
  );
}
