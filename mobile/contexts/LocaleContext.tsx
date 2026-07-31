import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  dateLocaleTag,
  isLocale,
  LOCALE_STORAGE_KEY,
  staffTypeLabel as staffTypeLabelFor,
  statusLabel as statusLabelFor,
  translate,
  type Locale,
} from '../lib/i18n';

type TFn = (key: string, vars?: Record<string, string | number>) => string;

type LocaleContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: TFn;
  ready: boolean;
  staffTypeLabel: (code: string | null | undefined) => string;
  statusLabel: (status: string | null | undefined) => string;
  dateLocale: string;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>('en');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const stored = await AsyncStorage.getItem(LOCALE_STORAGE_KEY);
        if (!cancelled && isLocale(stored)) setLocaleState(stored);
      } catch {
        /* keep default */
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setLocale = useCallback((next: Locale) => {
    const lang: Locale = next === 'es' ? 'es' : 'en';
    setLocaleState(lang);
    void AsyncStorage.setItem(LOCALE_STORAGE_KEY, lang).catch(() => {});
  }, []);

  const t = useCallback<TFn>((key, vars) => translate(locale, key, vars), [locale]);

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      setLocale,
      t,
      ready,
      staffTypeLabel: (code) => staffTypeLabelFor(locale, code),
      statusLabel: (status) => statusLabelFor(locale, status),
      dateLocale: dateLocaleTag(locale),
    }),
    [locale, setLocale, t, ready]
  );

  return createElement(LocaleContext.Provider, { value }, children);
}

export function useI18n(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) {
    throw new Error('useI18n must be used within LocaleProvider');
  }
  return ctx;
}

/** Safe hook for optional use outside provider (falls back to English). */
export function useT(): TFn {
  const ctx = useContext(LocaleContext);
  if (!ctx) return (key, vars) => translate('en', key, vars);
  return ctx.t;
}
