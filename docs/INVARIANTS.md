# App-wide invariants

Purpose: the hard rules that must never break — where each is enforced, what tests cover it, and what
enforcement is still missing. Read this before any change to booking, payment, invoice, tenancy, or token
code.

Audience / AI-read: yes
Status: canonical (source of truth) | last updated 2026-08-07

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
(historical findings — the current audit of record is
[`audits/FOUNDATION_ARCHITECTURE_AUDIT_2026-08.md`](audits/FOUNDATION_ARCHITECTURE_AUDIT_2026-08.md)),
[`DOMAIN_MODEL.md`](DOMAIN_MODEL.md), [`adr/`](adr/).

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
| I-5 | A paid invoice cannot be hard-deleted or financially rewritten | `protect_paid_invoice_integrity` trigger (DELETE block + financial-field freeze; no service-role exemption) | 🟢 |
| I-6 | A paid booking cannot be silently cancelled / downgraded | unconditional `!= 'paid'` write guard + soft-cancel | 🟢 |
| I-7 | A cancelled booking is not resurrected by a stale webhook | `!= 'cancelled'` guard + alert | 🟢 |
| I-8 | Payment amount == invoice / booking amount | webhook amount guards + server-side recompute | 🟡 |
| I-9 | Charge org == confirm org | byte-identical recipient predicate (charge + webhook) | 🟢 |
| I-10 | Guest vs linked-player identity is server-derived, never client-supplied | RPC/edge identity resolution + RLS | 🟢 |
| I-11 | Public tokens expose only their own record | token-keyed RPCs + auto-revoke | 🟡 |
| I-12 | Payment webhooks are idempotent | atomic-claim UPDATE gates side effects | 🟢 |
| I-13 | No live edge function depends on an unapplied migration | process + CI `db reset` gate | 🔴 (process) |
| I-14 | A cycle/registration always has an existing owner; owners with programs cannot be deleted | owner-existence trigger + RESTRICT delete guards | 🟢 |
| I-15 | Every profile/guest maps to at most one person; a person has at most one profile/login | `person_links` UNIQUEs + CHECK + one-profile-per-person partial index | 🟢 |
| I-16 | A dual-keyed row belongs to the GUEST person (FAM-02); ownership predicates are pure-profile-guarded | pure-profile RLS policies + guest-first/guest-exclusive RPC arms | 🟢 |
| I-17 | A split-frozen guest is its OWN person — no person arm acts on its link | `is_guest_split_frozen()` gate on every person arm, both sides | 🟢 |
| I-18 | `person_id` columns are derived, never writer-trusted | SECURITY DEFINER stamp triggers (guest-first re-derivation) | 🟢 |
| I-19 | `persons` / `person_links` / `person_merge_review` are client-inaccessible (zero policies; definer-RPC or trusted service-role access) | RLS enabled with NO policies + REVOKEd helpers | 🟢 |
| I-20 | Invoice dedup resolves a guest-bearing recipient guest-EXCLUSIVELY; the lock serializes every pair the recheck can dedup | person-keyed `create_invoice_deduped` (freeze-independent lock key) | 🟢 |
| I-21 | `linked_profile_id` is never identity truth; an explicit twin stamp outranks it | backfill trust rule + twin-precedence readers | 🟢 |
| I-22 | A person-ref expansion inside a tenant-scoped reader is intersected with the tenant scope | in-scope-guests predicate on every ref-set expansion | 🟢 |

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

**Missing / open (corrected 2026-08-08):** the authenticated path — including cyclus inserts — IS covered:
the current `enforce_booking_slot_tier` revision (`20260715100000`) takes the slot advisory lock + seat
count for every authenticated insert with a real `slot_id`, and the service-role booking RPCs repeat the
guard internally. The trigger returns early for service-role writers, and the one service-role path with
NO lock/recount is `finalize_cycle_proposals` (`20260701120000` inserts bookings directly) — that is the
uncovered capacity path (supersedes the old "logged-in cyclus" wording). Separately, the capacity trigger
enforces *count*, not per-(slot, identity) uniqueness — I-3 covers the identity side. See backlog item B-1.

