import { format as dfFormat } from 'date-fns';
import i18next from 'i18next';
import { getDateFnsLocale } from '@/lib/dateFnsLocale';

/**
 * Canonical money + date formatters. The app historically rendered currency in
 * three different ways (`€50.00`, `EUR 50.00`, ad-hoc Intl.NumberFormat) and
 * dates with a mix of date-fns patterns and toLocaleDateString. These helpers
 * give one consistent, LOCALE-AWARE source of truth — important on payment /
 * invoice screens, where mixed money formatting reads as unpolished.
 *
 * Currency is formatted per the active i18n language: `€ 50,00` for Dutch,
 * `€50.00` for English (Intl, EUR, 2 decimals, with thousands separators).
 */

/**
 * Locale-aware currency, e.g. `€ 50,00` (nl) / `€50.00` (en). Non-finite → 0.
 * @param localeOrOpts a BCP-47 locale string, or `{ locale?, currency? }`.
 *   Locale defaults to the active i18n language; currency defaults to EUR.
 */
export function formatCurrency(
  amount: number,
  localeOrOpts?: string | { locale?: string; currency?: string },
): string {
  const value = Number.isFinite(amount) ? amount : 0;
  const opts = typeof localeOrOpts === 'string' ? { locale: localeOrOpts } : (localeOrOpts || {});
  const lng = opts.locale || i18next.language || 'en';
  const currency = opts.currency || 'EUR';
  return new Intl.NumberFormat(lng, { style: 'currency', currency }).format(value);
}

/** Currency for possibly-missing values: returns `fallback` (default `—`) when null/undefined. */
export function formatCurrencyMaybe(
  amount: number | null | undefined,
  fallback = '—',
  localeOrOpts?: string | { locale?: string; currency?: string },
): string {
  if (amount == null || !Number.isFinite(amount)) return fallback;
  return formatCurrency(amount, localeOrOpts);
}

/**
 * Locale-aware date formatting (date-fns), using the app's shared locale map
 * keyed off the active i18n language. Default pattern `d MMM yyyy`
 * (e.g. "5 Jun 2026"). Invalid/empty input returns an empty string.
 */
export function formatDate(
  date: Date | string | number | null | undefined,
  pattern = 'd MMM yyyy',
): string {
  if (date == null || date === '') return '';
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  return dfFormat(d, pattern, { locale: getDateFnsLocale(i18next.language || 'en') });
}
