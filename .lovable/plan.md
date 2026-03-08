

# QA Re-Check Report — Post-Fixes

## Status of Previous Issues

### Build Errors — ALL FIXED
- **send-email**: Duplicate `to` removed, `cycleName` added. Confirmed clean.
- **forward-invoice**: Null-safe access with `?.` and `!` on `trainerProfile`. Confirmed.
- **mollie-subscription-webhook**: All helper functions now use `supabase: any`. Confirmed.
- **reconcile-subscriptions**: Same fix applied. Confirmed.

### Tests Added
- `src/lib/cycles.test.ts` — CycleSettings, ScoringWeights, payment timing backwards compat. Confirmed.

---

## Remaining Gaps for Launch Readiness

### 1. Missing Logging on Critical User-Facing Pages (HIGH)

These pages handle money and signups but have **zero `logger` imports**:

| Page | Risk | Why it matters |
|------|------|----------------|
| `BookLesson.tsx` (1155 lines) | Critical | Main booking + payment flow |
| `Auth.tsx` | High | Login/signup errors invisible |
| `PlayerSignup.tsx` | High | New user onboarding |
| `TrainerSignup.tsx` | High | New trainer onboarding |
| `AcademySignup.tsx` | High | Academy onboarding |
| `ClubSignup.tsx` | High | Club onboarding |
| `ForgotPassword.tsx` | Medium | Password reset failures |
| `ResetPassword.tsx` | Medium | Password reset completion |
| `MollieCallback.tsx` | High | Payment redirect handler |

**Fix**: Add `logger.error()` calls in every `catch` block in these files. ~30 minutes of work across 9 files.

### 2. FeatureErrorBoundary Used on Only 1 Page (MEDIUM)

`FeatureErrorBoundary` exists but is only used in `TrainerSubscription.tsx`. Critical flows like BookLesson, CycleRegistration, and payment pages should wrap their main content in it to prevent full-page crashes.

**Fix**: Wrap main content of BookLesson, CycleRegistration, Auth, and all signup pages in `<FeatureErrorBoundary>`. ~15 minutes.

### 3. Missing Unit Tests for Core Business Logic (MEDIUM)

No tests for:
- `src/lib/subscription.ts` — trial calculation, tier checks
- `src/lib/sharedSubscription.ts` — `getTrialDaysRemaining`, `isDateExpired`
- `src/lib/pricing.ts` has tests, but `src/lib/academy.ts` (857 lines), `src/lib/club.ts` (857 lines) have none
- Booking flow logic in `BookLesson.tsx` (price calculation, slot validation)

**Recommended new test files**:
- `src/lib/subscription.test.ts` — trial days, expiry checks
- `src/lib/sharedSubscription.test.ts` — utility function edge cases

### 4. Edge Function Error Alerting (LOW — Tech Debt)

The `logger.ts` TODO at line 68 for Sentry/monitoring integration is still open. For launch, the sessionStorage approach works but errors are lost when users close tabs.

**Recommendation**: Not blocking for launch, but should be priority post-launch.

---

## Recommended Implementation Plan

### Priority 1: Add logging to 9 critical pages
Add `logger.error()` in catch blocks of:
1. `BookLesson.tsx`
2. `Auth.tsx`
3. `PlayerSignup.tsx`, `TrainerSignup.tsx`, `AcademySignup.tsx`, `ClubSignup.tsx`
4. `MollieCallback.tsx`
5. `ForgotPassword.tsx`, `ResetPassword.tsx`

### Priority 2: Add FeatureErrorBoundary to critical flows
Wrap main content in:
1. `BookLesson.tsx`
2. `CycleRegistration.tsx`
3. All signup pages

### Priority 3: Add unit tests for subscription logic
1. `src/lib/subscription.test.ts`
2. `src/lib/sharedSubscription.test.ts`

### Files to modify
- 9 page files (add logger imports + error logging)
- 4 page files (add FeatureErrorBoundary wrapping)
- 2 new test files

Total: ~13 files, mostly small additions (import + 1-2 lines per catch block).

