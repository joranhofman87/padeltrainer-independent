# App-wide invariants

Purpose: the hard rules that must never break — where each is enforced, what tests cover it, and what
enforcement is still missing. Read this before any change to booking, payment, invoice, tenancy, or token
code.

Audience / AI-read: yes
Status: canonical (source of truth) | last updated 2026-07-02

An **invariant** is a property that must hold no matter what any UI, edge function, direct API call, or
future AI edit does. The design principle: money/data integrity lives **at or below the RPC/DB layer** so a
page bug or a direct PostgREST call cannot break it. Enforcement layers, most durable first:
**DB constraint / partial unique index → RLS policy → SECURITY DEFINER/INVOKER RPC → edge function →
client-lib facade (`src/lib/*`) → UI.**

Companion docs (do not duplicate — link):
[`payments/PAYMENT_INVARIANTS.md`](payments/PAYMENT_INVARIANTS.md) (the money path, per-invariant test
matrix), [`payments/PAYMENT_FLOW_MAP.md`](payments/PAYMENT_FLOW_MAP.md) (charge→confirm sequence),
[`audits/CORE_BOOKING_DOMAIN_HARDENING_AUDIT.md`](audits/CORE_BOOKING_DOMAIN_HARDENING_AUDIT.md) (20-invariant
scale audit), [`audits/FULL_AUDIT_FRESH_EYES_2026-07-02.md`](audits/FULL_AUDIT_FRESH_EYES_2026-07-02.md)
(current findings), [`DOMAIN_MODEL.md`](DOMAIN_MODEL.md), [`adr/`](adr/).

Risk legend: **P0** = money lost / double-charged / cross-tenant leak · **P1** = stuck money or capacity
needing manual recovery · **P2** = observability/UX degradation. Enforcement legend: 🟢 durable (DB/RPC/RLS)
+ tested · 🟡 enforced but with a test or edge gap · 🔴 gap that belongs in
[`technical-debt/INVARIANT_BACKLOG.md`](technical-debt/INVARIANT_BACKLOG.md).

Current state as of 2026-07-02: the P0 forged-service-role-JWT bypass, and P1s P1-2 (swap_slots), P1-3
(merge data-loss), P1-4 (webhook 23505), P1-5/P2-7 (extras), P1-6 (invoice dedup), P1-7 (invoiceSync paging),
P1-9 (Mollie routing) from the fresh-eyes audit are **FIXED and DEPLOYED**. This doc reflects the
post-fix code.

---

## Invariant index

| # | Invariant | Enforced at | State |
|---|---|---|---|
| I-1 | Tenant A can never read/write/pay tenant B's records | RLS + edge auth + RPC ownership guards | 🟡 |
| I-2 | No overbooking (capacity respected) | capacity trigger + capacity-locked RPC | 🟡 |
| I-3 | No duplicate active booking per (player\|guest, slot) | DB partial unique index (M-17) | 🟢 |
| I-4 | No duplicate active invoice per booking | DB partial unique index + `create_invoice_deduped` RPC | 🟢 |
| I-5 | A paid invoice cannot be hard-deleted | trigger (updates) + 🔴 no delete guard | 🟡 |
| I-6 | A paid booking cannot be silently cancelled / downgraded | unconditional `!= 'paid'` write guard + soft-cancel | 🟢 |
| I-7 | A cancelled booking is not resurrected by a stale webhook | `!= 'cancelled'` guard + alert | 🟢 |
| I-8 | Payment amount == invoice / booking amount | webhook amount guards + server-side recompute | 🟡 |
| I-9 | Charge org == confirm org | byte-identical recipient predicate (charge + webhook) | 🟢 |
| I-10 | Guest vs linked-player identity is server-derived, never client-supplied | RPC/edge identity resolution + RLS | 🟢 |
| I-11 | Public tokens expose only their own record | token-keyed RPCs + auto-revoke | 🟡 |
| I-12 | Payment webhooks are idempotent | atomic-claim UPDATE gates side effects | 🟢 |
| I-13 | No live edge function depends on an unapplied migration | process + CI `db reset` gate | 🔴 (process) |

---

## I-1 — Tenant isolation: A can never read/write/pay B 🟡 (P0)

**Why:** cross-tenant read = data breach; cross-tenant write/pay = money misrouting.

