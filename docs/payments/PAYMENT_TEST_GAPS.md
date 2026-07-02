# Payment Test Gaps

Money-path scenarios that are **not yet covered** by automated tests, why they matter, and how to close
them. Companion: [`PAYMENT_INVARIANTS.md`](PAYMENT_INVARIANTS.md), [`PAYMENT_FLOW_MAP.md`](PAYMENT_FLOW_MAP.md).

**Closed in Phase 3** (this foundation): amount-match incl. the multi-booking `bookingSumTolerance`
(`src/test/paymentAmountInvariant.test.ts`); charge-org==confirm-org resolution parity
(`src/test/chargeConfirmParity.pglite.test.ts`). The below remain.

Risk: **P0** = money lost/double-charged/cross-tenant; **P1** = stuck money/capacity, manual recovery; **P2** = observability/UX.

---

## G1 — Concurrent duplicate webhook deliveries (P0, invariant #15)

**Scenario:** two Mollie deliveries for the same payment id arrive simultaneously; both read the booking as
unpaid before either writes. The atomic-claim UPDATE (`payment_status != 'paid'` with `.select()`) should let
exactly one transition rows and run side effects; the other transitions 0.
**Why untested:** existing tests are sequential (`mollieWebhookWriteback.pglite.test.ts` calls the writeback
twice in series). True concurrency isn't exercised.
**Approach:** PGlite — open two transactions, both `SELECT ... FOR UPDATE`-free, run `applyBookingPaymentWriteback`
concurrently (Promise.all against two connections), assert exactly one returns rows. Or a Postgres-level
`pg_sleep` interleave. Files: `_shared/mollie-webhook-payment.ts:applyBookingPaymentWriteback`.

## G2 — Mollie idempotency-key on payment creation (P0, invariant #1) — ✅ ADDRESSED

**Scenario:** a network timeout after Mollie creates a payment but before the response returns → the client
retries `create-mollie-payment`/`create-guest-*-payment`/`create-invoice-payment` → Mollie may mint a SECOND
payment object (the M-11/M-15 reuse only sees the prior `mollie_payment_id` if it was persisted, which the
timeout case never does). Result: two Mollie payments, one charge orphaned = a double-charge vector.

**Fix (shipped):** an `Idempotency-Key` header is now sent on every `POST /v2/payments`, in all four charge
functions. Mollie's contract (docs.mollie.com/reference/api-idempotency): same key + IDENTICAL body within ~1h
→ replays the original (`Idempotent-Replayed: true`), no duplicate; same key + DIFFERENT body → **400**. We
therefore derive the key as a **faithful fingerprint of the exact request body** (`_shared/mollie-idempotency.ts`,
`canonicalStringify` → SHA-256 → 40 hex, scoped per fn — object keys normalized, **array order preserved** so the
key tracks the raw body Mollie diffs). Because Mollie compares the RAW body, callers normalize the one
order-unstable field first: `booking_ids` is sorted into a canonical order before the body is built
(`create-guest-cyclus-payment` sorts the RPC result; `create-mollie-payment` sorts a copy for the metadata). A
legitimate retry then re-sends a byte-identical body → replay → no duplicate; a body that genuinely differs gets
a new key → a fresh payment → never a same-key/different-body 400. Functions that drift-cancel a prior payment
(`create-mollie-payment`, `create-invoice-payment`) salt the key with the superseded payment id (kept readable on
the row until the fresh POST succeeds) so a re-price-back-to-original within 1h can't replay a dead checkout.
Verified twice against `docs.mollie.com`; helper unit-tested in `_shared/mollie-idempotency.test.ts`; adversarially
reviewed (two rounds — the first caught the fresh-path 400, the second the raw-array-order 400 + salt lifecycle).

