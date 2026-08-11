# ABC-16 / ABC-17 — what proves an academy↔player relationship

Status: **local implementation only.** Nothing here is merged, deployed, or applied to production.
H1 is design only; its schema waits on U2's canonical membership writer and a later material-schema
owner gate.

This document exists because the same defect was found three times in three different places. Each
individual patch was locally correct and the next round found another instance, which is the signal
that the *model* was incomplete rather than the code. So the model is written down first, and the
containment is derived from it.

---

## 1. The defect, stated once

Every one of the three findings is the same sentence:

> A signal the caller can author was treated as proof of a relationship that authorizes the caller.

| Round | Signal treated as proof | Consumer |
|---|---|---|
| 1 | `academy_player_metadata` row | `guest_belongs_to_user_academy` arm (c), `get_player_email_edit_capability`, `filter_academy_priority_ids` |
| 2 | `academy_player_locations` row | `filter_academy_priority_ids` |
| 3 | `bookings.guest_player_id` / `bookings.player_id` | `guest_belongs_to_user_academy` arm (b), `guest_booked_with_trainer`, `filter_academy_priority_ids`, `get_players_overview` |

Round 3 is the one that shows the model was wrong rather than the code. The first containment kept
booking evidence *because a booking looked like a real transaction on the academy's own inventory*.
It is not: the slot is the academy's, but the **subject** columns are not, and nothing constrained
them.

---

## 2. The signal taxonomy

Every signal in this system falls into exactly one of three classes. The class — not the table it
lives in — decides whether a predicate may rely on it.

### Class A — caller-authored

The caller chooses the subject. The row proves the caller wrote it and nothing else.

- `academy_player_metadata` (any column, either owner arm)
- `academy_player_locations` (any column)
- `bookings.guest_player_id`, `bookings.player_id` — **before** the immutability guard

**Rule: never admissible as relationship proof.** No filter makes them trustworthy, because the
whole row is the caller's.

### Class B — server-owned

Written only by a path that validates the subject against something the caller does not control.

- `guest_players.academy_profile_id` / `.trainer_id` — the write policies require the row to
  *already* be the caller's, so a caller cannot claim someone else's guest
- `academy_managers` — the academy identity itself
- `academy_player_memberships` (U1a) — canonical, but see §5

**Rule: admissible.**

### Class C — server-owned only once constrained

A signal whose *creation* is meaningful but whose *subject* was mutable after the fact. Booking rows
are the whole class: creating a booking on the academy's slot is real, and repointing its subject
afterwards is free.

**Rule: inadmissible while the subject is mutable; admissible once it is not.** This is the class
ABC-17 acts on.

---

## 3. Why booking subjects were forgeable

Verified against the effective chain, not assumed:

- `Academy managers can update bookings for academy slots` (20260704120000) — `USING` requires the
  booking to be on a slot in the caller's academy; `WITH CHECK` requires it to *stay* on one.
  Neither mentions `player_id` or `guest_player_id`.
- `Trainers can update bookings for their slots` (20260115210247) — `USING` on slot ownership, no
  `WITH CHECK` at all, so the same expression is reused. Same gap.
- `public.bookings` carries **no triggers whatsoever**. The `OLD.player_id` guards that exist in the
  chain are on `invoices` (20260530120000), not bookings.

So the slot owner could take any booking on their own slot and repoint it at an arbitrary victim
UUID, then read that person through every booking-derived predicate.

---

## 4. The invariants, as executable properties

1. **No Class-A signal appears in any authorization, visibility, membership, capability, priority
   or mutation predicate.** Presentation reads may show overlay data to a caller already authorized
   by something else.
2. **No Class-C signal appears in an authorization predicate while its subject is mutable by a
   client role.**
3. **A client role holds `SELECT` and nothing else on either overlay table**, across the privilege
   universe the running server defines — not a hard-coded list.
4. **`service_role` holds no direct privilege it does not need.** Where a `SECURITY DEFINER` function
   already provides the access, the table grant is removed (the ABC-14 precedent).
5. **Every existing row survives byte-identical.** No repair, quarantine, merge, deletion or
   re-stamp. Disposition is an owner decision informed by the inventory.
6. **Rollback is forward-only.** Disabling more is acceptable; restoring overlay-derived authority,
   direct overlay DML, or academy Auth-email rewriting is not.

---

## 5. What each predicate may rely on, after containment

| Predicate | Retained evidence | Removed |
|---|---|---|
| `guest_belongs_to_user_academy` | (a) the academy owns the guest row | (b) booking on the academy's slot, (c) metadata link |
| `guest_booked_with_trainer` | — policy dropped entirely | it was booking-derived end to end |
| `filter_academy_priority_ids` | guests the academy owns | booking arm, metadata arm, location arm |
| `get_player_email_edit_capability` | authorization gate only; always returns `override` | the entire `direct` outcome |
| `get_players_overview` | unchanged | nothing — see below |

