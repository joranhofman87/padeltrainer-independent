# Test Coverage Gaps

Purpose: an honest map of what is well-covered vs. what is not, with concrete file references, so an AI agent knows where a change is risky and un-guarded.
Audience / AI-read: yes
Status: canonical (source of truth) | last updated 2026-07-18

Companion (deeper, per-scenario): [`payments/PAYMENT_TEST_GAPS.md`](payments/PAYMENT_TEST_GAPS.md) (G1–G10), [`payments/PAYMENT_INVARIANTS.md`](payments/PAYMENT_INVARIANTS.md). Manual coverage: [`../TEST_RUNBOOK.md`](../TEST_RUNBOOK.md). Baseline snapshot (pre-QA, now historical): [`../TEST_BASELINE.md`](../TEST_BASELINE.md). Testability setup: [`archive/testability-report.md`](archive/testability-report.md).

**Inventory today:** 420 vitest files (`src/**/*.test.{ts,tsx}`), of which **93 are PGlite integration** (`*.pglite.test.ts`) running the real lib/migration SQL against real Postgres; **28 deno `_shared` test files**; **26 playwright e2e specs** (15 `e2e/` + 9 `e2e/local/` mock-Mollie money-path + 2 `tests/`); **44 `scripts/db/rehearse-*`** SQL-invariant scripts (`db:rehearse:all` gates a subset). 98 of the vitest files are `.tsx` component tests.

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

## Well covered (person unification — phases 1–3.5, all PGlite against the real migration SQL)

Every person-keyed migration ships with its own suite; each pins the shared doctrine (FAM-02 guest-first on dual-keyed rows, split-freeze on both arms, twin-bridge precedence) for its surface. Reality doc: [`PERSON_UNIFICATION_PLAN.md`](PERSON_UNIFICATION_PLAN.md).

