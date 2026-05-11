## Goal

Address audit point #3: every public-internet edge function must have an in-code auth check. Today these functions run with `verify_jwt = false` and no internal check, so any random caller can hit them.

## Approach

Use **in-code auth checks** (the same pattern already used by `admin-reset-password`, `send-push-bulk`, etc.). This keeps the existing CORS preflight + service-role-call patterns intact and avoids cross-cutting `verify_jwt = true` flips that could break server-to-server calls.

Two reusable helper functions in `supabase/functions/_shared/auth.ts`:

- `requireAdmin(req)` — extracts Bearer JWT, calls `auth.getUser`, then checks `user_roles.role = 'admin'`. Returns `{ user, supabase }` or a 401/403 `Response`.
- `requireServiceRole(req)` — checks `Authorization === Bearer ${SUPABASE_SERVICE_ROLE_KEY}`. Returns `null` on success or a 401 `Response`. (Mirrors the inline check in `send-push-bulk`.)

Each function gets one of three guards inserted right after the OPTIONS preflight:

### 1. Admin-only (called from admin UI)

Add `requireAdmin(req)` at the top.

| Function | Caller |
|---|---|
| `generate-blog-article` | `AdminBlogTopics.tsx` |
| `translate-blog-article` | `AdminBlogEditor.tsx` |
| `backfill-invoices` | admin tooling |
| `enrich-clubs` | `lib/admin.ts` |
| `geocode-locations` | admin tooling |
| `fetch-location-logos` | `lib/admin.ts` |
| `rls-smoke-test` | admin only |

### 2. Service-role-only (cron / server-to-server)

Add `requireServiceRole(req)` at the top.

| Function | Reason |
|---|---|
| `process-blog-queue` | invoked by cron + internally chains to `generate-blog-article` |
| `trigger-welcome-emails` | invoked by cron and from `useAuth.tsx` post-signup |

For `process-blog-queue`'s downstream call into `generate-blog-article`, that internal fetch already passes `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, so the admin check there must accept service-role too. The `requireAdmin` helper will short-circuit and allow the request when the bearer equals the service-role key (so `process-blog-queue` keeps working without further changes).

For `trigger-welcome-emails` called from the browser in `useAuth.tsx`: switch the client call to either (a) a different lightweight function that re-issues a service-role call from a queue, or (b) simply remove that direct invocation since the same emails are queued by DB triggers (`trigger_*_onboarding_emails`). The simplest, lowest-risk fix is to **drop the client-side invoke** in `useAuth.tsx` and let cron + DB triggers handle it (the cron job already runs every few minutes). Confirm queue is populated; if not, replace the call with an unauthenticated "enqueue only" tiny function. Default to dropping, with a fallback note.

### 3. User-authenticated + ownership check

These are called by trainers from the client; require any logged-in user, then validate they actually own the targeted resource using service-role queries.

| Function | Check |
|---|---|
| `auto-create-invoice` | Resolve caller `user_id` → trainer `profile.id`. For each `bookingId`, ensure its `availability_slots.trainer_id` belongs to that trainer (or the caller is an academy manager of the slot's `academy_profile_id`, or admin). Reject if any booking fails the check. |
| `split-invoice` | Resolve caller; ensure the invoice's `trainer_id` matches caller's trainer profile (or academy-manager match, or admin). |

### 4. `slack-notify`

Called from many client paths (signups, bookings, registration form errors). Two options:

- **Chosen:** Require `auth.getUser` to succeed (any authenticated user) AND validate the `event` is one of the whitelisted `EVENT_CONFIG` keys. This blocks anonymous internet abuse while keeping all existing authenticated UX flows working.
- The two callers that fire **before** a session exists (signup error, anonymous registration form error) get switched to a server-side trigger or are dropped. We'll audit the exact call sites and either move them server-side (preferred) or accept their loss. Specifically:
  - `CycleApplicationForm.tsx` registration flow may run unauth → use the existing `submit-guest-intake` server function to fire the slack ping instead.
  - `BookLesson.tsx`, `TrainerSettings.tsx`, `useAuth.tsx` post-signup flow → user is authenticated by then, no change needed.

## Files to change

1. **New:** `supabase/functions/_shared/auth.ts` (helpers).
2. **Edit (add guard):** `generate-blog-article`, `translate-blog-article`, `process-blog-queue`, `slack-notify`, `auto-create-invoice`, `backfill-invoices`, `split-invoice`, `enrich-clubs`, `geocode-locations`, `fetch-location-logos`, `rls-smoke-test`, `trigger-welcome-emails`.
3. **Edit (frontend):** `src/hooks/useAuth.tsx` — drop the direct `trigger-welcome-emails` invoke (queued instead).
4. **Optional follow-up:** `submit-guest-intake` to forward the slack ping for unauthenticated registration flows (only if we find the call path is hit unauthenticated — confirm during implementation).

## Out of scope

- Changing `verify_jwt` in `supabase/config.toml` (we're solving via in-code checks for consistency with the rest of the codebase).
- Re-auditing other `verify_jwt = false` functions the auditor didn't flag.
- Adding rate limits (separate hardening pass).
- Touching webhook endpoints (mollie/stripe/reditus) — those validate signatures.

## Validation

After edits:
- `curl_edge_functions` each guarded function with no auth → expect 401.
- `curl_edge_functions` admin functions with the logged-in admin token → expect 200.
- Manually exercise admin blog generate, invoice split, and slack notify in the preview to confirm authenticated paths still work.
