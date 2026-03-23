

# Fix Missing Sidebar Translations in Academy

## Problem
Both `en/academy.json` and `nl/academy.json` have a **duplicate `"nav"` key** — one at line ~256 with all sidebar translations, and another at the end (line ~413) with only `"invoices"`. JSON silently overwrites the first with the second, so only `nav.invoices` resolves; everything else shows raw keys like `nav.dashboard`, `nav.profile`, etc.

## Fix
Merge the `"invoices"` entry into the existing `"nav"` block and remove the duplicate block at the end.

### `src/i18n/locales/en/academy.json`
- Add `"invoices": "Invoices"` to the existing `nav` object (line ~274)
- Delete the duplicate `"nav"` block at lines 413-415

### `src/i18n/locales/nl/academy.json`
- Add `"invoices": "Facturen"` to the existing `nav` object
- Delete the duplicate `"nav"` block at the end

No other file changes needed.

