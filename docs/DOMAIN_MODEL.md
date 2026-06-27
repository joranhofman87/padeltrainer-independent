# Domain model & write boundaries

> **Read this before changing any scheduling, registration, booking, or invoicing code.**
> It is the authoritative map of the core entities, who owns which fields, and the **one**
> place each kind of write is allowed to happen. The money/data-correctness rules here are
> load-bearing — several have been the subject of real bugs (stale billing, double-billing,
> cascade booking loss, paid→pending downgrades). When in doubt, route the write through the
> canonical function named below rather than issuing a raw `supabase.from(...).insert/update/delete`.

Related: [`SCHEDULING_ARCHITECTURE.md`](./SCHEDULING_ARCHITECTURE.md) (academy-first UX strategy),
[`FRONTEND_ARCHITECTURE.md`](./FRONTEND_ARCHITECTURE.md) (component/role isolation),
[`PHASE2_REGISTRATIONS_SPLIT.md`](./PHASE2_REGISTRATIONS_SPLIT.md) (the migration that created the split).

---

## 1. Entities

| Entity | Table | What it is |
|---|---|---|
| **Registration** | `registrations` | The **intake form** / sign-up campaign: form config, FORM-only `settings`, `price_table`, name/status/dates. NOT a training container. Paired 1:1 to a training cycle via `source_cycle_id`. |
| **Cycle** | `cycles` (`type='cyclus'`) | The **training container**: owns its `availability_slots` → `bookings` → `invoices`, plus TRAINING-only `settings` (e.g. `scoring_weights`). Also the home of `intake_requests.cycle_id`. |
| **Slot** | `availability_slots` | One scheduled session. **Source of truth for price** (`price_per_session`), `split_payment`, VAT flag, location, time. `cyclus_id` groups a cycle's slots (no FK historically; a NOT-VALID FK added in `20260630120000`). |
| **Booking** | `bookings` | A player (registered `player_id` XOR guest `guest_player_id`) on a slot. `slot_id` is `ON DELETE CASCADE` — deleting a slot destroys its bookings. |
| **Invoice** | `invoices` | Bills a set of bookings. References them by a **`booking_ids uuid[]` array — there is NO foreign key**, so a deleted/cancelled booking is NOT auto-removed; reconciliation is explicit (see §5). Carries `cycle_id` (training link) + additive `registration_id` (form link). |
| **Intake request** | `intake_requests` | A form submission. Keeps `cycle_id` (training link, load-bearing for proposals) + additive `registration_id` (form link). |
| **Proposed assignment** | `proposed_assignments` | A draft "this intake → this slot/trainer" pairing, reviewed before finalize. Links via `intake_request_id`. |

### Relationships (text diagram)

```
registrations ──source_cycle_id──▶ cycles(type='cyclus') ──cyclus_id──▶ availability_slots ──slot_id──▶ bookings
      ▲                                  ▲                                                                  │
      │ registration_id (additive)       │ cycle_id (load-bearing)                                          │ booking_ids[] (NO FK)
      │                                  │                                                                  ▼
 intake_requests ─────────────────────────────────────────────────────── proposed_assignments         invoices
```

---

## 2. The registrations ↔ cycles split (current end-state — write path is LIVE)

Phase 2 physically split the old overloaded `cycles` table; the **write path is finished and deployed**
(Phase 4 — supersedes the "write API not yet built" wording in older PHASE2/PHASE4 docs):

- A **registration form** is a `registrations` row. Its **`source_cycle_id`** points at a paired
  `type='cyclus'` cycle **shell** that exists so `intake_requests.cycle_id`'s link is satisfiable the
  moment the form opens.
- `intake_requests` and `invoices` **keep `cycle_id`** (the training link — proposals/finalize key off it)
  and carry an **additive nullable `registration_id`** (the form link). `proposed_assignments` is unchanged.
- For dual-read, `registrationToCycle` maps a registration to a cycle-shaped object with `id = source_cycle_id`
  and `type = format`. **This `id = source_cycle_id` mapping is intentional, not a bug.**

There is **no group entity**: a "cyclus group" in the overview is just the set of slots sharing a `cyclus_id`.

