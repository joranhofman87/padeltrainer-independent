

# QA Analysis Report

## 1. Critical Build Errors (Blocking Deployment)

There are **20+ TypeScript build errors** across 4 edge functions that must be fixed before any deployment:

### A. `send-email/index.ts` — Duplicate `to` property (line 14 & 16)
The `EmailRequest` interface declares `to: string` twice. Also missing `cycleName` in the `data` type definition.

### B. `forward-invoice/index.ts` — Null safety (lines 89, 98, 128)
`trainerProfile` can be null after `.single()`, but is accessed without a null guard after the authorization check. The early-return on line 82 doesn't cover all paths.

### C. `mollie-subscription-webhook/index.ts` — 12 errors
- Helper functions (`handleFailedPayment`, `logSubscriptionPayment`, `sendSlackNotification`) use `ReturnType<typeof createClient>` without generic params, causing `SupabaseClient` type mismatch with the `any` variant used in the main handler.
- `subscription_payments.upsert()` and `.update()` calls hit `never` types because the table isn't in the typed schema or the generic `createClient` doesn't carry the schema.
- `metadata[fpConfig.profileField]` is typed `unknown`, needs cast.
- `subscriptionPayload` is `Record<string, unknown>` but the function expects a specific shape.

### D. `reconcile-subscriptions/index.ts` — 5 errors
Same `SupabaseClient` generic mismatch. The `reconcileProfiles` function parameter types don't align with the `any`-based client created in the handler. `.update()` calls also hit `never`.

### Fix approach
- **send-email**: Remove duplicate `to` field, add `cycleName` to data interface.
- **forward-invoice**: Add null check for `trainerProfile` after the auth guard.
- **mollie-subscription-webhook & reconcile-subscriptions**: Change helper function signatures to accept `any` for the supabase client parameter (e.g., `supabase: any` or use a shared type alias), and cast `.from()` results where needed. This is the pragmatic fix since edge functions don't use the generated types.

---

## 2. Test Coverage Assessment

### Unit Tests (Vitest)
Current: **11 test files**, mostly utility-focused:
- `pricing.test.ts` — good coverage of price calculations
- `videoEmbed.test.ts` — video URL parsing
- `logger.test.ts` — logging utility
- `calendar.test.ts`, `utils.test.ts`, `auth.test.ts`, `ratingSystems.test.ts`, `lessons.test.ts`
- `slider.test.tsx` — one UI component test
- `DayAvailabilityPicker.test.tsx` — one component test
- `example.test.ts` — placeholder

**Missing critical test coverage:**
- No tests for `cycles.ts` (including new payment timing logic)
- No tests for `subscription.ts`, `club.ts`, `academy.ts`
- No tests for booking flow logic
- No tests for auth hooks or providers
- No component tests for forms (CycleForm, BookLesson, etc.)

### E2E Tests (Playwright)
Good breadth: 10 spec files covering auth, navigation, booking, roles, i18n, accessibility, performance, error handling, admin. Structure looks solid.

### Edge Function Tests
Only 1: `generate-proposals/index.test.ts`. No tests for critical payment functions (mollie-webhook, subscription-webhook, send-email, etc.).

---

## 3. Logging Assessment

- **Frontend**: Centralized `logger.ts` with levels (debug/info/warn/error), session storage for errors, and a `measure()` helper. All console.log/warn/error calls have been migrated per the launch checklist. PostHog page tracking is active. **Good.**
- **Edge Functions**: All critical functions use structured `logStep()` patterns with JSON context. **Good.**
- **Missing**: No external monitoring integration yet (Sentry/LogRocket placeholder in logger.ts at line 68). This is documented as tech debt.

---

## 4. Functional Concerns

### A. Payment Terms feature (just shipped)
- The `auto-invoice-cycles` edge function was created but the pg_cron job to schedule it needs to be verified — was it actually created via migration?
- The `CycleForm` backwards compatibility (mapping old `mark_as_paid` to `manual`) should be tested with existing data.

### B. Impersonation fix
- The sync `window.open('about:blank')` fix was applied. Should work but needs manual verification.

### C. Player ratings start date
- Changed to Jan 2025. Simple change, low risk.

---

## 5. Recommended Plan

### Priority 1: Fix build errors (4 edge functions)
1. **send-email**: Remove duplicate `to` property, add `cycleName` to data type
2. **forward-invoice**: Add `if (!trainerProfile)` guard after auth check
3. **mollie-subscription-webhook**: Use `any` type for supabase parameter in helpers, cast metadata fields
4. **reconcile-subscriptions**: Same `any` type fix for supabase parameter, cast update payloads

### Priority 2: Add missing unit tests
5. Add tests for `src/lib/cycles.ts` — especially `CycleSettings` type and payment timing defaults
6. Add tests for pricing/booking flow logic with different payment timings

### Priority 3: Verify automation
7. Confirm the `auto-invoice-cycles` pg_cron job is scheduled in the database

### Files to modify
- `supabase/functions/send-email/index.ts` (~3 line fix)
- `supabase/functions/forward-invoice/index.ts` (~5 line fix)
- `supabase/functions/mollie-subscription-webhook/index.ts` (~15 lines, type casts)
- `supabase/functions/reconcile-subscriptions/index.ts` (~10 lines, type casts)
- `src/lib/cycles.test.ts` (new file)