**Documented residuals (not new regressions — behaviour equals pre-G2 for these):**
- *Pre-booking single path* (`create-mollie-payment`, empty `bookingIds`): `book_slot_for_payment` mints a NEW
  booking id per call, so a retry's body differs → a fresh payment (not deduped). No double-CHARGE (the customer
  only ever receives the retry's checkout; a 1-seat slot refuses the retry via `slot_full`), but a multi-seat
  retry can strand a `pending` booking row (no TTL sweep for logged-in pending rows). Follow-up: make
  `book_slot_for_payment` idempotent on (slot, player, recent unpaid pending) like the guest hold RPCs.
- *Split-amount headcount drift* (`create-mollie-payment` existing-bookings + `create-guest-cyclus-payment`): if
  a concurrent participant changes the split divisor between a timed-out attempt and its retry, the amount (hence
  the body, hence the key) changes → a second payable checkout. Not a NEW double-charge (that window predates
  G2); overlaps **G5** (split-cohort semantics — freeze vs re-divide, product decision).
- *cip drift-cancel salt is best-effort:* the re-price-back-to-original salt works whenever the superseding
  payment persisted (the common case — we now keep the old id on the row across the POST). In the rare *compound*
  window (re-price → drift-cancel → the superseding POST's response is LOST so its id never persisted), a retry
  reads no prior id → keys unsalted → a second checkout. Degrades to pre-G2 behaviour (not a new regression).

**Remaining test coverage gap:** the helper is unit-tested, but the Mollie-contract interactions
(same-key/different-body 400, replay-of-cancelled, body drift) are only reasoned about, not exercised against a
Mollie mock. A mocked edge-level test would raise confidence.
Files: `_shared/mollie-idempotency.ts`, `create-mollie-payment/index.ts`, `create-guest-slot-payment/index.ts`,
`create-guest-cyclus-payment/index.ts`, `create-invoice-payment/index.ts`.

## G3 — `verify-mollie-payment` vs `mollie-webhook` race (P1/P0, invariant #3/#15, "M-26")

**Scenario:** the sync `verify-mollie-payment` (ops/return-from-Mollie) and the async webhook both process the
same payment. The atomic claim means only one transitions rows — but if `verify-mollie-payment` does NOT use the
identical guarded write, it could double-run side effects (double invoice/email).
**Why untested:** no test exercises both paths on one payment.
**Approach:** confirm `verify-mollie-payment` uses `applyBookingPaymentWriteback` (it appears to at :350-361);
PGlite test: run webhook writeback then verify writeback on the same booking → second transitions 0 rows.
Files: `verify-mollie-payment/index.ts`, `_shared/mollie-webhook-payment.ts`.

## G4 — Charge-org==confirm-org CODE-PATH parity, not just predicate (P0, invariant #6)

**Scenario:** Phase 3 proved the *predicate* yields parity, and `guest-payment.test.ts` proves the CHARGE side
(`resolveSlotRecipient`) uses it. But the CONFIRM side (`resolveAccessToken`, private in `mollie-webhook`) is not
directly tested — a future edit could diverge the two functions.
**Why untested:** `mollie-webhook/index.ts` runs `serve(...)` at module load, so it can't be imported into a test.
**Approach (recommended P0 hardening):** extract the academy-trainers→org **predicate** into a shared
`_shared/mollie-recipient.ts` helper used by BOTH `resolveSlotRecipient` and `resolveAccessToken`
(+ `verify-mollie-payment`). One helper → one test → structural parity. Then a golden test asserts charge +
confirm return the same org for shared fixtures. Files: `_shared/guest-payment.ts`, `mollie-webhook/index.ts`,
`verify-mollie-payment/index.ts`.

## G5 — Split-payment divisor race (Codex F4) (P0/P1, logged-in cycle)

**Scenario:** `create-mollie-payment` fixes the split divisor (÷ distinct players) at charge time. If a second
player books the same cycle while the first is on the Mollie checkout, the first was charged `total/2` but the
cohort is now 3 — no re-division/compensation.
**Why untested:** no concurrent-cycle-booking split test.
**Approach:** PGlite/integration — seed a split cycle, first payer computes divisor 2, insert a second booker,
assert the invariant we want (either freeze the cohort at accept, or re-divide at webhook). This likely needs a
**product decision** first (freeze vs re-divide). Files: `create-mollie-payment/index.ts:293-305`, `cyclePayment.ts`.

## G6 — Logged-in cycle capacity lock (P1, invariant #9)

**Scenario:** the logged-in **cycle** booking inserts rows via a plain `insertBookings` facade with **no per-slot
advisory lock** (unlike single-slot's `book_slot_for_payment`). Two concurrent cycle bookings on the same slot
can overbook.
**Why untested:** no concurrent-cycle-insert test; the gap is structural (missing lock).
**Approach (recommended fix):** route the cycle insert through a capacity-locked RPC (mirror
`book_slot_for_payment`); then a PGlite concurrency test. Files: `src/lib/bookings.ts` (`insertBookings`),
`BookLesson.tsx:358-395`.

## G7 — Adversarial cross-tenant suite (P0, invariant #7)

**Scenario:** a token/claim holder minting or charging another tenant's bookings/invoices; a forged
`guest_player_id`; a trainer booking a slot scoped to an academy they're not in; a public token reading a sibling
invoice.
**Why untested:** partial — `rebookPublicGatherScope.pglite.test.ts` covers the rebook gather. No consolidated
adversarial suite.
**Approach:** one PGlite file, several attacks, each asserting the guard/RLS blocks the write/read. Files:
`create-rebook-invoice-public`, `book_guest_slot_for_payment`, `get-public-invoice`, RLS policies.

## G8 — Hold-expiry vs paid-webhook race (P1, invariant #4/#10)

**Scenario:** a hold's TTL sweep cancels it at the same instant a `paid` webhook arrives. The
`neq('status','cancelled')` guard prevents resurrection (→ `findCancelledPaidBookings` alert), but the timing is
untested.
**Approach:** PGlite — insert a `payment_pending` hold, cancel it, then run the paid writeback → assert 0
transitioned + the booking stays cancelled + it's flagged. Files: `_shared/mollie-webhook-payment.ts`,
`release_expired_guest_slot_holds`.

## G9 — Guest-cyclus atomicity by slot position (P1)

**Scenario:** `book_guest_cyclus_for_payment` rolls back ALL holds if any session is full. Tested for one full
session; not for first vs middle vs last full (loop exits at different points).
**Approach:** extend `guestCyclusBooking.pglite.test.ts` — parametrize which of 3 slots is full; assert 0 holds
each time. Files: the RPC migration.

## G10 — End-to-end webhook + registration mint-failure (P1/P2)

**Scenario:** no automated end-to-end covers a full Mollie webhook delivery (the handler has module side effects,
so it's not import-testable); `submit-guest-intake` mint-failure (business profile incomplete → registration saved
with no pay link, silently) is untested.
**Approach:** an integration harness that POSTs a synthetic Mollie form to the webhook against a seeded DB (bigger
lift); a unit test of the registration mint-failure branch asserting the reason + that it should Slack-alert (it
currently doesn't). Files: `mollie-webhook/index.ts`, `submit-guest-intake/index.ts`, `_shared/event-registration-invoice.ts`.

---

## Suggested order for the follow-up test PRs

1. **G4** (extract shared recipient predicate) — closes the top P0 with a small, high-value refactor.
2. **G6** (cycle capacity lock) + **G5 product decision** — the two real correctness risks.
3. **G1 / G3 / G8** concurrency/idempotency PGlite tests — lock the guarantees that are architecturally sound but unproven.
4. **G7** adversarial cross-tenant suite.
5. ~~**G2** Mollie idempotency-key~~ — ✅ done (body-fingerprint key on all 4 charge fns); a mocked edge-level Mollie-contract test is the remaining coverage item.
6. **G9 / G10** — completeness.
