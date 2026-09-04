# ABC-23 — paid-booking settlement caller inventory

A *settlement transition* is any write that records captured money (`payment_status='paid'`) **and**
can turn a non-occupying booking into an occupant. Every one of them goes through a single atomic
SQL command, `settle_paid_bookings`; everything else is listed below with its exclusion reason.

The §1 inventory recorded the situation before any edit. This is the state after §§3–5.

## The authority

`public.settle_paid_bookings(uuid[], text, text, uuid, uuid, uuid, text)` — `SECURITY DEFINER`,
`service_role` EXECUTE only, `search_path` pinned. Under the slot and per-booking advisory locks it
decides capacity, resolves M-17 survivors, settles the invoice, and returns a typed outcome:

| Outcome | Meaning | Customer confirmation? |
|---|---|---|
| `confirmed_paid` | FIRST paid transition | **yes — only here** |
| `already_confirmed_paid` | already paid before this request (duplicate delivery) | no |
| `paid_no_seat` | money captured, no seat: recorded `cancelled` + `paid` (first observation) | no |
| `replayed_paid_no_seat` | a previous request already recorded that | no |
| `refused` + `refusal_reason` | nothing was written | no |
| `invoice_paid_now` | TRUE only for the request that transitioned the invoice | gates notify/forward |

`invoice_paid_now` is a separate column, not a `refusal_reason` value: a caller testing
`refusal_reason IS NOT NULL` must never read a successful settlement as a failure.

Settlement source is explicit. `'mollie'` writes provider columns; `'manual'` writes **none** — no
Mollie id is invented for a payment that did not come from Mollie, because such a value corrupts
every reconciliation that joins on it.

## In scope — converged on the command

| # | Caller | Path | Shape now |
|---|---|---|---|
| 1 | `mollie-webhook/index.ts` | direct booking / cart / cycle | `settlePaidBookings({source:'webhook_direct'})` with the COMPLETE stored set; `expired_holds_over_capacity` no longer read |
| 2 | `mollie-webhook/index.ts` | invoice-linked | one call settles invoice **and** bookings; the former invoice-first UPDATE and the later "also sync bookings" block are both gone |
| 3 | `mollie-webhook/index.ts` | rebook group / member | covered set derived from stored claims (`memberSettlementBookingIds`), payer attribution stamped inside the same transaction |
| 4 | `verify-mollie-payment/index.ts` | client-initiated verifier | same command; a failed or refused settlement returns `paid:false, settled:false` — it can no longer report success |
| 5 | `settle-invoice-manual/index.ts` | **new** authenticated manual boundary | caller's JWT → `can_settle_invoice_manually` → service role → command, source `'manual'` |
| 6 | `_shared/settlement.ts` | the typed client for 1–5 | request-local outcome; no process-global state, no `__invoice_id`, no raw-write fallback |
| 7 | `src/lib/markInvoicePaid.ts` | browser shim | invokes (5); sends only the invoice id |
| 8 | `src/components/trainer/InvoiceList.tsx` | manual "mark paid" | calls (7) |
| 9 | `src/pages/trainer/TrainerEditInvoice.tsx` | manual "mark paid" | calls (7) |
| 10 | `src/pages/academy/AcademyEditInvoice.tsx` | manual "mark paid" | calls (7) |

`_shared/mollie-webhook-payment.ts` keeps `applyBookingPaymentWriteback`, now used **only** for
NON-paid deliveries (open/pending/failed/expired, including late or out-of-order ones). Those never
write `paid` and cannot seat anyone; the helper's job there is to refuse downgrades and
resurrections. It is no longer on any settlement path.

### Manual-settlement authorization

`can_settle_invoice_manually(uuid)` mirrors the two `public.invoices` UPDATE policies exactly:

- owning trainer — `trainer_id ∈ (SELECT id FROM trainer_profiles WHERE user_id = auth.uid())`
- academy manager — `academy_profile_id IS NOT NULL AND is_academy_manager(auth.uid(), …)`

There is deliberately **no admin arm**: no admin UPDATE policy on `public.invoices` exists, so
adding one would widen authority under cover of a refactor. An admin who is also the owning trainer
or an academy manager passes through those arms. The player arm is excluded too — players may edit
billing details only, and a trigger already blocks them from financial columns. `auth.uid() IS NOT
NULL` is load-bearing: the service role must not satisfy a user check by accident.

## Excluded — creation-only or non-occupying

| Caller | Exclusion reason |
|---|---|
| `create-mollie-payment` | creates a `payment_pending` hold; never writes `paid`. |
| `create-rebook-invoice` | mints an invoice; writes no booking status. |
| `get-guest-booking` | read-only projection. |
| `_shared/cycle-commitment-invoicing.ts` | invoice construction; no booking status write. |
| `_shared/mollie-webhook-payment.ts` | non-paid deliveries only (see above). |
| `src/lib/bookingPricing.ts`, `trainerEarnings.ts` | amount computation / reporting only. |
| `src/lib/bulkCycleBookings.ts`, `cycleExtensionBookings.ts`, `lessons.ts`, `playerBookings.ts` | staff-created bookings; occupancy decided at creation, never a paid settlement of a lapsed hold. |
| `src/lib/invoiceSync.ts` | mirrors invoice state; does not transition a hold into an occupant. |
| `src/lib/priorityClaims.ts` | claim lifecycle; booking creation only. |
| `src/lib/bookings.ts:264` | records EXTERNAL/manual payment (`payment_status`, `paid_at`, `paid_externally`) on an existing booking and writes **no** status, so it cannot turn a non-occupying booking into an occupant. Surfaced by the tripwire during §1. |
| `expired_holds_over_capacity` (SQL) | retained for diagnostics; **no** settlement path reads it. It is `STABLE` and lock-free, so its answer can be stale by the time a write happens — that read-then-write gap is the defect ABC-23 removes. |

## Reconciliation

`reconcile_payments(interval)` is re-emitted with checks 1–9 byte-identical and the authorization
gate unchanged (admin JWT, or a NULL uid = the service role running the nightly job). Check 10 is
new:

- `paid_no_seat` — **P0**, one row per booking with `status='cancelled' AND payment_status='paid'`.
- Deliberately **not** bounded by `_since`. Every other check is a freshness sweep; this one is an
  open financial obligation, and a window would quietly retire exactly the cases that went unhandled
  longest.
- It clears when the operator sets the local `payment_status` to `'refunded'` after refunding in
  Mollie. No automated refund, no operator queue, no credit/rebook workflow, no new table.

`invoice-health-check` consumes it through the existing generic path: every returned `check_name` is
grouped and pushed as `reconcile:<check_name>`, so `reconcile:paid_no_seat` reaches Slack with no
change to that function.

## Tripwire

`src/test/abc23SettlementCallers.test.ts` fails if an inventoried caller reverts, or if a new file
acquires a settlement shape unlisted here. Each detector is mutation-proved individually against a
mutated copy of the real source: restoring the classifier as a decision, restoring an invoice-first
paid UPDATE, deleting the authority call in the webhook / verifier / manual boundary, swallowing a
verifier settlement failure, and restoring browser raw settlement in any of the three UI files.
