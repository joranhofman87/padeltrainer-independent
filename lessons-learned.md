# Lisa Loops — Lessons Learned

> This file is read before every test run and updated after. It accumulates practical knowledge about testing this specific app. Lisa never makes the same mistake twice.

## App-Specific Quirks

- The app uses path-based routing with language prefixes for marketing pages (`/en/*`, `/nl/*`) and `/app/*` for authenticated routes.
- Academy owners use the `admin` role in `user_roles` — their academy access comes via `academy_managers` table, not the role itself.
- Google OAuth cannot be tested via automation — always use email/password login.
- The app has a duplicate Supabase client at `src/lib/supabaseClient.ts` alongside the auto-generated one at `src/integrations/supabase/client.ts`.
- i18n is active — some UI text varies by locale. Tests should navigate to `/en/*` routes for consistency.

## Timing & Loading

- Auth state loading shows a spinner — wait for `data-testid='page-*'` elements rather than checking URL immediately after login.
- Supabase queries use React Query — data pages may show loading states before content appears.
- Magic link processing sets `isProcessingMagicLink` state which shows a spinner — this won't affect email/password test flows.

## Selectors & DOM Notes

- Login form: `data-testid='auth-email-input'`, `data-testid='auth-password-input'`, `data-testid='auth-login-button'`
- Signup forms: `data-testid='form-signup-{role}'`, `data-testid='input-signup-name'`, `data-testid='input-signup-email'`, `data-testid='input-signup-password'`, `data-testid='btn-signup-submit'`
- Dashboards: `data-testid='page-player-dashboard'`, `data-testid='page-trainer-dashboard'`, `data-testid='page-admin-dashboard'`
- Settings: `data-testid='page-player-settings'`, `data-testid='page-trainer-settings'`, `data-testid='page-notification-settings'`
- Error boundary: `data-testid='error-boundary-fallback'`
- 404 page: `data-testid='page-not-found'`
- Login form uses `id='signin-email'` and `id='signin-password'` for input fields (HTML id, not testid).

## Common Failure Patterns

_None yet — will be populated during test execution._

## Fix Patterns

_When a bug is found and fixed, document the pattern here so similar bugs can be fixed faster._