**Risk:** P1 (service-role proposal-finalization path only; needs concurrent finalizes/bookings on the
last seat).

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
`create_invoice_deduped` RPC (introduced as fresh-eyes P1-6 in `20260706120300`, superseded by the
**person-keyed** rewrite `supabase/migrations/20260902100000_phase34_create_invoice_deduped_person.sql`,
person-unification Phase 3.4): it runs the overlap dedup recheck **and** the INSERT inside one transaction
under `pg_advisory_xact_lock`, so concurrent same-recipient calls serialize — the second returns the first's
committed invoice instead of inserting. Post-3.4 the lock + recheck are keyed on the recipient's **person**
(guest-EXCLUSIVE, split-freeze-gated — see I-20) so a merged human's two keys (profile + guest) can no longer
double-bill the same bookings via different locks, and the RPC is **service_role-only**
(`REVOKE … FROM PUBLIC/anon/authenticated; GRANT EXECUTE … TO service_role`). Amount math is untouched —
the person keying changes only *who counts as the same recipient*, never a total or divisor.

**Tests:** structural (index) + `createInvoiceDeduped.pglite.test.ts` (runs the real migration; cross-key,
freeze, and dual-key double-bill cases); `auto-create-invoice` routes through the RPC.

**Missing / open:** the paid-match tolerance in the dedup path scales with booking count with no absolute cap
(fresh-eyes P3-5) — sub-euro drift can pass. Minor.

**Risk:** P0, now durably enforced (was a TOCTOU before the RPC).

## I-5 — A paid invoice cannot be hard-deleted or financially rewritten 🟢 (P0)

**Why:** deleting a paid invoice destroys the record of money received (accounting/VAT + customer proof).

**Enforced:** `protect_invoice_financial_columns` trigger blocks a *player* from mutating financial columns on
an invoice (`supabase/migrations/20260530120000_p0_protect_invoice_player_updates.sql`,
`20260624120000_protect_booking_financial_columns_for_players.sql`); `public_token` auto-revokes on
paid/cancelled. Cancellation of bookings is **soft** (`status='cancelled'`, never `DELETE`).

**Resolved (migration `20260908100000_protect_paid_invoice_integrity.sql`; doc corrected in the 2026-08-07
checkpoint):** the DB-final backstop now exists — `trg_protect_paid_invoice_integrity` blocks DELETE of a
paid invoice and freezes its financial composition/identity (total, subtotal, VAT fields, line items,
invoice number/date) on any UPDATE touching a paid row, with **no service-role or admin short-circuit**
(a plain trigger; applies to every writer). The lib facade is `deleteOrCancelInvoices`
(`src/lib/invoices.ts` — drafts DELETE, everything else soft-cancels; paid refused). Status transitions
(paid→cancelled/refunded), `pdf_url`, delivery flags, billing details, and `booking_ids` stay mutable by
design.

**Progress (2026-07-15, master-audit Theme A / R02+R03):** the biggest hard-delete *path* is closed — account
deletion no longer erases financial rows. `delete-user-data` retains invoices + slot bookings via an
anonymized-shell `trainer_profiles` (migration `20260826140000`: `invoices.trainer_id` +
`trainer_profiles.user_id` CASCADE→SET NULL, `invoices.guest_player_id` NO ACTION→SET NULL) and retains
player bookings via `bookings.anonymized_at` + `bookings.player_id` CASCADE→SET NULL (migration
`20260826130000`). `bulk-cleanup-users` (the admin wipe tool) now routes through the same shared
`deleteUserData` instead of its own drifted hard-delete copy, so **every** deletion door shares the
retained-financials semantics. The DB-level delete guard has since shipped (see above) — only a
superuser/table-owner SQL session can bypass a trigger.

**Risk:** P0-class protection, now durably enforced at the DB layer.

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

**Resolved (doc corrected in the 2026-08-07 checkpoint):** reversal detection now exists —
`detectPaymentReversal` (`supabase/functions/_shared/mollie-webhook-reversal*`) recognizes
`charged_back` and non-zero refunded/charged-back amounts; the webhook path alerts without resurrecting
or downgrading state (deliberately alert-only; tested in `mollie-webhook-reversal.test.ts`).

