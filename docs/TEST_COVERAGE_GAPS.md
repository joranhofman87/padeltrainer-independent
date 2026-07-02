# Test Coverage Gaps

Purpose: an honest map of what is well-covered vs. what is not, with concrete file references, so an AI agent knows where a change is risky and un-guarded.
Audience / AI-read: yes
Status: canonical (source of truth) | last updated 2026-07-02

Companion (deeper, per-scenario): [`payments/PAYMENT_TEST_GAPS.md`](payments/PAYMENT_TEST_GAPS.md) (G1–G10), [`payments/PAYMENT_INVARIANTS.md`](payments/PAYMENT_INVARIANTS.md). Manual coverage: [`../TEST_RUNBOOK.md`](../TEST_RUNBOOK.md). Baseline snapshot (pre-QA, now historical): [`../TEST_BASELINE.md`](../TEST_BASELINE.md). Testability setup: [`../testability-report.md`](archive/testability-report.md).

**Inventory today:** ~292 vitest files (`src/**/*.test.{ts,tsx}`), of which **24 are PGlite integration** (`*.pglite.test.ts`) running the real lib against real Postgres; **12 deno `_shared` test files**; **~10 playwright e2e specs** (`e2e/` + `tests/`); **~44 `scripts/db/rehearse-*`** SQL-invariant scripts (`db:rehearse:all` gates a subset). 81 of the vitest files are `.tsx` component tests.

---

## Well covered (money path — treat as load-bearing, keep green)

The direct book→pay→invoice path is the most-tested surface, deliberately.

- **Payment amount / webhook writeback:** [`paymentAmountInvariant.test.ts`](../src/test/paymentAmountInvariant.test.ts), [`mollieWebhookWriteback.pglite.test.ts`](../src/test/mollieWebhookWriteback.pglite.test.ts), [`mollieWebhookM17Survivor.pglite.test.ts`](../src/test/mollieWebhookM17Survivor.pglite.test.ts), [`chargeConfirmParity.pglite.test.ts`](../src/test/chargeConfirmParity.pglite.test.ts), [`markBookingPaid.pglite.test.ts`](../src/lib/markBookingPaid.pglite.test.ts).
- **Mollie idempotency + pricing (edge):** [`mollie-idempotency.test.ts`](../supabase/functions/_shared/mollie-idempotency.test.ts), [`booking-pricing.test.ts`](../supabase/functions/_shared/booking-pricing.test.ts), [`mollie-payment-ready.test.ts`](../supabase/functions/_shared/mollie-payment-ready.test.ts), [`payment-audit.test.ts`](../supabase/functions/_shared/payment-audit.test.ts), [`guest-payment.test.ts`](../supabase/functions/_shared/guest-payment.test.ts).
- **Split divisor (frozen to capacity):** contract-equal client/edge — [`splitDivisor.contract.test.ts`](../src/lib/splitDivisor.contract.test.ts).
- **Invoice create/sync/dedup/paging:** [`createInvoiceDeduped.pglite.test.ts`](../src/test/createInvoiceDeduped.pglite.test.ts), [`invoiceSync.pglite.test.ts`](../src/lib/invoiceSync.pglite.test.ts), [`invoiceSyncPaging.pglite.test.ts`](../src/lib/invoiceSyncPaging.pglite.test.ts), [`cycleEditInvoiceSync.pglite.test.ts`](../src/test/cycleEditInvoiceSync.pglite.test.ts), [`cycleEditInvoiceTotals.pglite.test.ts`](../src/test/cycleEditInvoiceTotals.pglite.test.ts), [`invoiceCalc.test.ts`](../src/lib/invoiceCalc.test.ts).
- **Guest/cyclus booking + holds:** [`guestSlotBooking.pglite.test.ts`](../src/test/guestSlotBooking.pglite.test.ts), [`guestCyclusBooking.pglite.test.ts`](../src/test/guestCyclusBooking.pglite.test.ts), [`guestBookingToken.pglite.test.ts`](../src/test/guestBookingToken.pglite.test.ts).
- **Rebooking:** [`priorityClaimIntent.pglite.test.ts`](../src/test/priorityClaimIntent.pglite.test.ts), [`rebookGroupCapacityHolds.pglite.test.ts`](../src/test/rebookGroupCapacityHolds.pglite.test.ts), [`rebookSingleInvoiceDedup.pglite.test.ts`](../src/test/rebookSingleInvoiceDedup.pglite.test.ts), [`rebookPublicGatherScope.pglite.test.ts`](../src/test/rebookPublicGatherScope.pglite.test.ts).
- **Security boundary:** [`service-role-auth.test.ts`](../supabase/functions/_shared/service-role-auth.test.ts) (the fixed forged-JWT P0 has a dedicated regression), [`serviceRoleAuth.test.ts`](../src/test/serviceRoleAuth.test.ts), [`auth.test.ts`](../supabase/functions/_shared/auth.test.ts), [`mutationBoundary.test.ts`](../src/test/mutationBoundary.test.ts).
- **Reconciliation:** [`reconcilePayments.pglite.test.ts`](../src/test/reconcilePayments.pglite.test.ts).