**Enforced:** RLS on `bookings` / `invoices` / `intake_requests` / `guest_players` scoped via
`get_user_academy_ids` and `trainer_id = self`; `create-mollie-payment` validates `booking.player_id == caller`
(`supabase/functions/create-mollie-payment/index.ts`); token-gated public functions derive identity from the
token, never the request body. SECURITY DEFINER mutators that bypass RLS carry an explicit in-function
ownership check — e.g. `merge_guest_players` gates on `is_academy_manager` / trainer ownership
(`supabase/migrations/20260612140000_m17_unique_active_bookings.sql:85-104`), and `swap_slots` was hardened
to require ownership in `supabase/migrations/20260706120000_p1_2_swap_slots_ownership.sql` (fresh-eyes P1-2,
now fixed).

**Tests:** `guestPlayers.test.ts` (owner scoping), `bookingFinancialGuard.test.ts`,
`rebookPublicGatherScope.pglite.test.ts`; CI `db:rehearse:*` RLS invariants.

**Missing / open:** the fresh-eyes P2 RLS-leak cluster is still open — anon "view open cycles" leaks
`settings.notify_admin_emails` (P2-1), academy managers can read a shared trainer's full `guest_players`
roster (P2-2), `rebook_group_manage` appends to a client-supplied `_invoice_id` with no ownership scope
(P2-3), `get_player_locations` trusts a caller-supplied `guest_player_id` (P3-3). See
[INVARIANT_BACKLOG.md](technical-debt/INVARIANT_BACKLOG.md) and the fresh-eyes audit. A dedicated adversarial
cross-tenant test suite does not yet exist.

**Risk:** P0 for writes/pay (durably guarded); P2 for the remaining anon/PII read leaks.

## I-2 — No overbooking 🟡 (P1)

**Why:** selling more seats than a slot has = double-booked customers, refunds.

**Enforced:** single-slot booking goes through a capacity-locked RPC (`book_slot_for_payment` /
`book_guest_slot_for_payment`) using advisory locks + `FOR UPDATE`; the capacity predicate **excludes expired
holds** (`hold_expires_at > now()`) so abandoned checkouts self-heal; release crons
(`release_expired_guest_slot_holds`, `release_expired_rebook_holds`) cancel stale holds.