- **Phase 1–2 (expand + backfill):** [`personsExpand.pglite.test.ts`](../src/test/personsExpand.pglite.test.ts) (constraints, RLS lockdown, derived-only stamp triggers), [`personsBackfill.pglite.test.ts`](../src/test/personsBackfill.pglite.test.ts) (the prod-rehearsal fixture set for backfill + merge + review queue).
- **Phase 3.1–3.2 (display readers):** [`getCycleRosterNames.pglite.test.ts`](../src/test/getCycleRosterNames.pglite.test.ts), [`playersOverviewPersonDedup.pglite.test.ts`](../src/test/playersOverviewPersonDedup.pglite.test.ts) (merged human = ONE overview row), [`academyCyclusGroupsPersonKey.pglite.test.ts`](../src/test/academyCyclusGroupsPersonKey.pglite.test.ts).
- **Phase 3.3 (detail refs, booking gate, attendance):** [`getPersonRefsForScope.pglite.test.ts`](../src/test/getPersonRefsForScope.pglite.test.ts) (+IDOR guards), [`canBookMemberWindowPerson.pglite.test.ts`](../src/test/canBookMemberWindowPerson.pglite.test.ts), [`attendancePersonRls.pglite.test.ts`](../src/test/attendancePersonRls.pglite.test.ts) (real RLS under `SET ROLE authenticated`).
- **Phase 3.4 (money):** [`createInvoiceDeduped.pglite.test.ts`](../src/test/createInvoiceDeduped.pglite.test.ts) (person-level double-bill guard across a merged person's two keys).
- **Phase 3.5 (invoice visibility, RLS helpers, login flags, notes/journey, small readers):** [`getMyInvoices.pglite.test.ts`](../src/test/getMyInvoices.pglite.test.ts), [`isPlayerOfAcademyPerson.pglite.test.ts`](../src/test/isPlayerOfAcademyPerson.pglite.test.ts), [`getBookingLoginFlags.pglite.test.ts`](../src/test/getBookingLoginFlags.pglite.test.ts), [`notesJourneyPerson.pglite.test.ts`](../src/test/notesJourneyPerson.pglite.test.ts), [`smallReadersPerson.pglite.test.ts`](../src/test/smallReadersPerson.pglite.test.ts) (`get_academy_cyclus_labels` + `get_player_locations`, which previously had NO coverage).
- **Twin bridge (retires at Phase 4):** [`guestTwinBridge.pglite.test.ts`](../src/test/guestTwinBridge.pglite.test.ts) (forged `_trainer_ids` ignored; cross-academy twin invisible; definer-only under RLS).

## Partially covered

- **Cycle/slot generation + edit:** good lib coverage ([`slotGenerator.pglite.test.ts`](../src/test/slotGenerator.pglite.test.ts), [`applySlotEditToCycle.test.ts`](../src/test/applySlotEditToCycle.test.ts), [`applySlotDeleteToCycle.test.ts`](../src/test/applySlotDeleteToCycle.test.ts), [`cycleRoster.pglite.test.ts`](../src/test/cycleRoster.pglite.test.ts); `publishCycle.pglite.test.ts` was retired with the heal machinery in PR #380 — [`openGeneratorDrafts.pglite.test.ts`](../src/test/openGeneratorDrafts.pglite.test.ts) covers the one-time draft promotion) — but concurrency (two editors) untested.
- **Registration/intake:** pricing goldens exist ([`registrationPricing.test.ts`](../src/test/registrationPricing.test.ts), [`registration-pricing.golden.test.ts`](../supabase/functions/_shared/registration-pricing.golden.test.ts)) but the two duplicated email-composer build sites (client self-reg vs `submit-guest-intake` server) are only spot-checked; the mint-failure branch (business profile incomplete → registration saved with no pay link) is untested (PAYMENT_TEST_GAPS **G10**).
- **UI components:** 98 `.tsx` tests, but that is a fraction of ~79 pages/dozens of components — coverage is concentrated on cycle-detail, slot forms, invoice lists, players tables. Most pages have no render test.

## Gaps (ranked by risk)

### P0 / P1 — money & correctness (all detailed in PAYMENT_TEST_GAPS.md)
1. **G1 concurrent duplicate webhooks** — two simultaneous deliveries; only sequential is tested. Structurally sound (atomic claim) but unproven under true concurrency.
2. **G3 `verify-mollie-payment` vs `mollie-webhook` race** — no test runs both paths on one payment (double side-effect risk). Narrowed: [`priorityClaimFinalize.pglite.test.ts`](../src/test/priorityClaimFinalize.pglite.test.ts) pins the shared finalizer both paths converge on for priority claims, but the general two-paths-one-payment race is still untested.
3. **G4 charge-org == confirm-org CODE-PATH parity** — MOSTLY CLOSED: the recommended extraction shipped as [`_shared/mollie-token-resolution.ts`](../supabase/functions/_shared/mollie-token-resolution.ts) (`mollie-webhook/index.ts` imports `resolveAccessToken` from it), and [`chargeConfirmParity.pglite.test.ts`](../src/test/chargeConfirmParity.pglite.test.ts) pins the predicate on both sides. Remaining sliver: the shared module has no direct deno test of its own.
4. **G6 logged-in cycle capacity lock** — `insertBookings` has no per-slot advisory lock (unlike `book_slot_for_payment`); concurrent cycle bookings can overbook. Structural gap; owed a concurrency test if `src/lib/bookings.ts` is touched. (Still true as of 2026-07-18.)
5. **G7 adversarial cross-tenant suite** — PARTIALLY SUPERSEDED by per-RPC IDOR pins: [`getPersonRefsForScope.pglite.test.ts`](../src/test/getPersonRefsForScope.pglite.test.ts) (out-of-scope guest/profile rejected), [`guestTwinBridge.pglite.test.ts`](../src/test/guestTwinBridge.pglite.test.ts) (forged `_trainer_ids` ignored, cross-academy twin invisible), [`academyCyclusGroupsPersonKey.pglite.test.ts`](../src/test/academyCyclusGroupsPersonKey.pglite.test.ts) (unmanaged-academy refusal), plus the original `rebookPublicGatherScope`. The CONSOLIDATED forged-`guest_player_id` / sibling-invoice-read sweep across ALL surfaces remains open — do it as Phase-4-prep, when the single-key cutover makes every read path person-shaped at once.
6. **G8 hold-expiry vs paid-webhook race** — the structural oversell guard is now pinned ([`expiredHoldsOverCapacity.pglite.test.ts`](../src/test/expiredHoldsOverCapacity.pglite.test.ts): the webhook refuses to confirm an expired hold on an already-full slot); the true race timing is still untested. **G9 guest-cyclus atomicity by slot position** (first/middle/last full) and **G5 split-race in the proposal/commitment subsystem** (still splits by committed headcount — open product question, deliberately excluded) remain open.

### P2 — not import-testable / integration
- **Edge-function `index.ts` bodies are NOT in CI** — only `_shared/` is deno-tested (`--no-check`). Function entrypoints (`serve(...)` at module load) can't be imported; 7 `index.test.ts` exist (e.g. `create-invoice-payment`, `generate-proposals`, `render-page`) but are NOT run by CI. Any logic that lives in `index.ts` rather than a `_shared/` helper is effectively untested by the gates.
- **G10 end-to-end webhook delivery** — LOCALLY CLOSED, NOT CI-GATED: `npm run e2e:local` (`scripts/db/e2e-local-paid.sh`) seeds a DB, starts a mock Mollie (`scripts/db/mock-mollie.mjs`) and serves the edge functions against it; [`e2e/local/public-booking-webhook.spec.ts`](../e2e/local/public-booking-webhook.spec.ts) + [`e2e/local/rebook-upfront-webhook.spec.ts`](../e2e/local/rebook-upfront-webhook.spec.ts) (9 specs total in `e2e/local/`) drive the real create-payment → webhook → mark-paid loop. CI does not run them — treat as a manual pre-deploy check.
- **Google Calendar OAuth (P1-1, parked)** and **Stripe basil (P1-8, disputed)** — see [`audits/FULL_AUDIT_FRESH_EYES_2026-07-02.md`](audits/FULL_AUDIT_FRESH_EYES_2026-07-02.md); not a shipped feature path, low test priority.

### Coverage-mechanics gaps
- **No coverage threshold enforced** — `vitest run` has no `--coverage` gate; nothing fails a PR for lowering coverage. New untested code passes silently as long as existing tests stay green. (Still true as of 2026-07-18.)
- **CI e2e is thin and journey-based** — the CI-run specs are payments/booking/roles/rls-health smoke only; the real correctness net (`e2e/local/`, mock-Mollie money path) is manual (see G10 above).
- **PGlite adapter is intentionally narrow** — [`pgliteSupabase.ts`](../src/test/fixtures/pgliteSupabase.ts) implements only the query operators the money-path lib uses; a change using an unimplemented operator (`.contains`, `.single` variants, new embeds) will fail to run under PGlite until the adapter is extended (see [`TEST_FIXTURE_BACKLOG.md`](technical-debt/TEST_FIXTURE_BACKLOG.md)).

---

## Rule of thumb for an AI agent
If your change is on the money path (payment/booking/rebook/invoice/split) there is almost certainly an existing PGlite test near it — extend it. Same for anything person-keyed (persons/person_links/`get_*` readers/RLS helpers): every phase migration has a same-named suite in `src/test/` — extend that suite, and keep its FAM-02 / split-freeze / twin-bridge pins green. If your change is in an edge-function `index.ts`, move the logic into a `_shared/` helper so it can be tested at all. If you add a migration, add a `rehearse-*`. If nothing above covers your change, you are in a gap — say so and add the first test.

## Short links (`/s/<code>`) — see [`SHORT_LINKS.md`](./SHORT_LINKS.md)

**Covered:** `scripts/db/rehearse-short-links.ts` (SQL: idempotency, collision retry, open-redirect
guard, anon-cannot-mint / anon-can-resolve grants, best-effort trigger); `src/lib/cycleRegistrationUrl.test.ts`
(URL branches + `shareUrlForRegistration` short-vs-long); `src/lib/shortLinks.test.ts` (format +
`getShortCodesByTarget` error-resilience); `src/hooks/useCopyToClipboard.test.ts` +
`src/components/ui/CopyLinkButton.test.tsx`; `src/test/shortLinkContract.test.ts` (the SQL
charset/length ⊆ Worker regex contract — reads both files).

**Still a gap:** `docs/cloudflare-worker.js` `/s/` branch itself (the regex, 301/302 selection, cache
key, noindex-404) is a plain `.js` file outside the type/test gates — the contract test guards the
charset drift, but the branch's runtime behavior is only verified by post-deploy `curl`.
