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

### Class C — activity, never authority

A signal whose *creation* is meaningful but whose *subject* the creator chooses. Booking rows are the
whole class: the slot is the academy's, the subject is not, and nothing constrains it — at INSERT or
afterwards.

**Rule: never admissible as relationship proof.** A booking may colour state for a subject that is
already in scope by Class-B evidence; it may never put one there. An earlier draft called this
"admissible once the subject is immutable" and shipped a partial UPDATE-only guard on that basis;
both the claim and the guard were withdrawn (§6).

---

## 3. Why booking subjects were forgeable

Verified against the effective chain, not assumed:

- `Academy managers can update bookings for academy slots` (20260704120000) — `USING` requires the
  booking to be on a slot in the caller's academy; `WITH CHECK` requires it to *stay* on one.
  Neither mentions `player_id` or `guest_player_id`.
- `Trainers can update bookings for their slots` (20260115210247) — `USING` on slot ownership, no
  `WITH CHECK` at all, so the same expression is reused. Same gap.
- `public.bookings` does carry triggers — updated_at, slot-tier enforcement on insert and update,
  auto-follow, person-stamp — but **none constrains the subject**. (An earlier draft of this document
  claimed the table had no triggers at all; that was a line-anchored grep missing multi-line
  `CREATE TRIGGER` statements.)
- The trainer INSERT policy (20260116200114) admits a dual-key row: an owned `guest_player_id`
  alongside an arbitrary `player_id`. So the subject is chosen at INSERT, not only repointed later.

So the slot owner could seat an arbitrary victim UUID and read that person through every
booking-derived predicate.

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
| `get_players_overview` | directly owned guests only | booking-admitted registered profiles, the active-trainer union, person expansion and cross-person dedup |
| `get_person_refs_for_scope` | an owned guest, resolving to itself | sibling expansion, profile expansion, `has_login` |
| `get_player_locations` | an owned guest's clubs | subject-unauthorized calls, `person_links` expansion |

Two consequences are deliberate and are **not** bugs:

- **Registered players can no longer be admitted to academy rebooking priority at all.** Every route
  that could admit them was Class A or Class C. Fail-closed is the honest answer; the replacement is
  U2's canonical membership, not another heuristic.
- **Trainers lose visibility of guests who merely booked their slot.** They keep guests they own.

`get_players_overview` IS narrowed, to directly owned guests. An earlier draft argued against this on
the grounds that it would empty every roster; that was overstated — directly owned guests remain, and
what is lost is booking-admitted *registered* players. That loss is real, measurable and intentional
until canonical membership exists.

**U1a/U1b/D5 must continue to refuse metadata-only and location-only rows as authoritative** until
the inventory is run and the owner has ruled on disposition. Canonical membership is Class B, but it
was backfilled from sources that include Class A rows, so it inherits their status until that
reconciliation happens.

---

## 5b. Three claims I got wrong, corrected

Recorded because each one shaped a decision:

1. **"`public.bookings` has no triggers."** False — it has at least five (updated_at, slot-tier
   enforcement on insert and update, auto-follow, person-stamp). My grep was line-anchored and
   multi-line `CREATE TRIGGER` statements slipped past it. What is true, and is the point, is that
   none of them constrains the *subject*.
2. **"Removing booking admission empties every roster."** Overstated. Directly owned guests remain
   in scope — academy via `guest_players.academy_profile_id`, trainer via `guest_players.trainer_id`.
   What is lost is booking-admitted *registered* players, which is a real and measurable
   degradation but not an empty screen.
3. **"No membership writer exists."** Inaccurate. A fresh chain leaves
   `academy_player_memberships` empty and there is no deployed, authorized ongoing writer, but an
   offline rehearsal/applier exists at `scripts/db/u1b-backfill-apply.mjs`. Production population
   is unknown and was not inspected.

## 5c. Class D — the legacy guest↔account bridge

`guest_players.linked_profile_id` and `.twin_of_profile_id` name a registered profile, but the
guest write policies validate only who owns the *guest* row, so a caller can point an owned guest
at anyone. Everything derived from them inherits that status: guest→person→profile equality, and
the booking/invoice/person stamps computed from it.

Historical provenance **cannot be reconstructed**: `person_links` has no provenance column
(20260826260000:67), and `collapse_guest_person_into` repoints `person_id` in place, so a row keeps
no trace of the decision that set it. `person_merge_review` records events, not row state, and its
FKs are `ON DELETE SET NULL`.

So the containment freezes **authoring** and distrusts the **readers**; it re-trusts nothing and
changes no row. Profile→person self-mapping and guest→person structural mapping remain as internal
projections. Guest/profile *equality* never grants identity, access, money, delivery or routing.

Re-trusting any of it needs an immutable attestation / proposal-confirmation model and an
idempotent membership writer. **That belongs to A/U2 under its own material-schema owner gate** and
is deliberately not attempted here.

## 6. ABC-17 — the booking subject is distrusted, not guarded

An earlier draft installed a `BEFORE UPDATE` trigger freezing `player_id` / `guest_player_id` for
client roles, and leaned on it to argue the booking-derived admission left in
`get_players_overview` was dependable. **That trigger has been withdrawn**, for two reasons:

- it covered UPDATE only, while the trainer INSERT policy (20260116200114) admits a dual-key row —
  an owned `guest_player_id` alongside an arbitrary `player_id` — so a chosen subject never needed
  an UPDATE at all;
- every booking that already exists predates it, and privileged writers bypass it by design, so it
  could not vouch for historical rows either.

A complete client write invariant would have to cover every legitimate booking flow (public slot
and cyclus payment, cart, guest intake, trainer and academy creation, rebooking, merge re-keying).
That is not proven here, and a partial guard that is *described* as making bookings trustworthy is
worse than no guard. So the boundary moved entirely to the readers: **a booking is activity, never
evidence about a person**, and historical and privileged-writer bookings stay untrusted.

A client subject guard may return later as defense in depth — after every booking flow is mapped,
and covering INSERT as well as UPDATE — but it must never be used to reclassify bookings as trusted.

**The contract, stated once so no reader has to infer it.** Booking subjects are not immutable and
are not authority. What IS admissible: a directly owned guest (`academy_profile_id` = the academy,
or `trainer_id` = the trainer — never an active-trainer union), a caller-bound self profile
(`profiles.user_id = auth.uid()`), and explicit admin / public-trainer / managed-trainer relations.
Bookings are activity: they may colour state for a subject already in scope, never admit one.
Person equality, `person_links`, `linked_profile_id` and `twin_of_profile_id` grant nothing —
not identity, not access, not routing, not mutation — and survive only as inert observations.

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
