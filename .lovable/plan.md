
# Fix Google OAuth (and other auth redirects)

## Root Cause

The `signInWithGoogle()`, `signUpWithEmail()`, and `sendPasswordResetEmail()` functions in `src/lib/auth.ts` are explicitly passing **old paths** to `getAuthRedirectUrl()`:

- `getAuthRedirectUrl('/auth')` -- resolves to `https://...origin/auth` (does not exist)
- `getAuthRedirectUrl('/reset-password')` -- resolves to `https://...origin/reset-password` (does not exist)

These should be `/app/auth` and `/app/reset-password` to match the new routing.

## Fix (single file: `src/lib/auth.ts`)

Update **4 calls** to use the `/app`-prefixed paths:

| Line | Current | Fixed |
|------|---------|-------|
| 45 | `getAuthRedirectUrl('/auth')` | `getAuthRedirectUrl('/app/auth')` |
| 93 | `getAuthRedirectUrl('/auth')` | `getAuthRedirectUrl('/app/auth')` |
| 197 | `getAuthRedirectUrl('/reset-password')` | `getAuthRedirectUrl('/app/reset-password')` |
| 210 | `getAuthRedirectUrl('/reset-password')` | `getAuthRedirectUrl('/app/reset-password')` |

No other files need changes. The `getAuthRedirectUrl` function itself already defaults to `/app/auth`, so these were simply missed during the migration.
