import { nl, enUS, enGB, es, de, fr, it } from 'date-fns/locale';
import type { Locale } from 'date-fns';

const map: Record<string, Locale> = { nl, en: enUS, es, de, fr, it };

/** date-fns locales for DayPicker: ISO week (Monday first), localized labels. */
const dayPickerMap: Record<string, Locale> = { nl, en: enGB, es, de, fr, it };

export function getDateFnsLocale(lang: string): Locale {
  return map[lang.split('-')[0]] || enUS;
}

/**
 * Locale for react-day-picker / shadcn Calendar.
 * Uses Monday as the first day of the week (en-GB for English, not en-US).
 */
export function getDayPickerLocale(lang: string): Locale {
  return dayPickerMap[lang.split('-')[0]] || enGB;
}

/** ISO-8601: Monday = 1 */
export const DAY_PICKER_WEEK_STARTS_ON = 1 as const;
