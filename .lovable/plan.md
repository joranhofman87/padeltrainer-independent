

## Fix Missing Dutch Translations for "Request New Location"

### Problem

The button on the Academy Locations page shows the raw translation key `locations.requestNew` because the Dutch translation file is missing these keys. The English file has them, but the Dutch (`nl/academy.json`) does not.

### Changes

**`src/i18n/locales/nl/academy.json`** -- Add the missing keys under `locations`:

- `"requestNew": "Nieuwe Locatie Aanvragen"`
- `"requestNewDescription": "Locatie niet in onze database? Dien het in ter beoordeling door een beheerder."`
- `"requestSubmitted": "Aanvraag Ingediend"`
- `"requestSubmittedDescription": "Een beheerder zal je locatie-aanvraag beoordelen."`

### Files to modify
- `src/i18n/locales/nl/academy.json` (add 4 missing translation keys)