**Risk:** P0 for resurrection (guarded); reversal detection/alerting is resolved (alert-only by design).

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
the `0.01`×N tolerance is an undocumented magic number (P3-5). The former P2-6 recalc-overwrites-paid risk
is now blocked at the DB layer (`protect_paid_invoice_integrity` freezes paid composition; recalc also
filters out paid rows). See backlog B-9.

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
backlog B-8.

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
1. **RESOLVED (doc corrected in the 2026-08-07 checkpoint):** the `edge-typecheck` CI job
   (`check:edge-types`) runs a ratcheted real `deno check` over every discovered edge entrypoint;
   `edge-tests` still runs runtime tests on `_shared/` only.
2. No CI lint that fails a PR when an edge-fn diff references a new column/RPC without the migration in the
   same PR marked deploy-ordered.

See backlog B-6 and B-7.

**Risk:** P0 if broken; today it holds only by discipline + the `db reset` gate.

## I-14 — A cycle/registration always has an existing owner 🟢 (P1)

**Why (audit R22):** `cycles.owner_id` / `registrations.owner_id` are polymorphic (`owner_type` ∈
trainer|club|academy) and **cannot carry a real FK**. Without enforcement, an orphan owner_id was
insertable, and deleting an owner (e.g. the admin academy-delete flow) silently orphaned its programs —
every RLS policy filters `owner_id IN (SELECT …)`, so an orphaned cycle matches no owner and becomes an
unmanageable zombie still carrying slots/intake data.

**Enforced (migration `20260826170000`, FK-equivalent via triggers, zero app-surface change):**
`enforce_program_owner_exists` (BEFORE INSERT/UPDATE OF owner_id, owner_type on both tables) requires the
owner row to exist in the table `owner_type` names — FK insert-side. `guard_owner_has_no_programs`
(BEFORE DELETE on `trainer_profiles` / `club_profiles` / `academy_profiles`) refuses deleting an owner
that still owns programs, with an actionable count+hint — `ON DELETE RESTRICT` semantics; deleting an
owner's programs is a **deliberate act**, never a silent orphaning (Theme A's block-don't-automate
philosophy). Both SECURITY DEFINER (the existence check must not be defeated by RLS hiding the owner row
from the inserting user). Constant-time at volume: PK lookup + the existing
`idx_cycles_owner`/`idx_registrations_owner` `(owner_type, owner_id)` btrees.

**Compatible by construction:** `deleteUserData` deletes an owner's cycles *before* the owner row is
touched, and since Theme A the trainer row is anonymized (UPDATE), never deleted.

**Tests:** `ownerReferentialIntegrity.pglite.test.ts` (runs the real migration: orphan insert/update
blocked per owner type; owner delete blocked while owning programs; delete allowed after cleanup;
trainer-shell anonymize unaffected).

**Risk:** P1 (zombie data + skewed reporting, no direct money loss). Prod verified 0 orphans at
enforcement time (2026-07-15; 533 cycles + 12 registrations, all academy-owned).

---

## Person identity (unification program)

The [person-unification program](PERSON_UNIFICATION_PLAN.md) (IN EXECUTION — Phases 0–3.5d shipped)
introduces one canonical human (`persons`, "has a login" = `user_id IS NOT NULL`) behind the two
legacy tables (`profiles`, `guest_players`). The identity rules below are invariants **today** —
every shipped person-keyed reader/writer enforces them, and every future one must. The doctrine
source is `src/lib/personIdentity.ts`; the invariants here are its DB-layer enforcement.

## I-15 — Every profile/guest maps to at most one person; a person has at most one profile 🟢 (P0)

**Why:** the foundation of every person-keyed read. If one source row could map to two persons (or
one person absorb two profiles), person-keyed rosters, bookings, invoices, and the dedup guard would
conflate two humans' data and money while `persons.user_id` can represent only one login.

