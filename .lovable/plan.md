
# Pre-Production Stripe Cleanup & Testing Verification

## Audit Summary

After thoroughly exploring the codebase, I've identified the remaining Stripe references that need to be cleaned up before going to production. Good news: **E2E tests and unit tests have NO Stripe references** - they're clean!

---

## Remaining Stripe Issues Found

### Critical - Will Cause Runtime Errors

| File | Issue | Impact |
|------|-------|--------|
| `supabase/functions/get-admin-stats/index.ts` | References `trainer_stripe_accounts` table (now `trainer_mollie_accounts`) | **Admin dashboard will fail** |
| `supabase/functions/get-admin-stats/index.ts` | Imports and uses Stripe SDK for balance retrieval | Unnecessary dependency, will fail without key |
| `src/components/admin/AdminStatsCards.tsx` | Labels say "Stripe Connect" and "Stripe Balance" | Confusing UI |

### Translation Files - User-Facing Text

| File | Keys with "Stripe" | Count |
|------|-------------------|-------|
| `src/i18n/locales/en/trainer.json` | Lines 129, 144-145, 353, 357, 359-364, 548, 551, 554 | ~12 occurrences |
| `src/i18n/locales/nl/trainer.json` | Lines 129, 144-145, 353, 357, 359-364, 548, 551, 554 | ~12 occurrences |
| `src/i18n/locales/en/marketing.json` | Lines 462, 466 (Terms of Service) | 2 occurrences |

### Database - Migrations Reference Legacy Names

The migrations folder contains historical Stripe table creation (expected - migrations are immutable), but the TypeScript types in `src/integrations/supabase/types.ts` still reference `trainer_stripe_accounts` - this will auto-regenerate after the final migration runs.

---

## Implementation Plan

### Phase 1: Fix Admin Stats Edge Function

Update `supabase/functions/get-admin-stats/index.ts`:
- Remove Stripe SDK import
- Change `trainer_stripe_accounts` → `trainer_mollie_accounts`  
- Change `stripeAccountsResult` → `mollieAccountsResult`
- Remove Stripe balance retrieval code (or replace with Mollie API if needed)
- Rename `stripeBalance` → `mollieBalance` in response

### Phase 2: Fix Admin UI Labels

Update `src/components/admin/AdminStatsCards.tsx`:
- Change "Stripe Connect" → "Mollie Connect"
- Change "Stripe Balance" → "Mollie Balance"
- Update `stripeBalance` property references → `mollieBalance`

Update `src/lib/admin.ts`:
- Change `AdminStats.stripeBalance` → `mollieBalance` in type definition

### Phase 3: Update Trainer Translation Files

**English (`src/i18n/locales/en/trainer.json`):**
- Line 129: "Set up Stripe to receive payouts" → "Set up payment account to receive payouts"
- Lines 144-145: "Stripe payments" → "online payments"
- Line 353: "via Stripe" → "via Mollie"
- Line 357: "via Stripe" → "via Mollie"
- Section 359-365: Rename `stripeConnect` → `mollieConnect` and update all Stripe → Mollie

**Dutch (`src/i18n/locales/nl/trainer.json`):**
- Same translations as English, localized to Dutch

### Phase 4: Update Marketing Translation Files

**English (`src/i18n/locales/en/marketing.json`):**
- Line 462: "processed through Stripe" → "processed through Mollie"
- Line 466: "your connected Stripe account" → "your connected Mollie account"

### Phase 5: Verify Tests Pass

Run existing test suites to ensure no regressions:
- Unit tests: `src/lib/*.test.ts` (auth, pricing, calendar, etc.)
- Edge function tests: `supabase/functions/generate-proposals/index.test.ts`
- E2E tests: `e2e/*.spec.ts`

---

## Test Coverage Summary

### Unit Tests (No Changes Needed)

| Test File | Coverage | Stripe References |
|-----------|----------|-------------------|
| `src/lib/auth.test.ts` | Auth flows | None |
| `src/lib/pricing.test.ts` | Price calculations | None |
| `src/lib/calendar.test.ts` | Calendar logic | None |
| `src/lib/lessons.test.ts` | Lesson management | None |
| `src/lib/utils.test.ts` | Utilities | None |
| `src/lib/videoEmbed.test.ts` | Video embeds | None |
| `src/lib/ratingSystems.test.ts` | Ratings | None |
| `src/lib/logger.test.ts` | Logging | None |

### E2E Tests (No Changes Needed)

| Test File | Coverage | Stripe References |
|-----------|----------|-------------------|
| `e2e/booking.spec.ts` | Booking flows | None |
| `e2e/auth.spec.ts` | Authentication | None |
| `e2e/navigation.spec.ts` | Navigation | None |
| `e2e/admin.spec.ts` | Admin features | None |
| `e2e/roles.spec.ts` | Role management | None |
| `e2e/i18n.spec.ts` | Internationalization | None |

### Edge Function Tests

| Test File | Status |
|-----------|--------|
| `generate-proposals/index.test.ts` | No Stripe refs - OK |

---

## Technical Notes

### Database Types Auto-Regeneration
The `src/integrations/supabase/types.ts` file will automatically regenerate after migrations, removing the legacy `trainer_stripe_accounts` references. No manual changes needed.

### Secrets Configuration
Verified secrets are configured:
- `MOLLIE_API_KEY`
- `MOLLIE_CLIENT_ID`
- `MOLLIE_CLIENT_SECRET`
- `MOLLIE_PROFILE_ID`

The `STRIPE_SECRET_KEY` reference in `get-admin-stats` can be safely removed.

---

## Summary

| Phase | Scope | Files Changed |
|-------|-------|---------------|
| 1 | Edge Function | 1 file (get-admin-stats) |
| 2 | Admin UI | 2 files (AdminStatsCards, admin.ts) |
| 3 | Trainer Translations | 2 files (en/nl trainer.json) |
| 4 | Marketing Translations | 1 file (en marketing.json) |
| 5 | Test Verification | Run existing tests |

**Total: 6 files to update + test verification**

After these changes, the codebase will be 100% Stripe-free and production-ready for Mollie.
