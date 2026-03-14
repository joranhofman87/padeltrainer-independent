

# Plan: Data Cleaning & Validation Hardening for Large Imports

After reviewing the full import logic, here are the gaps that would cause dirty data at 5,000+ scale, grouped by priority.

## 1. Text Normalization (names, cities)

Currently names and cities are only `.trim()`-ed. With messy data you'll get entries like `"PADEL CLUB AMSTERDAM"`, `"padel club amsterdam"`, `"  Padel Club  Amsterdam  "`, or `"Amsterdam "` vs `"Amsterdam"`.

**Add a `normalizeText` helper** that:
- Collapses multiple spaces into one
- Converts to Title Case (`padel club amsterdam` → `Padel Club Amsterdam`)
- Strips leading/trailing whitespace

Apply to `name`, `city`, and `street_address`.

## 2. Country Code Normalization

The file might contain `"Netherlands"`, `"The Netherlands"`, `"nederland"`, `"NL"`, `"Australia"`, `"AU"` etc. Currently it's stored as-is.

**Add a country normalizer** that maps common full names and variants to their ISO 2-letter code (NL, BE, DE, ES, AU, etc.). Unknown values pass through with a warning badge.

## 3. URL Cleanup

Website, Facebook, Instagram, and Google Maps URLs may be messy (`padelclub.nl` without protocol, trailing spaces, mixed case).

**Add a `normalizeUrl` helper** that:
- Trims whitespace
- Prepends `https://` if no protocol is present
- Removes trailing slashes for consistency

## 4. Email Validation

No validation exists. Invalid emails will be stored as-is.

**Add basic email format check** (regex). Invalid emails get a non-blocking warning (still importable, but flagged in preview).

## 5. Phone Normalization

Phone numbers may have inconsistent formatting (`+31 20 123 4567`, `0201234567`, `+31-20-123-4567`).

**Strip all non-digit characters except leading `+`** for consistent storage.

## 6. Slug Duplicate Check Gap

Currently the slug fallback (Layer 3) only runs when there are no coordinates AND no Google Maps URL. This means two clubs with the same name+city but different (non-matching) coordinates would both be imported as duplicates with conflicting slugs, causing a database unique constraint error caught only at insert time.

**Always check slug uniqueness** as a final layer regardless of whether coords/URL matched. If the slug already exists (in DB or file), append a numeric suffix (`-2`, `-3`).

## 7. Preview Filtering for Large Files

With 5,000+ rows showing only the first 100 is not useful for reviewing problems. 

**Add filter tabs** above the preview table: "All", "Valid", "Duplicates", "Errors" — so you can quickly scan the ~200 problem rows instead of scrolling past 4,800 good ones.

## Files to Edit

- `src/components/admin/ImportLocationsDialog.tsx` — all logic and UI changes
- `src/i18n/locales/en/admin.json` — new warning/error translation keys
- `src/i18n/locales/es/admin.json` — same
- `src/i18n/locales/fr/admin.json` — same

