

# Fix Invoice Logo Upload + Add Banner Color

## Problem
The logo upload fails because the storage path uses `invoice-logos/academy-{id}` but RLS policies only allow uploads to `academies/{academyId}/...` folder. Additionally, the user wants a configurable banner/header color for invoices (for white logos on dark backgrounds, like the RL Padel Performance example).

## Plan

### Step 1: Database Migration
- Add `invoice_banner_color` column (text, nullable, default null) to `academy_profiles`

### Step 2: Fix Logo Upload Path
In `AcademyInvoiceSettingsCard.tsx`, change the upload path from:
- `invoice-logos/academy-${academyId}.${ext}` 
to:
- `academies/${academyId}/invoice-logo.${ext}`

This matches the existing RLS policy that allows academy managers to upload to `avatars/academies/{academyId}/...`.

Also fix `handleRemoveLogo` to use the correct path.

### Step 3: Add Banner Color Picker
In `AcademyInvoiceSettingsCard.tsx`:
- Add a color input next to the logo upload section
- Default suggestion: dark navy (#1a2332) based on the example
- Include a few preset color swatches (dark navy, black, white, brand blue) + custom color picker
- Save `invoice_banner_color` alongside other settings
- Load it from the database on init

### Step 4: Translations
Add keys for banner color label/description in EN and NL academy.json.

## Files
- **Migration**: Add `invoice_banner_color` to `academy_profiles`
- `src/components/academy/AcademyInvoiceSettingsCard.tsx` — Fix upload path, add color picker
- `src/i18n/locales/en/academy.json` — Translations
- `src/i18n/locales/nl/academy.json` — Translations