## Partially covered

- **Cycle/slot generation + edit:** good lib coverage ([`slotGenerator.pglite.test.ts`](../src/test/slotGenerator.pglite.test.ts), [`applySlotEditToCycle.test.ts`](../src/test/applySlotEditToCycle.test.ts), [`cycleRoster.pglite.test.ts`](../src/test/cycleRoster.pglite.test.ts), [`publishCycle.pglite.test.ts`](../src/test/publishCycle.pglite.test.ts)) — but concurrency (two editors) untested.
- **Registration/intake:** pricing goldens exist ([`registrationPricing.test.ts`](../src/test/registrationPricing.test.ts), [`registration-pricing.golden.test.ts`](../supabase/functions/_shared/registration-pricing.golden.test.ts)) but the two duplicated email-composer build sites (client self-reg vs `submit-guest-intake` server) are only spot-checked; the mint-failure branch (business profile incomplete → registration saved with no pay link) is untested (PAYMENT_TEST_GAPS **G10**).
- **UI components:** 81 `.tsx` tests, but that is a fraction of ~79 pages/dozens of components — coverage is concentrated on cycle-detail, slot forms, invoice lists, players tables. Most pages have no render test.

## Gaps (ranked by risk)

### P0 / P1 — money & correctness (all detailed in PAYMENT_TEST_GAPS.md)
1. **G1 concurrent duplicate webhooks** — two simultaneous deliveries; only sequential is tested. Structurally sound (atomic claim) but unproven under true concurrency.
2. **G3 `verify-mollie-payment` vs `mollie-webhook` race** — no test runs both paths on one payment (double side-effect risk).
3. **G4 charge-org == confirm-org CODE-PATH parity** — the predicate is tested; the confirm side (`resolveAccessToken`, private in `mollie-webhook`, not import-testable) is not. Recommended fix: extract a shared `_shared/mollie-recipient.ts` and golden-test it.
4. **G6 logged-in cycle capacity lock** — `insertBookings` has no per-slot advisory lock (unlike `book_slot_for_payment`); concurrent cycle bookings can overbook. Structural gap; owed a concurrency test if `src/lib/bookings.ts` is touched.
5. **G7 adversarial cross-tenant suite** — only partial (`rebookPublicGatherScope`); no consolidated forged-`guest_player_id` / sibling-invoice-read suite.
6. **G8 hold-expiry vs paid-webhook race**, **G9 guest-cyclus atomicity by slot position** (first/middle/last full), **G5 split-race in the proposal/commitment subsystem** (still splits by committed headcount — open product question, deliberately excluded).

### P2 — not import-testable / integration
- **Edge-function `index.ts` bodies are NOT in CI** — only `_shared/` is deno-tested (`--no-check`). Function entrypoints (`serve(...)` at module load) can't be imported; 7 `index.test.ts` exist (e.g. `create-invoice-payment`, `generate-proposals`, `render-page`) but are NOT run by CI. Any logic that lives in `index.ts` rather than a `_shared/` helper is effectively untested by the gates.
- **G10 end-to-end webhook delivery** — no harness POSTs a synthetic Mollie form to the webhook against a seeded DB.
- **Google Calendar OAuth (P1-1, parked)** and **Stripe basil (P1-8, disputed)** — see [`audits/FULL_AUDIT_FRESH_EYES_2026-07-02.md`](audits/FULL_AUDIT_FRESH_EYES_2026-07-02.md); not a shipped feature path, low test priority.

### Coverage-mechanics gaps
- **No coverage threshold enforced** — `vitest run` has no `--coverage` gate; nothing fails a PR for lowering coverage. New untested code passes silently as long as existing tests stay green.
- **e2e is thin and journey-based** — payments/booking/roles/rls-health smoke only; not a correctness net.
- **PGlite adapter is intentionally narrow** — [`pgliteSupabase.ts`](../src/test/fixtures/pgliteSupabase.ts) implements only the query operators the money-path lib uses; a change using an unimplemented operator (`.contains`, `.single` variants, new embeds) will fail to run under PGlite until the adapter is extended (see [`TEST_FIXTURE_BACKLOG.md`](technical-debt/TEST_FIXTURE_BACKLOG.md)).

---

## Rule of thumb for an AI agent
If your change is on the money path (payment/booking/rebook/invoice/split) there is almost certainly an existing PGlite test near it — extend it. If your change is in an edge-function `index.ts`, move the logic into a `_shared/` helper so it can be tested at all. If you add a migration, add a `rehearse-*`. If nothing above covers your change, you are in a gap — say so and add the first test.
