import { format as dfFormat } from 'date-fns';
import i18next from 'i18next';
import { getDateFnsLocale } from '@/lib/dateFnsLocale';

/**
 * Canonical money + date formatters. The app historically rendered currency in
 * three different ways (`€50.00`, `EUR 50.00`, ad-hoc Intl.NumberFormat) and
 * dates with a mix of date-fns patterns and toLocaleDateString. These helpers
 * give one consistent source of truth — especially important on payment /
 * invoice screens, where mixed money formatting reads as unpolished.
 *
 * The canonical currency format is `€50.00` (the app's dominant existing
 * style), so routing the legacy formatPrice through formatCurrency does not
 * change any displayed amounts.
 */

/** `€50.00`. Non-finite input renders as `€0.00`. */
export function formatCurrency(amount: number): string {
  if (!Number.isFinite(amount)) return '€0.00';
  return `€${amount.toFixed(2)}`;
}

/** Currency for possibly-missing values: returns `fallback` (default `—`) when null/undefined. */
export function formatCurrencyMaybe(
  amount: number | null | undefined,
  fallback = '—',
): string {
  if (amount == null || !Number.isFinite(amount)) return fallback;
  return formatCurrency(amount);
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
