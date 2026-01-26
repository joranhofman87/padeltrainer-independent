

# Fix Broken Club Public Profile Link

## Problem
When clicking "Bekijk Publiek Profiel" (View Public Profile) from the club admin dashboard, the URL generated is malformed:
- **Broken URL**: `/nl/trainer/locations/tc-boemerang-kaatsheuvel`
- **Expected URL**: `/nl/locations/tc-boemerang-kaatsheuvel`

The extra `/trainer` segment in the path causes a 404 error.

## Root Cause
The `ClubLayout.tsx` component constructs the public profile URL without validating the language code from `i18n.language`. Unlike the `TrainerLayout.tsx` (which was recently fixed for a similar issue), the club layout lacks explicit language validation, which can result in unexpected values being concatenated into the URL path.

## Solution
Apply the same language validation pattern from TrainerLayout to ClubLayout:
- Validate that `i18n.language` is either `'en'` or `'nl'`
- Default to `'en'` if an unexpected value is detected

## Code Change

**File: `src/components/club/ClubLayout.tsx`**

Change the "View Public Profile" button's onClick handler from:
```tsx
onClick={() => window.open(`${window.location.origin}/${i18n.language}/locations/${activeClub.location.slug}`, '_blank')}
```

To:
```tsx
onClick={() => {
  const lang = i18n.language === 'en' || i18n.language === 'nl' ? i18n.language : 'en';
  window.open(`${window.location.origin}/${lang}/locations/${activeClub.location.slug}`, '_blank');
}}
```

## Impact
- Single file change
- Matches the pattern already established in TrainerLayout
- Ensures URL construction is consistent and safe across all layouts