**Enforced:** `person_links` identity map (`supabase/migrations/20260826260000_persons_expand.sql`):
`profile_id` UNIQUE, `guest_player_id` UNIQUE, `CHECK` exactly-one-source per link row;
`persons.user_id` UNIQUE (one login per person); `person_links_one_profile_per_person` partial
unique index (`supabase/migrations/20260826270000_person_links_one_profile_per_person.sql`) — at
most 1 profile + N guests per person. The backfill
(`supabase/migrations/20260826280000_persons_backfill.sql`) mints **deterministic ids** (a profile's
person reuses the profile uuid; a guest-only person its guest uuid), hard-verifies (any invariant
violation RAISES and rolls back the whole migration), and installs AFTER INSERT live-mint triggers
so the map never decays on new signups. Auto-merge happens **only** on the locked unambiguous rules
(explicit twin stamp passing the trust rule, or a system-wide-unique exact-email match — never
inside a shared-email cluster); everything ambiguous queues in `person_merge_review` for owner
sign-off.

**Tests:** `personsExpand.pglite.test.ts`, `personsBackfill.pglite.test.ts` (run the real migrations).

**Risk:** P0, durably enforced at the DB layer.

## I-16 — FAM-02: a dual-keyed row belongs to the GUEST person 🟢 (P0)

**Why:** `player_id` on a both-keyed row (guest seat + profile key) is only ever added later by the
email linkers; families share emails, so on a divergent row profile-side attribution would hand one
family member's bookings/notes/money to another (typically the child's to the parent).