---

## 3. Field ownership

`cycles.settings` historically held both form and training keys. The split moved the **FORM** keys onto
`registrations.settings`; the **TRAINING** keys stay on the cycle. The single allowlist that partitions them
is asserted against a frozen golden (`src/test/fixtures/settingsSplit.golden.ts`; production twin
`pickFormSettings` in `src/lib/registrations.ts`). Do not split settings by hand — extend the allowlist + golden.

| Concern | Owner |
|---|---|
| Form config (`lesson_types`, `payment_methods`, `success_message`, `price_table`, …) | **registration** |
| Training config (`scoring_weights`, `applicable_trainer_ids`, `min_skill_rating`, …) | **cycle** |
| **Price / `split_payment` / VAT flag / time / location** | **slot** (the price source of truth) |
| Form↔training link | `registrations.source_cycle_id` (1:1) |

---

## 4. Status vocabularies

- **`bookings.status`**: `pending`, `confirmed`, `cancelled`, `completed`. **`payment_status`** (canonical CHECK):
  `pending`, `paid`, `refunded`, `waived` (the Mollie webhook additionally maps a failed/expired/canceled payment
  onto a non-paid status — treat anything `!= 'paid'` as unpaid).
- **Capacity-occupying set** = `('confirmed','pending','pending_approval')` — the single source of truth is
  `CAPACITY_OCCUPYING_STATUSES` in `src/lib/lessons.ts`. A `cancelled` booking **never** occupies a seat and
  must be excluded from every capacity / roster read.
- **Active-booking unique indexes** `uniq_active_booking_per_slot_{player,guest}` are partial:
  `WHERE status IN ('pending','confirmed','completed')`. So a **soft-cancelled** booking is exempt — re-booking
  the same player on the same slot after a cancel does **not** collide. (This is why soft-cancel is safe.)
- **`intake_requests.status`**: `new`, `proposed`, `confirmed`, `booked`, `rejected`, `waitlist`. (`booked` is
  written by finalize; note the canonical migration's CHECK is drifted vs prod — see §7.)

---

## 5. Write boundaries — the canonical mutation entry points

**Rule: a domain write goes through the function below, never a raw table mutation in a page/component.**
Each centralizes a money/data invariant that diverged when it was duplicated per screen.

### Bookings

| Write | Use | Never |
|---|---|---|
| Remove player(s) / cancel booking(s) | **`cancelBookingsAndSync(ids)`** (`src/lib/bookings.ts`) — soft-cancels (`status='cancelled'`) then reconciles every billing invoice. Returns `{cancelError, syncError}`. | `…from('bookings').delete()` (hard delete loses history + can orphan invoice `booking_ids`); a bare `update({status:'cancelled'})` with no invoice sync (→ **stale billing**). |
| Mark a Mollie payment onto bookings | **`applyBookingPaymentWriteback`** (`supabase/functions/_shared/mollie-webhook-payment.ts`) — the guard `payment_status != 'paid'` is **unconditional** (atomic idempotency claim AND no-downgrade safety). | Writing booking payment fields from a webhook without the `!= 'paid'` guard (→ a stale `open`/`pending` delivery **downgrades a paid booking**). |

### Slots

| Write | Use | Never |
|---|---|---|
| Delete slot(s) | **`applySlotDeleteToCycle(cycleId\|null, slotIds)`** (`src/lib/slotDeleteGuard.ts` → RPC `apply_slot_delete_to_cycle`) — locks bookings `FOR UPDATE`, **keeps** any slot holding an occupying booking, deletes the rest atomically. A non-zero `protectedCount` is the kept set to surface. | A client check-then-delete or a raw `…from('availability_slots').delete()` (→ **TOCTOU**: a concurrent booking lands and is cascade-destroyed). To delete a slot that *does* hold bookings, `cancelBookingsAndSync` them **first**. |
| Edit a whole cycle's slots | **`applySlotEditToCycle`** (`src/lib/cycles.ts` → RPC `apply_slot_edit_to_cycle`) — atomic, row-locking. | Per-slot loops that can half-apply. |
| Change a cycle's price | **`updateCyclePricing`** (`src/lib/cycles.ts` → RPC `update_cycle_pricing`) — id-ordered slot lock. | Bulk price writes that skip invoice reconciliation. |

### Invoices (reconciliation follow-ups)

The slot RPCs only stamp `invoices.split_count`; they do **not** rebuild line-item amounts. After a write that
changes a cycle's bookings or price, the caller must reconcile:
- `syncInvoicesAfterBookingRemoval(ids)` — rebuild invoices after bookings leave (used inside `cancelBookingsAndSync`).
- `syncSplitCountForCycle(cycleId)` — recompute the 1/N divisor + rebuild unpaid sibling invoices.
- `syncInvoicesAfterPriceChange(...)` — rebuild after a price change.
- Invoices are minted by the **`auto-create-invoice`** edge function (pass `splitAmongPlayers = N` for split cycles, or you over-charge N×).

### Registrations

| Write | Use |
|---|---|
| Create / edit a registration form | **`createRegistration` / `updateRegistration`** (`src/lib/registrations.ts` → RPCs `create_/update_registration_with_cycle`) — mint/adopt the cyclus shell + the registration atomically (`ON CONFLICT (source_cycle_id)` makes edits backfill-order-independent). The editor falls back to legacy `createCycle` only on `PGRST202` (RPC not yet deployed). |

### Proposals

| Write | Use |
|---|---|
| Finalize proposals → bookings + invoices | **`finalize_cycle_proposals(cycle_id)`** RPC (called by the `finalize-proposals` edge fn) — claims intakes (`→booked`) + creates bookings + confirms assignments in **one transaction** (all-or-nothing → safe to re-run). Invoicing stays on the caller (HTTP, separately re-runnable). |

---

## 6. Critical invariants (do not break)

1. **Soft-cancel, never hard-delete a booking.** Hard delete loses history and, via `ON DELETE CASCADE`, is
   unsafe; it also can't be reconciled if the follow-up sync fails. Cancel sets `status='cancelled'` (the row
   survives — useful for academy troubleshooting) and is exempt from the active-booking unique index.
