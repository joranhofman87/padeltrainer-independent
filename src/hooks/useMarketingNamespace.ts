import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { loadMarketingNamespace } from '@/i18n';

/**
 * Loads the heavy `marketing` locale bundle for the active language on demand
 * (it's excluded from the entry chunk). Returns `true` once translations are
 * available; bindI18nStore 'added' re-renders consumers when the bundle lands.
 */
export function useMarketingNamespace(): boolean {
  const { i18n } = useTranslation();
  const lang = (i18n.language ?? 'en').split('-')[0];
  const [ready, setReady] = useState(() => i18n.hasResourceBundle(lang, 'marketing'));

  useEffect(() => {
    if (i18n.hasResourceBundle(lang, 'marketing')) {
      setReady(true);
      return;
    }
    let cancelled = false;
    setReady(false);
    void loadMarketingNamespace(lang).then(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [i18n, lang]);

  return ready;
}