**Enforced:** guest-first derivation in every stamp trigger (guest link, then profile link —
`20260826260000_persons_expand.sql`); **ownership** predicates carry a **pure-profile guard** — the
direct player RLS policies on `bookings` are `player_id = me AND guest_player_id IS NULL`
(`supabase/migrations/20260826290000_phase31_person_display_readers.sql`, round-3 hardening), and
`can_report_attendance_on_slot` applies the same rule
(`supabase/migrations/20260831100000_phase33_attendance_person_rls.sql`) — so a dual-keyed row flows
**only** through the frozen, person-checked guest arm, never through a bare `player_id = me`. The
invoice-dedup recipient is guest-EXCLUSIVE (I-20). **Deliberate boundary:** relationship-VISIBILITY
helpers (`is_player_of_trainer` / `is_player_of_academy` — "does my person relate to this
trainer/academy?") are **not** pure-profile-guarded: either key legitimately establishes the
relationship. The guard belongs on *ownership* ("this row is mine to read/cancel/bill"), not on
*visibility*. A second deliberate boundary is the invoice **addressee exemption** (3.1-r3, kept in 3.2 —
`20260827100000_phase32_players_overview_person_dedup.sql:55-59`): an invoice *addressed* to a profile is
legitimately that account's to see and pay, so `get_my_invoices`
(`20260903100000_phase35a_player_invoice_visibility.sql:98`, split-freeze-gated outside the arms) and the
`generate-invoice` authz helper (`_shared/invoice-player-authz.ts`, including its documented deliberate
email fallback) keep a profile arm for guest-bearing invoices. Addressee-ship is payment authority, not
seat ownership — FAM-02's pure-profile guard governs seat/booking ownership, not invoice addressing.

**Tests:** `attendancePersonRls.pglite.test.ts`; the FAM-02 arms in
`createInvoiceDeduped.pglite.test.ts`.

**Risk:** P0, enforced on every shipped ownership surface (remaining player-facing surfaces are
being person-keyed in Phase 3.5).

## I-17 — A split-frozen guest is its OWN person 🟢 (P0)

**Why:** while a `twin_detached_needs_split` / `merged_guest_email_moved` review is **pending** in
`person_merge_review`, the guest's person link may describe a DIFFERENT human. Any reader or writer
acting on that link could show, merge, or bill the wrong person.

**Enforced:** `is_guest_split_frozen(_guest_player_id)`
(`supabase/migrations/20260827100000_phase32_players_overview_person_dedup.sql`; SECURITY DEFINER,
REVOKEd from clients) names the freeze. The doctrine, applied on **every person arm since Phase
3.1**: a frozen guest reads/keys as its own person, gated on **both sides** — the inbound row being
resolved AND the candidate/sibling being matched (e.g. the invoice dedup gates both the incoming
recipient and the sibling-invoice match —
`supabase/migrations/20260902100000_phase34_create_invoice_deduped_person.sql`). Advisory-lock keys
stay freeze-INDEPENDENT (see I-20) so serialization survives a mid-flight review.

**Tests:** the split-freeze cases in `playersOverviewPersonDedup.pglite.test.ts`,
`attendancePersonRls.pglite.test.ts`, `createInvoiceDeduped.pglite.test.ts` (frozen inbound, frozen
sibling, and unfreeze-restores-dedup).

**Risk:** P0 (wrong-human merge or bill), enforced.

## I-18 — `person_id` columns are derived, never writer-trusted 🟢 (P0)

**Why:** the 7 dual-keyed tables are client-UPDATEable under existing RLS and the financial-column
guard triggers don't cover the person columns — a writer-supplied `person_id` would be a forgeable
identity claim on money-bearing rows.

**Enforced:** the `stamp_person_id_*` BEFORE INSERT/UPDATE triggers
(`supabase/migrations/20260826260000_persons_expand.sql`, SECURITY DEFINER): any row that carries
(or carried) an old-world key gets its person column **recomputed** from `person_links` —
guest-side first (FAM-02) — never taken from the writer. The person columns sit in the triggers'
`UPDATE OF` lists precisely so a direct client write is immediately re-derived; keys removed by
anonymization derive NULL (no stale person survives); a row with no old-world keys (a future
new-world row) is writer-managed and untouched.

**Tests:** `personsExpand.pglite.test.ts` (including stamping under a restricted role — the
non-DEFINER silent-NULL bug class).

**Risk:** P0, enforced.

## I-19 — `persons` / `person_links` / `person_merge_review` are client-inaccessible (definer-RPC or trusted service-role access only) 🟢 (P0)

**Why:** `persons` aggregates identity + contact PII **across tenants** (one human can relate to
many trainers/academies), and `person_links`/`person_merge_review` expose the identity map itself.
No generic row-level policy can scope that safely — any broad read policy is a cross-tenant PII
leak.

**Enforced:** all three tables have RLS **enabled with ZERO policies BY DESIGN**
(`supabase/migrations/20260826260000_persons_expand.sql`,
`supabase/migrations/20260826280000_persons_backfill.sql`) — client roles cannot touch them at all.
Client-role access goes exclusively through deliberate SECURITY DEFINER RPCs that scope output to the
caller (`get_my_person_id`, `get_cycle_roster_names`, `get_players_overview`,
`get_person_refs_for_scope`, …); trusted service-role internals in edge functions may also read the
tables directly (service_role bypasses RLS by design — e.g. `_shared/invoice-player-authz.ts`,
`_shared/guest-whatsapp-optin.ts`); definer-internal helpers are additionally REVOKEd from
`anon`/`authenticated` (e.g. `is_guest_split_frozen`). **Do not "fix" the missing policies** — the absence IS the control. Any
future read policy is a deliberate, reviewed exception (Phase 3.5 scope), never a default.

**Tests:** the pglite suites exercise the readers under restricted roles; direct selects fail.

**Risk:** P0 (cross-tenant PII), enforced.

## I-20 — Invoice-dedup recipient is guest-EXCLUSIVE; lock and recheck keys cohere 🟢 (P0)

**Why:** after unification one human can hold BOTH a profile key and a guest key, so two invoice
creates for the same person's same bookings must (a) serialize on ONE advisory lock and (b) then
FIND each other in the recheck. Any key mismatch between lock and recheck reopens the P1-6
double-bill race cross-key; a recipient that falls through from an unlinked guest to a linked
profile would double-bill **statically** (no interleaving needed).

**Enforced:** the person-keyed `create_invoice_deduped`
(`supabase/migrations/20260902100000_phase34_create_invoice_deduped_person.sql`): a guest-bearing
payload (guest-only or dual-key) resolves its person via the guest link **only** — never COALESCE
into the profile link; the advisory lock keys **freeze-independently**, guest-first
(person → guest → profile), while the recheck's person arm is freeze-gated — so every pair of
creates the recheck could dedup takes the same lock in every freeze state; the RPC is
**service_role-only**. The caller stays person-consistent: `auto-create-invoice` fast-paths
dual-key payloads to the RPC and its 23505 fallback recomputes the recipient guest-first via
`supabase/functions/_shared/invoice-dedupe-recipient.ts`. Amount math untouched — this invariant
changes only *who counts as the same recipient*.

**Tests:** `createInvoiceDeduped.pglite.test.ts` (cross-key both directions, freeze both sides,
FAM-02 dual-key arms, distinct charges never merged).

**Risk:** P0, amount-neutral by construction.

## I-21 — `linked_profile_id` is never identity truth; an explicit twin stamp outranks it 🟢 (P0)

**Why:** `linked_profile_id` is an email-INFERRED trigger link with no trust rule; in shared-email
families it points at the wrong human. Consuming it as identity would hand one person another's
bookings, invoices, and rebook eligibility.

**Enforced:** hard rule in the backfill
(`supabase/migrations/20260826280000_persons_backfill.sql`): `linked_profile_id` is **never**
consumed as identity truth — it only seeds suggestions in the review report. The explicit,
manager-asserted `twin_of_profile_id` (`supabase/migrations/20260826210000_guest_twin_bridge.sql`)
is consumed only where the TRUST RULE passes (guest email matches the profile's case-insensitively,
or emailless `roster_registered_twin`). At read time, twin **outranks** linked in all player-side
readers (`supabase/migrations/20260826240000_twin_reader_precedence_and_lock.sql`), and repurpose
guards detach a stale stamp on rename / email-away. The twin bridge is a transition device: it
retires at Phase 4 once the P-B review queue drains — the person columns then carry identity alone.

**Tests:** `guestTwinBridge.pglite.test.ts`; twin-precedence cases in the reader suites.

**Risk:** P0, enforced.

## I-22 — A person-ref expansion inside a tenant-scoped reader is intersected with the tenant scope 🟢 (P0)

**Why:** `person_links` merges are **cross-tenant by design** (the backfill email-matches guests to
profiles system-wide), so "all refs of this person" routinely spans academies/trainers. A reader
scoped to one tenant that expands a passed ref to the person's full ref-set — and then feeds arms
without their own tenant predicate — surfaces ANOTHER tenant's associations (bookings, preferred
locations, intake) on this tenant's surface. Person-level truth does **not** trump tenancy: what a
tenant may see is decided by scope, not by the identity map.

