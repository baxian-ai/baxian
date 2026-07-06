import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import {
  I18nProvider,
  useT,
  useI18n,
  useLocaleConfigSync,
  getMessages,
  getLocale,
  syncLocaleFromConfig,
  __resetI18nForTests,
} from '../../src/i18n/index.tsx';
import type { BaxianConfig, SupportedLanguage } from '../../src/shared/index.js';

function cfg(language: SupportedLanguage): BaxianConfig {
  return { language, review: { rounds: 3 }, server: { port: 0 }, host: [], project: [] };
}

vi.mock('../../src/api.ts', () => ({
  api: {
    config: {
      get: vi.fn().mockResolvedValue({ language: 'en-US' }),
      patch: vi.fn().mockResolvedValue({ config: {}, restartRequired: false, note: '' }),
    },
  },
}));
import { api } from '../../src/api.ts';

afterEach(() => {
  cleanup();
  __resetI18nForTests();
  vi.mocked(api.config.patch).mockClear();
  vi.mocked(api.config.get).mockClear();
});

function Probe() {
  const t = useT();
  return <div>{t.settings.entry}</div>;
}

describe('useT', () => {
  it('renders English without any provider (default context)', () => {
    render(<Probe />);
    expect(screen.getByText('Settings')).toBeTruthy();
  });

  it('follows the locale synced from config inside the provider', () => {
    syncLocaleFromConfig('zh-CN');
    render(<I18nProvider><Probe /></I18nProvider>);
    expect(screen.getByText('系统设置')).toBeTruthy();
  });

  it('re-renders subscribers when the locale changes after mount', () => {
    render(<I18nProvider><Probe /></I18nProvider>);
    expect(screen.getByText('Settings')).toBeTruthy();
    act(() => syncLocaleFromConfig('zh-CN'));
    expect(screen.getByText('系统设置')).toBeTruthy();
  });
});

describe('syncLocaleFromConfig', () => {
  it('treats undefined as the en-US default', () => {
    syncLocaleFromConfig('zh-CN');
    syncLocaleFromConfig(undefined);
    expect(getLocale()).toBe('en-US');
  });

  it('caches the locale in localStorage', () => {
    syncLocaleFromConfig('zh-CN');
    expect(localStorage.getItem('baxian.language')).toBe('zh-CN');
  });
});

describe('setLocale', () => {
  function SwitchProbe() {
    const { setLocale, locale } = useI18n();
    return <button onClick={() => void setLocale('zh-CN').catch(() => {})}>{locale}</button>;
  }

  it('patches config then switches locale', async () => {
    render(<I18nProvider><SwitchProbe /></I18nProvider>);
    await act(async () => { screen.getByRole('button').click(); });
    expect(api.config.patch).toHaveBeenCalledWith({ language: 'zh-CN' });
    expect(getLocale()).toBe('zh-CN');
  });

  it('keeps the current locale when the PATCH fails', async () => {
    vi.mocked(api.config.patch).mockRejectedValueOnce(new Error('boom'));
    render(<I18nProvider><SwitchProbe /></I18nProvider>);
    await act(async () => { screen.getByRole('button').click(); });
    expect(getLocale()).toBe('en-US');
  });
});

describe('getMessages', () => {
  it('returns the dictionary for the current module-level locale', () => {
    expect(getMessages().settings.entry).toBe('Settings');
    syncLocaleFromConfig('zh-CN');
    expect(getMessages().settings.entry).toBe('系统设置');
  });
});

describe('provider side effects', () => {
  it('keeps <html lang> in sync with the locale', () => {
    render(<I18nProvider><Probe /></I18nProvider>);
    expect(document.documentElement.lang).toBe('en');
    act(() => syncLocaleFromConfig('zh-CN'));
    expect(document.documentElement.lang).toBe('zh-CN');
  });

  it('follows a locale change from another tab via the storage event', () => {
    render(<I18nProvider><Probe /></I18nProvider>);
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'baxian.language', newValue: 'zh-CN' }));
    });
    expect(screen.getByText('系统设置')).toBeTruthy();
  });
});

describe('useLocaleConfigSync', () => {
  function SyncProbe() {
    useLocaleConfigSync();
    return null;
  }

  it('refetches config and syncs the locale on window focus', async () => {
    vi.mocked(api.config.get).mockResolvedValueOnce(cfg('zh-CN'));
    render(<SyncProbe />);

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });

    expect(getLocale()).toBe('zh-CN');
  });

  it('refetches config and syncs the locale when the tab becomes visible', async () => {
    vi.mocked(api.config.get).mockResolvedValueOnce(cfg('zh-CN'));
    render(<SyncProbe />);

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });

    expect(getLocale()).toBe('zh-CN');
  });
});
