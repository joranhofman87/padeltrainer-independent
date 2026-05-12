# Strengthen admin-set password requirements

## Goal

Make admin-set passwords meaningfully strong, since these are passwords an admin chooses for someone else's account. Bring both the server endpoint and the admin UI in line.

## Policy

- **Minimum 12 characters** (admin-set bar; users will be told to change after first login).
- **Must contain at least 3 of 4 character classes:** lowercase, uppercase, digit, symbol.
- **Maximum 128 characters** (sanity bound; matches Supabase Auth limit).
- Reject pure whitespace and leading/trailing whitespace.

12 chars + 3-of-4 classes is the standard recommendation for admin-set / service passwords (NIST 800-63B compatible when combined with disallowed-list checks; Supabase already has HIBP enabled per project policy).

## Changes

### 1. `supabase/functions/admin-reset-password/index.ts`
Replace the single `length < 8` check with a small helper that enforces the policy above and returns a specific error code per failure (`password_too_short`, `password_too_weak`, `password_too_long`, `password_invalid_whitespace`). Keep the response shape (`{ error: string }`) so existing UI keeps working.

### 2. `src/pages/admin/AdminUsers.tsx`
- Update placeholder copy from `"New password (min 6 chars)"` to reflect the new policy (e.g. `"Min 12 chars, mix of upper/lower/digit/symbol"`).
- Update the disabled-button check from `newPassword.length < 6` to a client-side mirror of the server policy (shared inline validator).
- Show a small inline hint listing the requirements under the input so the admin knows what's required before submitting.
- Map server error codes to user-friendly toast messages.

### 3. (Optional, low-risk) Suggest-a-password button
Add a "Generate" button next to the input that fills in a 16-char cryptographically-random password meeting the policy (using `crypto.getRandomValues`). Makes it easy for admins to do the right thing. Can be skipped if you prefer a smaller change.

## Out of scope

- No changes to user self-service password reset (`ResetPassword.tsx`) — that's gated by Supabase's own auth password policy.
- No DB migration; this is pure validation logic.
- No change to the existing admin-can't-reset-other-admin guard.

## Files touched

- `supabase/functions/admin-reset-password/index.ts`
- `src/pages/admin/AdminUsers.tsx`
