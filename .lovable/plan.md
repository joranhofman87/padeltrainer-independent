# Localize Invoice Dates

## Problem
On the public invoice payment page, the body is in Dutch but the invoice/due dates render as `04 Apr 2026` / `20 May 2026` (English month abbreviations) because `date-fns` `format` is called without a locale.

## Fix
In `src/pages/PublicInvoicePay.tsx`:
- Import locales from `date-fns/locale` (`nl`, `enUS`, plus `de`, `fr`, `es`, `it` to match the languages already supported in the invoice email function).
- Map the active `i18n.language` (or invoice/recipient language) to the matching date-fns locale.
- Pass `{ locale }` to both `format(...)` calls for `invoiceDate` and `dueDate` so they render as `04 apr 2026` / `20 mei 2026` in Dutch.

## Scan for other spots
Quickly grep the public invoice flow (`PublicInvoicePay.tsx` and any sibling components it renders) for other hardcoded English strings or untranslated `format()` calls and fix any found in the same pass. No changes to backend/email logic — that is already localized server-side.

## Out of scope
- Email templates (already handled in `send-invoice-email`).
- Sender-side dashboards.
