# ABC-23 §1 — paid-booking settlement caller inventory

Derived from effective source at `a54447cf`, before any edit. A *settlement transition* is any write
that records captured money (`payment_status='paid'`) **and** can turn a non-occupying booking into
an occupant. Those must all route through the single atomic command; everything else is listed with
its exclusion reason.

## In scope — must converge on the atomic command

| # | Caller | Path | Current settlement shape |
|---|---|---|---|
| 1 | `mollie-webhook/index.ts:1016` | direct booking / cart / cycle | `expired_holds_over_capacity` read (`:964`) → filtered `applyBookingPaymentWriteback` |
| 2 | `mollie-webhook/index.ts:460` | invoice-linked booking | `applyBookingPaymentWriteback(invoiceData.booking_ids, …)` |
| 3 | `mollie-webhook/index.ts:696` | rebook group/member | `applyBookingPaymentWriteback(memberBookingIds, …)` |
| 4 | `verify-mollie-payment/index.ts:366` | client-initiated verifier | `applyBookingPaymentWriteback(metadataIds, …)` |
| 5 | `_shared/mollie-webhook-payment.ts:113` | `applyBookingPaymentWriteback` | raw `.update()` + M-17 per-id/survivor fallback |
| 6 | `src/lib/markInvoicePaid.ts:32` | `markInvoicePaidAndSyncBookings` | browser-side invoice paid + booking sync |
| 7 | `src/components/trainer/InvoiceList.tsx:153` | manual "mark paid" UI | calls (6) directly from the browser |

### Why the classifier→UPDATE shape is the defect

`expired_holds_over_capacity` is `STABLE` and takes **no locks**; the write happens later in
`applyBookingPaymentWriteback`. Between the read and the write, capacity can change — two concurrent
settlements can both read "fits" and both confirm. It also uses transaction-start `now()` rather than
`clock_timestamp()`, and applies the raw `COALESCE(max_participants,1)` cap to every booking,
ignoring the purchase-path effective cap used at creation.

Today a `paid_no_seat` booking is merely **excluded** from `confirmBookingIds`, so the money is
captured while the row stays a stale `payment_pending` hold with no `paid` marker — the financial gap
ABC-23 closes.

## Excluded — creation-only or non-occupying, recorded deliberately

| Caller | Exclusion reason |
|---|---|
| `create-mollie-payment` | creates a `payment_pending` hold; never writes `paid`. Capacity serialized independently at creation. |
| `create-rebook-invoice` | mints an invoice; writes no booking status. |
| `get-guest-booking` | read-only projection. |
| `_shared/cycle-commitment-invoicing.ts` | invoice construction; no booking status write. |
| `src/lib/bookingPricing.ts`, `trainerEarnings.ts` | amount computation/reporting only. |
| `src/lib/bulkCycleBookings.ts`, `cycleExtensionBookings.ts`, `lessons.ts`, `playerBookings.ts` | staff-created bookings; occupancy decided at creation under the existing capacity path, never a paid settlement of a lapsed hold. |
| `src/lib/invoiceSync.ts` | mirrors invoice state; does not transition a hold into an occupant. |
| `src/lib/priorityClaims.ts` | claim lifecycle; booking creation only. |
| `src/lib/bookings.ts:264` | records EXTERNAL/manual payment (`payment_status`, `paid_at`, `paid_externally`) on an existing booking and writes **no** status, so it cannot turn a non-occupying booking into an occupant. Surfaced by the tripwire during §1 — the first inventory pass missed it. |

Any of these acquiring a paid-settlement transition later must be added here **and** routed through
the command — that is what the committed tripwire enforces.

## Tripwire

`src/test/abc23SettlementCallers.test.ts` fails if an inventoried caller reverts to a direct
paid+occupying update, or if a new file acquires that shape without being listed here.