**Enforced:** every shipped ref-set expansion intersects with the tenant's scope: `get_player_locations`
(`supabase/migrations/20260906100000_phase35d_small_readers_person.sql`) expands only guests owned by
the academy or its active trainers, and does **not** expand the (global, unscopable) profile side;
`get_players_overview` builds its guest sets from scope-filtered guests only
(`supabase/migrations/20260827100000_phase32_players_overview_person_dedup.sql`). Player-SELF readers
(`get_my_*`, `get_player_journey`) expand freely — the scope there is the person themself.

**Tests:** cross-tenant negatives in `smallReadersPerson.pglite.test.ts` (guest-side AND profile-side).

**Risk:** P0, enforced. Any NEW tenant-scoped reader that resolves person refs must add the same
intersection (and a cross-tenant negative test) — this invariant exists because the first version of
the 3.5d expansion shipped without it.

---

## When you touch this area

- Adding a new mutation path? It must respect I-1..I-22 **at the RPC/DB layer**, not just in the UI. See
  [`EXTENDING_THE_DOMAIN.md`](EXTENDING_THE_DOMAIN.md).
- Touching anything person-keyed? Every person arm must be split-freeze-gated on both sides (I-17),
  ownership predicates pure-profile-guarded (I-16), and identity resolved from `person_links` — never
  from `linked_profile_id` (I-21). See [`PERSON_UNIFICATION_PLAN.md`](PERSON_UNIFICATION_PLAN.md) and
  `src/lib/personIdentity.ts`.
- Broadening a query on the money path? Use the paging helpers in `src/lib/supabasePaging.ts` — never a bare
  unbounded `.in()` / `.select()` (PostgREST silently truncates at 1000; that was fresh-eyes P1-7).
- Changing a SECURITY DEFINER RPC? It bypasses RLS — carry an explicit ownership/auth check inside the function
  (the `swap_slots` P1-2 and `merge_guest_players` P1-3 fixes are the reference pattern).
- Any new enforcement gap you find → add it to [`technical-debt/INVARIANT_BACKLOG.md`](technical-debt/INVARIANT_BACKLOG.md).
