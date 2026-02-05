
# Fix Academy Earnings Page - UI and UX Improvements

## Issues Found

| Issue | Current State | Fix Required |
|-------|--------------|--------------|
| No padding | `<div className="space-y-6">` missing container padding | Add `container mx-auto px-4 py-8` like other academy pages |
| Button text | Uses `t('settings.connectMollie')` = "Connect Payment Account" | Add specific translation key "Connect Mollie" / "Koppel Mollie" |

---

## How Mollie Connection Works

Both trainers and academies use **OAuth flow** (not API key entry):

1. User clicks "Connect Mollie" button
2. Edge function (`mollie-connect-trainer` or `mollie-connect-academy`) generates an OAuth URL with `landing_page: 'signup'`
3. User is redirected to Mollie's site to either:
   - Create a new Mollie account (signup)
   - Login to existing account
4. After authorization, Mollie redirects back with an auth code
5. The callback handler exchanges code for tokens and stores them

**Why no in-app experience?** This is by design - Mollie requires merchants to complete onboarding on their platform for compliance/KYC reasons. The OAuth flow is the standard integration method for payment providers.

---

## Implementation Changes

### 1. Fix Page Padding

Add container wrapper matching other academy pages:

```tsx
// Before:
<div className="space-y-6">

// After:
<div className="container mx-auto px-4 py-8 space-y-6">
```

### 2. Add "Connect Mollie" CTA Translation

Add new translation keys for explicit Mollie branding:

**English:**
```json
"connectMollieAccount": "Connect Mollie"
```

**Dutch:**
```json
"connectMollieAccount": "Koppel Mollie"
```

### 3. Update Button to Use New Translation

Change button text from `t('settings.connectMollie')` to the new key.

---

## Files to Modify

| File | Change |
|------|--------|
| `src/pages/academy/AcademyEarnings.tsx` | Add container padding, update button translation key |
| `src/i18n/locales/en/academy.json` | Add `connectMollieAccount` key |
| `src/i18n/locales/nl/academy.json` | Add `connectMollieAccount` key |

---

## Technical Note

The Mollie OAuth flow cannot be replaced with an in-app experience because:
- Mollie requires merchants to complete onboarding on their platform
- KYC/compliance verification happens on Mollie's side
- OAuth with `landing_page: 'signup'` is the official partner integration method
- This is the same approach used for trainers (identical flow)

The current implementation follows Mollie's best practices for partner integrations.