**Tests:** `guestSlotBooking.pglite.test.ts` (expired holds don't occupy capacity), `cyclePayment.test.ts`.

**Missing / open:** the **logged-in cyclus** insert is not routed through a per-slot capacity lock (the
capacity trigger counts seats but has no advisory lock on the cyclus path) → concurrent cyclus bookings can
overbook. Separately, the capacity trigger enforces *count*, not per-(slot, identity) uniqueness — I-3 covers
the identity side. See backlog item B-1.

**Risk:** P1 (concurrency-only, needs simultaneous cyclus bookings on the last seat).

## I-3 — No duplicate active booking per (player | guest, slot) 🟢 (P0)

**Why:** a retry-after-timeout or re-selecting an already-booked player would double-book + double-invoice.

**Enforced:** DB **partial unique indexes** (M-17,
`supabase/migrations/20260612140000_m17_unique_active_bookings.sql:44-52`):
`uniq_active_booking_per_slot_guest (slot_id, guest_player_id)` and
`uniq_active_booking_per_slot_player (slot_id, player_id)` over `status IN ('pending','confirmed','completed')`.
The player index exempts rows that also carry `guest_player_id` (signup-time linking backfills `player_id`
onto guest bookings). Bypasses RLS but **not** the hard unique index, so even a service-role writer collides.

**Tests:** `guestSlotBooking.pglite.test.ts` ("re-booking returns SAME live hold"); `db:rehearse` data-integrity.

**Edge handled (P1-4, fixed):** a guest `payment_pending` HOLD is *outside* the index status set, so a
concurrent staff-add could create a second `confirmed` row; when the webhook flips the hold to `confirmed` it
would hit 23505. `applyBookingPaymentWriteback` now **tolerates 23505** on the hold→confirmed transition —
per-id fallback that keeps the pre-existing active booking and cancels the redundant hold
(`supabase/functions/_shared/mollie-webhook-payment.ts:127-179`) — so the webhook never 500s / retries forever.

**Risk:** P0, well-enforced.

## I-4 — No duplicate active invoice per booking 🟢 (P0)

**Why:** two active invoices covering the same booking = the customer is billed twice.

**Enforced:** partial unique indexes `uniq_invoice_active_player_bookings` / `_guest_bookings` keyed on the
`md5` of the exact sorted `booking_ids` set (`supabase/migrations/20260503101100_*.sql`) — blocks an
identical-set duplicate. Overlapping-but-unequal sets ([A] vs [A,B]) are handled by the
`create_invoice_deduped` RPC (`supabase/migrations/20260706120300_p1_6_create_invoice_deduped.sql`, fresh-eyes
P1-6, fixed): it runs the overlap dedup recheck **and** the INSERT inside one transaction under
`pg_advisory_xact_lock` on the `(trainer, recipient)` key, so concurrent same-recipient calls serialize —
the second returns the first's committed invoice instead of inserting.

**Tests:** structural (index) + the `create_invoice_deduped` migration's own PGlite coverage; `auto-create-invoice`
routes through the RPC.

**Missing / open:** the paid-match tolerance in the dedup path scales with booking count with no absolute cap
(fresh-eyes P3-5) — sub-euro drift can pass. Minor.

**Risk:** P0, now durably enforced (was a TOCTOU before the RPC).

## I-5 — A paid invoice cannot be hard-deleted 🟡 (P2→P1 if broken)

**Why:** deleting a paid invoice destroys the record of money received (accounting/VAT + customer proof).

**Enforced:** `protect_invoice_financial_columns` trigger blocks a *player* from mutating financial columns on
an invoice (`supabase/migrations/20260530120000_p0_protect_invoice_player_updates.sql`,
`20260624120000_protect_booking_financial_columns_for_players.sql`); `public_token` auto-revokes on
paid/cancelled. Cancellation of bookings is **soft** (`status='cancelled'`, never `DELETE`).

**Missing / open (real gap):** there is **no** DB trigger or lib facade that forbids *deleting* a `paid`
invoice, and no `deleteInvoice`/`cancelInvoice` facade in `src/lib/` exists yet (grep: none). The
CORE hardening audit flagged this as E-009/E-010 (P2). The financial-columns trigger also **short-circuits for
service role** (`auth.uid() IS NULL`), so an edge function or admin path can still overwrite a paid invoice —
fresh-eyes P2-6 (`recalculate-invoices` has no status guard). See backlog B-2.

**Progress (2026-07-15, master-audit Theme A / R02+R03):** the biggest hard-delete *path* is closed — account
deletion no longer erases financial rows. `delete-user-data` retains invoices + slot bookings via an
anonymized-shell `trainer_profiles` (migration `20260826140000`: `invoices.trainer_id` +
`trainer_profiles.user_id` CASCADE→SET NULL, `invoices.guest_player_id` NO ACTION→SET NULL) and retains
player bookings via `bookings.anonymized_at` + `bookings.player_id` CASCADE→SET NULL (migration
`20260826130000`). The DB-level delete guard (trigger forbidding `DELETE` of a paid invoice) is **still
missing** — a direct service-role/SQL delete remains possible.

**Risk:** P2 today (no automated path deletes paid invoices), P1 if a future delete surface is added without a guard.

## I-6 — A paid booking cannot be silently cancelled / downgraded 🟢 (P0)

**Why:** flipping a `paid` booking back to pending/cancelled = customer paid, no seat.

**Enforced:** `applyBookingPaymentWriteback` carries `.neq('payment_status','paid')` **unconditionally**
(`supabase/functions/_shared/mollie-webhook-payment.ts`) — any out-of-order/stale delivery cannot downgrade a
paid row; `verify-mollie-payment` uses the same guarded write. Booking cancellation is always soft, preserving
the paid row. Players can't mutate financial booking columns (BEFORE-UPDATE trigger, `20260624120000`).

**Tests:** `mollieWebhookWriteback.pglite.test.ts` (stale open/pending does NOT downgrade paid).

**Risk:** P0, well-enforced.

## I-7 — A cancelled booking is not resurrected by a stale webhook 🟢 (P0)

**Why:** a late `paid` webhook on a released/cancelled seat must not re-sell it (overbook / money for nothing).

**Enforced:** `applyBookingPaymentWriteback` carries `.neq('status','cancelled')`; a payment landing on a
cancelled booking is detected by `findCancelledPaidBookings` → Slack alert for **manual** refund (deliberately
not auto-refunded). Expired-hold sweeps + the `!= 'cancelled'` guard mean a late paid webhook on a swept hold
alerts instead of resurrecting.

**Tests:** `mollieWebhookWriteback.pglite.test.ts` (no-resurrection; strict hold not resurrected).

**Missing / open:** refund/chargeback webhooks are silently ignored (fresh-eyes P2-5) — reversed payments stay
`paid`/`confirmed` with no alert. Not a resurrection, but the reversal is unreconciled. See backlog B-3.

**Risk:** P0 for resurrection (guarded); P2 for the unhandled-reversal observability gap.

## I-8 — Payment amount == invoice / booking amount 🟡 (P0)

**Why:** confirming a mis-priced payment books a seat for the wrong money / mis-reports VAT.

**Enforced:** the client-sent amount is **ignored** server-side — `create-mollie-payment` recomputes it; the
webhook's invoice branch checks `mollieAmount == invoice.total`, the booking branch checks
`sum(payment_amount) == paid` within tolerance; `distributeAmountCents` makes per-booking shares sum exactly to
the charge. The charge-vs-invoice **extras** divergence (fresh-eyes P1-5 authenticated under-charge, P2-7 guest
double-count) was fixed — see `supabase/migrations/20260706120200_p1_5_amount_includes_extras.sql` and the
single-source-of-truth extras decision so charge total and invoice total agree.

**Tests:** `mollieWebhookPayment.test.ts` (blocks marking paid on mismatch), `booking-pricing.test.ts`
(`amountsMatch`, `distributeAmountCents`).

**Missing / open:** the webhook validates the *charge* sum, not the invoice *total*, on the fresh-creation path;
`recalculate-invoices` can overwrite a just-paid invoice total with no status guard (P2-6). The `0.01`×N
tolerance is an undocumented magic number (P3-5). See backlog B-4.

**Risk:** P0; the systematic extras bug is fixed, residual gaps are P2/P3.

## I-9 — Charge org == confirm org 🟢 (P0)

**Why:** if the payment is created on academy A's Mollie but the webhook confirms against a different org, the
payment **strands** or money routes to the wrong account.

**Enforced:** `resolveSlotRecipient` (charge) and `resolveAccessToken` (webhook + `verify-mollie-payment`) apply
a **byte-identical** predicate keyed off `slot.academy_profile_id`. Post-P1-9 (fixed), an academy slot whose
academy Mollie is not charge-ready **REFUSES** rather than falling back to the trainer's personal Mollie
(`supabase/functions/_shared/guest-payment.ts:121-141`) — the trainer branch runs **only** for a trainer-owned
slot (no `academy_profile_id`), and the webhook applies the identical rule so charge-org == confirm-org.

**Tests:** `guest-payment.test.ts` (2-academy routing; single-academy unchanged).

**Missing / open:** no single golden test asserts `resolveSlotRecipient` and `resolveAccessToken` return the
same org for the same fixtures (only the charge side is unit-tested). Recommend logging the resolved
`mollie_org_id` on both sides for reconciliation. Low residual risk.

**Risk:** P0, now durably aligned.

## I-10 — Guest vs linked-player identity is server-derived 🟢 (P0)

**Why:** if a client could supply an arbitrary `player_id`/`guest_player_id`, it could attribute or charge
another tenant's identity.

**Enforced:** guest RPCs accept only `guest_player_id` and `resolveOrCreateGuestPlayer` never attributes an
existing registered player; guests are owner-scoped XOR (academy `academy_profile_id` **or** trainer
`trainer_id`, never both); token-gated public functions derive identity from the token; on signup,
`link_guest_data_to_profile` relinks guest bookings + invoices to `player_id` so both paths converge to the
same paid state.

**Tests:** `guestPlayers.test.ts`, `playerBookingsLinkedGuest.test.ts`, `link_guest_data_to_profile_test.sql`.

**Missing / open:** an end-to-end "guest pays → signup → sees paid booking + invoice" convergence test; the
failure case where the link trigger crashes (silent orphan). Covered as a test gap in PAYMENT_INVARIANTS #8.

**Risk:** P0, well-enforced.

## I-11 — Public tokens expose only their own record 🟡 (P2/P1)

**Why:** `invoice.public_token` and booking `public_token` grant login-free access — a token must reveal only
its own record, never sibling data.

**Enforced:** `get-public-invoice` looks up strictly by `public_token`; the token auto-revokes on
paid/cancelled (`trg_revoke_invoice_public_token`); token RPCs (`get_priority_claim_by_token`, guest booking
read) return trimmed field sets. Tokens are UUIDs (unguessable) — the URL *is* the secret.

**Tests:** `invoiceAccess.test.ts` (revocation), `publicInvoiceGetPublicInvoice.test.ts` (field presence).

**Missing / open:** `get-public-invoice` relies on `decidePublicInvoiceAccess('paid')` to hide the pay UI
rather than **hard-rejecting** a revoked-token read; no explicit "token X cannot read invoice Y" test. See
backlog B-5.

**Risk:** P2 (tokens are unguessable UUIDs; the gap is a hard-reject + a negative test, not a live leak).

## I-12 — Payment webhooks are idempotent 🟢 (P0)

**Why:** Mollie retries deliveries; a non-idempotent webhook double-mints invoices / double-sends emails /
double-confirms.

**Enforced:** the **atomic-claim** pattern — `applyBookingPaymentWriteback` and the invoice UPDATE
(`status='paid' WHERE status NOT IN ('paid','cancelled')` with `.select()`) return only the rows THIS delivery
transitioned; every side effect gates on `transitioned.length > 0`. `forward-invoice` atomically claims
`forwarded_at IS NULL`. Postgres row locking serializes concurrent duplicate deliveries.

**Tests:** `mollieWebhookWriteback.pglite.test.ts` (duplicate → 0 rows, group all-or-nothing),
`mollieWebhookPayment.test.ts` (side-effect gating).

**Missing / open:** truly-concurrent duplicate-delivery test; `verify-mollie-payment` vs webhook race (M-26).
Enforcement is architecturally sound.

**Risk:** P0, well-enforced.

## I-13 — No live edge function depends on an unapplied migration 🔴 (process invariant, P0 if broken)

**Why:** edge functions and DB migrations **do not auto-deploy** (only the frontend does, via Vercel). An edge
fn that reads a column/RPC not yet applied to prod throws at runtime → payments break with a green CI.

**Enforced by process, not code:** deploy order is migrations → functions; the money-path PR checklist and
CI's `supabase db reset` gate (validates the migration applies) live in
[`deployment/`](deployment/). The client uses `as never` casts for not-yet-typed columns/RPCs so a merge
doesn't fail typecheck — which is exactly why the runtime dependency must be caught at deploy time.

**Missing / open (real gaps):**
1. **No `deno check` / type-check on the 96 edge-function `index.ts` files** (fresh-eyes P2-9) — CI runs
   `deno test --no-check` on `_shared/` only, so a mistyped or un-imported symbol in `mollie-webhook/index.ts`
   ships as a runtime `ReferenceError` with a green build.
2. No CI lint that fails a PR when an edge-fn diff references a new column/RPC without the migration in the
   same PR marked deploy-ordered.

See backlog B-6 and B-7.

**Risk:** P0 if broken; today it holds only by discipline + the `db reset` gate.

---

## When you touch this area

- Adding a new mutation path? It must respect I-1..I-12 **at the RPC/DB layer**, not just in the UI. See
  [`EXTENDING_THE_DOMAIN.md`](EXTENDING_THE_DOMAIN.md).
- Broadening a query on the money path? Use the paging helpers in `src/lib/supabasePaging.ts` — never a bare
  unbounded `.in()` / `.select()` (PostgREST silently truncates at 1000; that was fresh-eyes P1-7).
- Changing a SECURITY DEFINER RPC? It bypasses RLS — carry an explicit ownership/auth check inside the function
  (the `swap_slots` P1-2 and `merge_guest_players` P1-3 fixes are the reference pattern).
- Any new enforcement gap you find → add it to [`technical-debt/INVARIANT_BACKLOG.md`](technical-debt/INVARIANT_BACKLOG.md).
