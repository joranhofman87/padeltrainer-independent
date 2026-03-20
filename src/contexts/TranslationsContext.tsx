import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import type { Translation } from '@/lib/translations';

interface TranslationsContextValue {
  translations: Translation[];
  pathPrefix: string | null;
  setTranslations: (translations: Translation[], pathPrefix: string) => void;
  clearTranslations: () => void;
}

const TranslationsContext = createContext<TranslationsContextValue>({
  translations: [],
  pathPrefix: null,
  setTranslations: () => {},
  clearTranslations: () => {},
});

export function TranslationsProvider({ children }: { children: ReactNode }) {
  const [translations, setTranslationsState] = useState<Translation[]>([]);
  const [pathPrefix, setPathPrefix] = useState<string | null>(null);

  const setTranslations = useCallback((t: Translation[], prefix: string) => {
    setTranslationsState(t);
    setPathPrefix(prefix);
  }, []);

  const clearTranslations = useCallback(() => {
    setTranslationsState([]);
    setPathPrefix(null);
  }, []);

  return (
    <TranslationsContext.Provider value={{ translations, pathPrefix, setTranslations, clearTranslations }}>
      {children}
    </TranslationsContext.Provider>
  );
}

export function useTranslationsContext() {
  return useContext(TranslationsContext);
}
