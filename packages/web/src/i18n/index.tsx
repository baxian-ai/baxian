import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from '../api.ts';
import type { SupportedLanguage } from '../shared/index.js';
import { enUS, type Messages } from './en-us.ts';
import { zhCN } from './zh-cn.ts';

const STORAGE_KEY = 'baxian.language';
const DEFAULT_LOCALE: SupportedLanguage = 'en-US';
const DICTS: Record<SupportedLanguage, Messages> = { 'en-US': enUS, 'zh-CN': zhCN };

export type { Messages };

function isSupported(v: unknown): v is SupportedLanguage {
  return v === 'zh-CN' || v === 'en-US';
}

function readCachedLocale(): SupportedLanguage {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isSupported(v) ? v : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

function cacheLocale(locale: SupportedLanguage): void {
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
  }
}

let currentLocale: SupportedLanguage = readCachedLocale();
const localeListeners = new Set<(locale: SupportedLanguage) => void>();
// epoch 只计有意切换（PATCH/跨标签/权威同步），refresh 排序由 appliedSeq 负责
let localeEpoch = 0;
let refreshSeq = 0;
let refreshAppliedSeq = 0;

function setCurrentLocale(locale: SupportedLanguage): void {
  if (locale === currentLocale) return;
  currentLocale = locale;
  localeListeners.forEach((fn) => fn(locale));
}

export function syncLocaleFromConfig(language: SupportedLanguage | undefined): void {
  localeEpoch += 1;
  const next = language ?? DEFAULT_LOCALE;
  cacheLocale(next);
  setCurrentLocale(next);
}

function applyRefreshedLocale(language: SupportedLanguage | undefined): void {
  const next = language ?? DEFAULT_LOCALE;
  cacheLocale(next);
  setCurrentLocale(next);
}

export function getMessages(): Messages {
  return DICTS[currentLocale];
}

export function getLocale(): SupportedLanguage {
  return currentLocale;
}

export function __resetI18nForTests(): void {
  currentLocale = DEFAULT_LOCALE;
  localeEpoch = 0;
  refreshSeq = 0;
  refreshAppliedSeq = 0;
  localeListeners.clear();
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
  }
}

interface I18nContextValue {
  locale: SupportedLanguage;
  messages: Messages;
  saving: boolean;
  setLocale: (next: SupportedLanguage) => Promise<void>;
}

// 默认值让无 Provider 的渲染（测试）直接得到静态英文字典
const I18nContext = createContext<I18nContextValue>({
  locale: DEFAULT_LOCALE,
  messages: enUS,
  saving: false,
  setLocale: async () => {
    throw new Error('setLocale requires I18nProvider');
  },
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<SupportedLanguage>(currentLocale);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const listener = (next: SupportedLanguage) => setLocaleState(next);
    localeListeners.add(listener);
    setLocaleState(currentLocale);
    return () => {
      localeListeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale === 'zh-CN' ? 'zh-CN' : 'en';
  }, [locale]);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== null && e.key !== STORAGE_KEY) return;
      const v = e.key === null ? readCachedLocale() : e.newValue;
      if (isSupported(v)) {
        localeEpoch += 1;
        setCurrentLocale(v);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setLocale = async (next: SupportedLanguage) => {
    if (next === currentLocale) return;
    setSaving(true);
    try {
      await api.config.patch({ language: next });
      syncLocaleFromConfig(next);
    } finally {
      setSaving(false);
    }
  };

  return (
    <I18nContext.Provider value={{ locale, messages: DICTS[locale], saving, setLocale }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}

export function useT(): Messages {
  return useI18n().messages;
}

export function useLocaleConfigSync(): void {
  useEffect(() => {
    const refresh = () => {
      const epoch = localeEpoch;
      const seq = ++refreshSeq;
      void api.config.get().then((cfg) => {
        if (epoch !== localeEpoch) return;
        if (seq <= refreshAppliedSeq) return;
        refreshAppliedSeq = seq;
        applyRefreshedLocale(cfg.language);
      }).catch(() => {});
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
}
