

# Add "Show Price Indication" Toggle to Registration Form Settings

## Problem
The price indication calculator is always shown on the registration form. Not all academies/trainers want to display pricing on their public form.

## Approach
Add a `show_price_indication` boolean to cycle settings (default `true` for backward compat), with a toggle in `CycleForm.tsx`. Then conditionally render the price card in `CycleApplicationForm.tsx`.

## Changes

| File | Change |
|------|--------|
| `src/components/cycles/CycleForm.tsx` | Add `show_price_indication` to schema (default `true`), load from `cycle.settings`, save to settings object, add Switch toggle in the form settings section near other toggles |
| `src/components/cycles/CycleApplicationForm.tsx` | Line 922: add check `(cycle.settings as any)?.show_price_indication !== false` before rendering the price indication card |
| `src/i18n/locales/en/cycles.json` | Add `form.showPriceIndication` label + description |
| `src/i18n/locales/nl/cycles.json` | Add Dutch translation |
| `src/i18n/locales/de/cycles.json` | Add German translation |
| `src/i18n/locales/fr/cycles.json` | Add French translation |
| `src/i18n/locales/es/cycles.json` | Add Spanish translation |

No database changes needed — the setting is stored in the existing `settings` JSONB column on the `cycles` table.

