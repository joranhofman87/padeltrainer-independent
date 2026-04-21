import { nl, enUS, es, de, fr, it } from 'date-fns/locale';
import type { Locale } from 'date-fns';

const map: Record<string, Locale> = { nl, en: enUS, es, de, fr, it };

export function getDateFnsLocale(lang: string): Locale {
  return map[lang.split('-')[0]] || enUS;
}
