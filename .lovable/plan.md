

# Fix Academy Earnings Page - UI Improvements

## Changes to Apply

### 1. Add Container Padding
**File:** `src/pages/academy/AcademyEarnings.tsx`

Update the outer wrapper from `<div className="space-y-6">` to `<div className="container mx-auto px-4 py-8 space-y-6">` to match other academy pages.

### 2. Update Button Text
**File:** `src/pages/academy/AcademyEarnings.tsx`

Change the Connect Mollie button text from `t('settings.connectMollie')` to `t('earnings.connectMollieAccount')`.

### 3. Add Translation Keys
**Files:** `src/i18n/locales/en/academy.json` and `src/i18n/locales/nl/academy.json`

Add the new translation key:
- English: `"connectMollieAccount": "Connect Mollie"`
- Dutch: `"connectMollieAccount": "Koppel Mollie"`

---

## Files to Modify

| File | Change |
|------|--------|
| `src/pages/academy/AcademyEarnings.tsx` | Add container padding, update button translation key |
| `src/i18n/locales/en/academy.json` | Add `connectMollieAccount` key in earnings section |
| `src/i18n/locales/nl/academy.json` | Add `connectMollieAccount` key in earnings section |

