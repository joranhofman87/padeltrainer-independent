

# QA Testing Audit — PadelTrainer.ai

## Current State

| Layer | Coverage | Detail |
|---|---|---|
| **Unit tests (Vitest)** | 16 of 53 lib files tested (~30%) | ~350 test cases across auth, validation, invoiceCalc, pricing, etc. |
| **Component tests** | 6 of 262 components tested (~2%) | Only booking, cycles, invoice dialog, slider, Auth, TrainerSignup |
| **E2E (Playwright)** | 12 spec files, weekly CI | Navigation, i18n, a11y, error handling, health checks. No auth-flow E2E. |
| **Edge function tests** | 1 of 78 functions tested (~1%) | Only `generate-proposals` has a test |
| **CI workflows** | Unit tests on every push/PR. E2E weekly (Sundays). | Solid gating on unit tests. |

## Verdict: Yes, you should add more tests. Here's what matters most.

---

## Priority 1: HIGH IMPACT — Add to CI on every push

### A. Critical business logic unit tests (missing)

These lib files handle money, bookings, and subscriptions — bugs here directly cost revenue:

- **`academyPayments.ts`** — academy payment calculations
- **`academySubscription.ts` / `clubSubscription.ts` / `sharedSubscription.ts`** — subscription tier logic (partially tested)
- **`invoiceSync.ts`** — invoice synchronization logic
- **`cycles.ts`** — cycle scheduling (partially tested, expand edge cases)
- **`locations.ts` / `cities.ts` / `provinces.ts`** — slug generation and lookups (SEO-critical)

### B. Sitemap edge function test

Your sitemap is your growth engine. One broken deploy could de-index thousands of pages. Add a test that:
- Calls the sitemap function with `type=index` and validates XML structure
- Calls `type=static` and checks for correct `/tools/padel-level-test` path
- Calls `type=locations&page=1` and validates hreflang tags exist

### C. Render-page edge function test

This generates all your meta tags for bots. A regression here kills SEO silently. Test that:
- Each route type returns correct `<title>`, `<meta name="description">`, canonical, and hreflang
- Unknown routes return a sensible fallback

---

## Priority 2: MODERATE — Add within next sprint

### D. Component tests for revenue-critical flows

Currently untested components that handle real user interactions:

- **Payment/checkout components** — Mollie/Stripe integration UI
- **Cycle registration form** — the full intake flow
- **Academy/Club dashboard** — management actions
- **Trainer availability editor** — slot CRUD

### E. Expand E2E to cover auth flows

Currently your Playwright suite skips all authenticated specs. Add at least:
- Login → redirect to correct dashboard per role
- Booking flow (as player)
- Trainer creating an availability slot

---

## Priority 3: LOW — Nice to have

### F. Visual regression testing

For a content-heavy multilingual site, consider adding Playwright screenshot comparisons for key landing pages to catch layout breaks across languages.

### G. Edge function smoke tests in CI

You have `rls-health.spec.ts` and `invoice-health.spec.ts` in Playwright, but the 78 edge functions have almost no test coverage. The most critical ones to test:
- `auto-invoice-cycles` — automated billing
- `create-mollie-payment` / `create-stripe-checkout` — payment initiation
- `generate-invoice` — PDF generation

---

## Recommended Plan — 3 Changes

| # | What | Files | Runs on |
|---|---|---|---|
| 1 | Add unit tests for `locations.ts`, `cities.ts`, `invoiceSync.ts` | New `*.test.ts` files in `src/lib/` | Every push (existing `test.yml`) |
| 2 | Add sitemap + render-page edge function tests | New test files in `supabase/functions/` | Manual or weekly CI |
| 3 | Expand E2E with one authenticated booking flow | New `e2e/booking-auth.spec.ts` | Weekly CI |

This gives you the highest ROI: protecting SEO infrastructure and revenue flows without massive test-writing overhead. The existing CI already runs unit tests on every push, so adding tests to `src/lib/` is zero-config.