2. **A paid booking is never downgraded or un-confirmed by any webhook.** Enforced by the unconditional
   `payment_status != 'paid'` guard in the booking write-back.
3. **Invoices reconcile when their bookings change.** No FK on `booking_ids` → every cancel/remove/price-change
   path must call the matching `sync*` helper, or the player keeps being billed for sessions that no longer exist.
4. **Split divisor = the group sharing the slot, not the whole-cycle headcount.** Each player pays
   `price × sessions / groupSize`; pass `splitAmongPlayers` so `auto-create-invoice` divides correctly.
5. **Deleting a slot can destroy bookings (cascade).** Always go through `applySlotDeleteToCycle` (protects
   occupying bookings) and cancel+sync any bookings you intend to remove **before** the delete.
6. **Only academy + trainer create/edit** slots/cycles/registrations. **Clubs are read-only** (RLS stays
   symmetric, but there are no club create/edit surfaces).
7. **Additive, non-destructive migrations only** for this domain; never `DROP`/move the 1009 bookings / 322 slots
   / their invoices.

---

## 7. Known drift / cross-references

- **`intake_requests.status` CHECK drift:** the canonical migrations' CHECK lacks `'booked'`, yet the
  `finalize-proposals` flow writes `'booked'` and works in prod — the live CHECK is wider than the migration set.
  `supabase db reset` (local) therefore can't run finalize faithfully. Tracked, out of scope for any single slice.
- **types-drift CI gate is permanently red** (CLI-version line mismatch) — merge migrations / inert-FE with
  `--admin`; `supabase db reset` is the real schema gate.
- The migration mechanics + cutover live in [`PHASE2_REGISTRATIONS_SPLIT.md`](./PHASE2_REGISTRATIONS_SPLIT.md),
  [`PHASE2_STEP3_CUTOVER.sql`](./PHASE2_STEP3_CUTOVER.sql) (owner-run data backfill, optional), and
  [`PHASE4_CE_INTEGRITY_INDEX_RUNBOOK.md`](./PHASE4_CE_INTEGRITY_INDEX_RUNBOOK.md).
