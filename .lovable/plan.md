

# Bulletproof Testing Strategy for PadelTrainer.ai

## Current State

You have **15 unit test files** covering utilities, pricing, invoices, cycles, auth, and subscriptions. These run on every push/PR via GitHub Actions. You also have **15 E2E spec files** (Playwright) but they have no CI workflow and only 8/45 tests have passed — 3 are blocked by auth redirect crashes.

**Coverage gaps**: No tests for validation logic, ICS generation, phone formatting, password strength, hooks, or any component beyond `Slider` and `DayAvailabilityPicker`. No integration tests for edge functions.

---

## The Plan — 4 Layers of Protection

### Layer 1: Expand Unit Tests for Untested Pure Logic (High Impact, Low Effort)

These files contain pure functions with zero database dependencies — perfect for fast, reliable tests.

| New Test File | What It Tests |
|---|---|
| `src/lib/validation.test.ts` | Phone validation (Dutch formats), `formatPhoneNumber`, `calculatePasswordStrength` |
| `src/lib/icsGenerator.test.ts` | ICS calendar file generation, date formatting, text escaping |
| `src/lib/domains.test.ts` | Auth redirect URL construction |
| `src/lib/utm.test.ts` | UTM parameter parsing/building |
| `src/lib/timezones.test.ts` | Timezone conversion helpers |

### Layer 2: Add Component Tests for Critical UI Flows

Test the components that handle money, bookings, and auth — where bugs cause real damage.

| New Test File | What It Tests |
|---|---|
| `src/components/auth/LoginForm.test.tsx` | Form validation, submit behavior, error states |
| `src/components/booking/BookingConfirmation.test.tsx` | Price display, slot details rendering |
| `src/components/cycles/CycleRegistrationForm.test.tsx` | Registration form validation, price calculation display |
| `src/components/invoices/InvoiceLineItems.test.tsx` | Line item rendering, VAT display, totals |

These will use mocked Supabase calls and focus on render correctness and user interaction.

### Layer 3: Add Playwright CI Workflow

Create `.github/workflows/e2e.yml` that runs E2E tests weekly (to save credits) and on manual trigger. This catches regressions in navigation, public pages, and error handling — the tests that don't need auth.

```text
Schedule: Weekly (Sundays at 5 AM UTC)
+ Manual trigger via workflow_dispatch
Only runs non-auth specs: navigation, i18n, accessibility, error-handling
```

### Layer 4: Edge Function Smoke Tests in CI

Add a lightweight workflow that calls `health-check` and `rls-smoke-test` endpoints after deployment to verify the backend is healthy.

---

## Implementation Priority

| Step | Files | Why First |
|---|---|---|
| 1 | `validation.test.ts`, `icsGenerator.test.ts` | Pure logic, catches bugs in phone/password/calendar — zero mocking needed |
| 2 | `LoginForm.test.tsx`, `BookingConfirmation.test.tsx` | Auth and payment UIs are highest-risk for user-facing breakage |
| 3 | `.github/workflows/e2e.yml` | Automates the 12+ non-auth E2E tests that currently only run manually |
| 4 | Remaining component tests + edge function smoke workflow | Fills remaining gaps |

---

## File Summary

| File | Change |
|---|---|
| `src/lib/validation.test.ts` | New — tests for phone validation, formatting, password strength |
| `src/lib/icsGenerator.test.ts` | New — tests for ICS generation, date formatting, text escaping |
| `src/components/auth/LoginForm.test.tsx` | New — login form validation, submission, error states |
| `src/components/booking/BookingConfirmation.test.tsx` | New — booking detail rendering, price display |
| `.github/workflows/e2e.yml` | New — weekly Playwright CI for non-auth E2E specs |

