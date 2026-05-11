# Strengthen password policy to 8+ characters

## Problem

Inconsistent and weak minimum password length across the stack:

- `src/lib/validation.ts`: requires `>= 6`
- `supabase/functions/admin-reset-password/index.ts`: enforces `>= 6`
- `supabase/functions/bootstrap-admin-password/index.ts`: enforces `>= 8`
- All signup pages (`PlayerSignup`, `TrainerSignup`, `ClubSignup`, `AcademySignup`, `ResetPassword`) use HTML `minLength={6}`
- Strength indicator UI is purely advisory
- Supabase Auth `minimum_password_length` is not enforced platform-side

For a payments + GDPR app, baseline should be 8 (NIST SP 800-63B minimum), enforced consistently.

## Fix

Standardize on **minimum 8 characters** everywhere. Keep the strength meter advisory above that.

### 1. Supabase Auth setting

Use `configure_auth` (or note: `password_min_length` is set via the auth settings — currently `configure_auth` tool surface doesn't include it directly). Action: ask the user to set **Authentication → Password requirements → Minimum length = 8** in Cloud Auth Settings, OR confirm we should also enable **Password HIBP Check** (`password_hibp_enabled: true`) at the same time, which we can flip via `configure_auth`.

### 2. Shared validation (`src/lib/validation.ts`)

- Change `minLength: password.length >= 6` to `>= 8`
- Update strength scoring thresholds accordingly (minor tweak)

### 3. Edge functions

- `supabase/functions/admin-reset-password/index.ts`: bump `< 6` to `< 8` and update error message
- `supabase/functions/bootstrap-admin-password/index.ts`: already 8, leave as-is

### 4. Signup / reset forms

Update `minLength={6}` → `minLength={8}` in:
- `src/pages/PlayerSignup.tsx`
- `src/pages/TrainerSignup.tsx`
- `src/pages/ClubSignup.tsx`
- `src/pages/AcademySignup.tsx`
- `src/pages/ResetPassword.tsx` (two inputs)

### 5. i18n strings

Update "At least 6 characters" → "At least 8 characters" in:
- `src/i18n/locales/en/auth.json`
- `src/i18n/locales/nl/auth.json`
- `src/i18n/locales/de/auth.json`
- `src/i18n/locales/es/auth.json`
- `src/i18n/locales/fr/auth.json`
- `src/i18n/locales/it/auth.json`
- Default fallback in `src/components/ui/password-strength.tsx`

## Question for the user

1. Confirm **8 characters** as the baseline (vs. 12, which is stronger but more friction on existing accounts). Existing users with 6–7 char passwords will keep working until next reset; only new passwords are checked.
2. Also enable **leaked-password (HIBP) check** at the same time? Recommended for a payments app.

## Out of scope

- Forcing existing users to rotate weak passwords (would require a migration + UX flow)
- Adding required complexity classes (uppercase/number/special) — strength meter already nudges this
