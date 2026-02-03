

# Add "Padel" to Footer Text for SEO

Update footer translations to increase "padel" keyword density across the site footer, improving local SEO signals on every page.

---

## Current vs Proposed

| Element | Current (EN) | Proposed (EN) | SEO Benefit |
|---------|-------------|---------------|-------------|
| Find Trainers | "Find Trainers" | "Find Padel Trainers" | +keyword |
| All Locations | "All Locations" | "Padel Clubs" | +keyword, clearer intent |
| Academies | "Academies" | "Padel Academies" | +keyword |
| Popular Cities header | "Popular Cities" (hardcoded) | "Padel Trainers by City" | +keyword, +i18n fix |

**Note**: The tagline already contains "padel" ("Your journey to better padel.") - no change needed there.

---

## Changes Required

### 1. English Translation (`src/i18n/locales/en/marketing.json`)

```json
// Lines 14-15, add new key for cities header
"findTrainers": "Find Padel Trainers",      // was: "Find Trainers"
"locations": "Padel Clubs",                  // was: "All Locations"
"academies": "Padel Academies",              // new key (currently fallback)
"popularCities": "Padel Trainers by City",   // new key (currently hardcoded)
```

### 2. Dutch Translation (`src/i18n/locales/nl/marketing.json`)

```json
"findTrainers": "Vind Padeltrainers",        // was: "Vind Trainers"
"locations": "Padelclubs",                    // was: "Alle Locaties"
"academies": "Padelacademies",                // new key
"popularCities": "Padeltrainers per stad",    // new key
```

### 3. Component Fix (`src/components/marketing/MarketingLayout.tsx`)

Replace hardcoded "Popular Cities" with translation key:
```tsx
// Line 172: Replace hardcoded string
<h4 className="font-semibold mb-4">{t('footer.popularCities')}</h4>
```

---

## Impact Summary

| Metric | Before | After |
|--------|--------|-------|
| "Padel" mentions in footer | 1 (tagline only) | 5 (tagline + 4 links) |
| Hardcoded strings fixed | 1 | 0 |
| Pages affected | All marketing pages | Same |

---

## Files Modified

- `src/i18n/locales/en/marketing.json` (4 string updates)
- `src/i18n/locales/nl/marketing.json` (4 string updates)
- `src/components/marketing/MarketingLayout.tsx` (1 line - i18n fix)