Two consequences are deliberate and are **not** bugs:

- **Registered players can no longer be admitted to academy rebooking priority at all.** Every route
  that could admit them was Class A or Class C. Fail-closed is the honest answer; the replacement is
  U2's canonical membership, not another heuristic.
- **Trainers lose visibility of guests who merely booked their slot.** They keep guests they own.

`get_players_overview` is deliberately *not* narrowed. Removing booking admission would empty every
academy's player list — an outage, not a containment, and H0's own mandate is to keep player pages
readable. Instead ABC-17 removes the forgeability at the source (§6), which restores the honesty of
the booking signal the overview depends on.

**U1a/U1b/D5 must continue to refuse metadata-only and location-only rows as authoritative** until
the inventory is run and the owner has ruled on disposition. Canonical membership is Class B, but it
was backfilled from sources that include Class A rows, so it inherits their status until that
reconciliation happens.

---

## 6. ABC-17 — server-validating the booking subject

A booking's subject becomes immutable to client roles. The row can still be cancelled, paid, moved
between the academy's own slots, and re-keyed by the internal merge/link paths — only the identity of
*who the booking is for* is frozen.

- Enforced by a `BEFORE UPDATE` trigger on `public.bookings`, refusing a change to `player_id` or
  `guest_player_id` when `current_user` is `authenticated` or `anon`.
- `SECURITY DEFINER` functions run as their owner, so `merge_guest_players` and
  `link_guest_data_to_profile` are unaffected — they were the only writers of those columns, verified
  across `src/`, `supabase/functions/` and the migration chain.
- The guard is role-based rather than a blanket `RAISE`, because a blanket refusal would break the
  merge path that legitimately repoints bookings.

This does **not** promote booking evidence back into the authorization predicates. Those removals
stand. The guard exists so the remaining booking-derived *visibility* is not forgeable, and so a
later design can re-admit the signal on evidence rather than on hope.

---

## 7. H1 — design only, do not implement

To be built after U2 delivers the canonical membership writer, behind a separate material-schema gate.

- **Evolve the existing overlay tables; do not replace or rewrite them.** The rows are evidence.
- Add a canonical `academy_membership_id` binding only once U2's writer and membership semantics are
  complete, with `ON DELETE RESTRICT` — never cascade, which would destroy the evidence.
- Enforce owner/person alignment through canonical membership, server-side.
- Retain the legacy subject columns as compatibility evidence during migration, deriving them
  server-side rather than trusting a writer.
- Keep trainer-owned overlays separate until the standalone-trainer relation is settled (ABC-10).
- Expose narrow server-validated **commands**; never direct client table writes.
- Idempotency through a separate default-deny command-receipt table keyed by an immutable UUID request
  id plus a full command fingerprint. Mutable PII is never identity and never an idempotency key.
- A separate default-deny quarantine ledger keyed by source table and row id. Quarantine is additive
  and logical; it never mutates or deletes the source row.
- **No unique-row rule** until duplicate/conflict disposition is owner-approved — the inventory's
  `duplicate_or_conflicting` class is what that decision will be based on.
- Player invitation reissue/revocation is a later product unit. It is the correct replacement for
  academy email rewriting; rewriting an accepted login is never reinstated.

Not in this branch: H1 columns, receipts, quarantine tables, backfills, invitation tables.

---

## 8. Residual risks after this containment

Stated explicitly so they are not mistaken for solved:

1. **`get_players_overview` still admits registered players by booking.** ABC-17 makes the subject
   immutable, which closes the forgery, but the admission rule is still "booked with us" rather than
   canonical membership. U2/H1 replaces it.
2. **The wrong-target FK on `academy_player_locations.academy_profile_id` is untouched.** It
   references `profiles(id)` while every authorization path resolves academies through
   `academy_profiles(id)`. Repairing it would rewrite or orphan rows; the inventory reports it as
   `wrong_target_academy_fk` and the owner decides.
3. **Production state is uninspected.** Every claim here is about the repository model. Whether these
   paths were exploited, and what the live data looks like, is unknown and is a separate owner gate.
4. **The overlay UI is read-only, not restored.** Notes, tags, soft removal, billing override and club
   curation display but cannot be edited until H1 supplies a validated writer.
5. **A trainer standing on court sees a booked guest as "Unknown" again.** Dropping the booked-guest
   policy re-opens exactly the problem 20260713110000 was written to solve. It is a genuine UX
   regression, accepted because the policy authorized reading *any* guest in the database. The fix is
   canonical membership, not a wider policy — and it should be prioritised, because the people it
   affects are staff doing their job, not attackers.
6. **Registered rebooking priority silently admits nobody.** `bulk-rebook-cycle` filters its priority
   list through `filter_academy_priority_ids`, which now returns no profiles at all, so registered
   priority people are dropped without an error. The edge function's reporting was not changed here;
   whether it should refuse loudly instead is a product decision.
