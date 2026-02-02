
# Add Country Field to Academy Profiles

## Overview
Add a country selection field to academy profiles to enable future country-based filtering on the Academies page. All existing academies will default to Netherlands (NL).

## Database Changes

### 1. Add country column to academy_profiles
```sql
ALTER TABLE academy_profiles 
ADD COLUMN country TEXT NOT NULL DEFAULT 'NL';

-- Add comment for clarity
COMMENT ON COLUMN academy_profiles.country IS 'ISO 3166-1 alpha-2 country code';
```

This will automatically set all existing academies to 'NL' (Netherlands).

### 2. Update public views (if applicable)
The `academy_profiles_public` and `academy_profiles_safe` views may need updating to include the new `country` column.

---

## Frontend Changes

### 1. Create Countries List Constant
**New file: `src/lib/countries.ts`**

Create a reusable list of countries with ISO codes:
```typescript
export const COUNTRIES = {
  NL: 'Nederland',
  BE: 'Belgium',
  DE: 'Germany',
  ES: 'Spain',
  FR: 'France',
  GB: 'United Kingdom',
  IT: 'Italy',
  PT: 'Portugal',
  // Add more as needed
} as const;

export type CountryCode = keyof typeof COUNTRIES;
```

### 2. Update Academy Onboarding Page
**File: `src/pages/AcademyOnboarding.tsx`**

Add country dropdown:
- Default to 'NL'
- Required field
- Pass country to `createAcademy()` function

### 3. Update Academy Profile Edit Page
**File: `src/pages/academy/AcademyProfile.tsx`**

Add country dropdown in the Basic Info section:
- Pre-fill with current value
- Include in form submission

### 4. Update Academy Library Functions
**File: `src/lib/academy.ts`**

- Update `AcademyProfile` interface to include `country`
- Update `createAcademy()` to accept country parameter
- Update `updateAcademyProfile()` to handle country field

### 5. Update Admin Academy Edit Dialog
**File: `src/components/admin/AcademyEditDialog.tsx`**

Add country dropdown in the profile tab for admin editing.

### 6. Update Translations
**Files: `src/i18n/locales/en/academy.json` and `src/i18n/locales/nl/academy.json`**

Add translations for:
- "Country" label
- "Select country" placeholder

---

## Technical Details

### Country Dropdown Component Pattern
```text
+---------------------------+
|  Country *                |
+---------------------------+
| [Dropdown: NL - Nederland v]
+---------------------------+
```

Using the existing Select component pattern from the codebase:
```tsx
<Select value={country} onValueChange={setCountry}>
  <SelectTrigger>
    <SelectValue placeholder="Select country" />
  </SelectTrigger>
  <SelectContent>
    {Object.entries(COUNTRIES).map(([code, name]) => (
      <SelectItem key={code} value={code}>
        {name}
      </SelectItem>
    ))}
  </SelectContent>
</Select>
```

---

## Files to Modify

| File | Change |
|------|--------|
| Database migration | Add `country` column with default 'NL' |
| `src/lib/countries.ts` | New file - countries list |
| `src/lib/academy.ts` | Add country to interface and functions |
| `src/pages/AcademyOnboarding.tsx` | Add country dropdown |
| `src/pages/academy/AcademyProfile.tsx` | Add country dropdown |
| `src/components/admin/AcademyEditDialog.tsx` | Add country field |
| `src/i18n/locales/en/academy.json` | Add translations |
| `src/i18n/locales/nl/academy.json` | Add translations |

---

## Future Considerations
Once this is in place, you can:
1. Add country filter dropdown to `/academies` page
2. Filter academies by country in queries
3. Display country flag/badge on academy cards
