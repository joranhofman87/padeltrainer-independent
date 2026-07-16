# Person Unification Plan — one `persons` table, "has a login" as an attribute

Status: **DESIGN APPROVED, not yet started** (2026-07-16). This is the tracker for the largest
migration in the codebase. Execute it as a **strangler / expand→migrate→contract** program of small,
independently-shippable PRs — never a big-bang. You can stop between any two phases with a fully
working app.

Audience / AI-read: yes. Companion: [`INVARIANTS.md`](INVARIANTS.md), the person-identity rule in
`src/lib/personIdentity.ts`, and the registration-decouple precedent
[`REGISTRATION_DECOUPLE_PLAN.md`](REGISTRATION_DECOUPLE_PLAN.md) (same expand/migrate/contract shape,
smaller scale).

---

## 1. Why (the problem this ends)

The app has **two person tables** that grew from two subsystems and were never unified:

- `profiles` — a person **with a login account** (1:1 with `auth.users`; `user_id` is `NOT NULL` +
  `ON DELETE CASCADE`). The marketplace identity.
- `guest_players` — a person a **trainer/academy manages**, who may have **no account** (kids,
  walk-ins, CSV imports, intake). The coaching/roster identity. Owner-scoped (`trainer_id`,
  `academy_profile_id`), may share an email (families), may have no email.

Every person-referencing row carries **one of two FK columns** (`player_id` → profiles, or
`guest_player_id` → guest_players; sometimes both, from the historical signup linker). Which one is
set depends only on *how the row was created* (logged-in vs guest/admin), not on who the person is.

**Consequences (the whole recurring bug family):** registered players vanish from academy rosters
(RLS lets managers read guest names but not arbitrary profiles — fixed symptomatically in PR #557);
registered accounts can't be added as participants via academy tooling (the "add" path is
guest-keyed); families sharing an email get mis-attributed; "three ways to identify a person"
divergences. Each past fix patched one crack; this plan removes the seam.

## 2. Decisions locked (2026-07-16, owner)

1. **One table.** A single `persons` table holds identity **and** account fields. "Has a login
   account" is simply **`persons.user_id IS NOT NULL`**. `profiles` is absorbed; `guest_players` and
   the dead `club_players` (0 rows) go away.
2. **Auto-merge on exact email.** A profile and a guest sharing an *identical* email collapse into
   one person automatically. Ambiguous cases (shared-email families, no-email guests) are **reported
   for manual review**, not auto-merged.
3. Ship via **strangler** (expand → backfill+merge → migrate readers cluster-by-cluster → contract).

## 3. Measured reality (prod, 2026-07-16 — re-measure before executing)

| What | Count |
|---|---|
| profiles (accounts) | 81 |
| guest_players | 445 |
| club_players | 0 (dead table) |
| guests already `linked_profile_id` | 47 |
| guests with no email | 76 |
| **profiles that also exist as a guest (same email)** | **47** |
| guest pairs sharing an email with another guest (families) | 28 |
| tables carrying BOTH a player_id and guest_player_id column | 9 |
| code refs to the guest identity | ~1,246 across ~197 src files + 42 edge fns |
| DB functions / RLS policies / migrations touching guest_players | 48 / 8 / 96 |

Data is tiny (~526 people) → the data migration is fast; **all risk is in the 1,246 code sites, the
RLS, and the money tables** (bookings, invoices). That is why now — while small — is the moment.

## 4. Target model

### 4.1 `persons` — the canonical human

Absorbs `profiles` + the *identity* columns of `guest_players`:

```
persons (
  id              uuid PK default gen_random_uuid(),
  user_id         uuid UNIQUE NULL REFERENCES auth.users(id) ON DELETE SET NULL,  -- "has a login"
  full_name       text,
  first_name      text,
  last_name       text,
  email           text,                 -- NOT globally unique (families; account uniqueness lives in auth.users)
  phone           text,
  birth_date      date,
  skill_rating    numeric,
  rating_system   text,
  rating_member_id text,
  avatar_url      text,
  bio             text,
  location        text,
  preferred_language text,
  billing_business_name text, billing_address text, billing_btw_number text,
  stripe_customer_id text,
  created_at timestamptz default now(), updated_at timestamptz default now()
)
```

Note `ON DELETE SET NULL` on `user_id` (not CASCADE): deleting the auth account keeps the person as
an account-less record — consistent with the Theme A "retain, don't destroy" retention model.

### 4.2 Membership is a RELATIONSHIP, not part of the person

`guest_players` conflates the person with the person↔owner relationship. In the unified model the
per-owner data (`trainer_id`, `academy_profile_id`, `notes`, `has_trained`, `source`,
`preferred_location_id`, tags, per-academy rating) is a **membership** row, not a person column. A
partial membership layer already exists (`academy_player_metadata`, `academy_player_locations`) —
extend it rather than inventing a new table. **Open question P-A (decide at Phase 3):** confirm the
membership shape and whether a person is GLOBAL (one row per human, linked to N academies via
memberships — recommended) vs per-owner-scoped (today's guest behavior). Recommended: global person
+ `person_academy_memberships(person_id, academy_profile_id, …)` / trainer memberships.

### 4.3 The collapse: every `(player_id | guest_player_id)` → `person_id`

The 9 dual-keyed tables (each gets a single `person_id`, plus `paid_by`/`booked_by`/`subject`
variants where present):

`bookings` (player_id, guest_player_id, paid_by_player_id, paid_by_guest_player_id) ·
`invoices` (player_id, guest_player_id) · `intake_requests` (player_id, guest_player_id) ·
`slot_priority_claims` (player_id, guest_player_id, booked_by_player_id, booked_by_guest_player_id) ·
`session_player_notes` (subject_profile_id, subject_guest_player_id) ·
`academy_player_locations` · `academy_player_metadata` · (+ the follower/rating/waitlist tables that
already key only on profiles → point at `person_id`).

The single-column `profiles`-only refs (reviews, *_followers, player_rating_history,
waiting_list_entries, coaching_note_views, player_locations) also repoint to `person_id`.

### 4.4 The identity rule already has a code home

`src/lib/personIdentity.ts` (`personKeyOf`, `personRefOf`, `matchBookingsToPerson`,
`personDisplayName`) is the single TS expression of "who is this person." After unification it
simplifies to "the row's `person_id`" — but during migration it is the shim that lets old and new
coexist. Keep it as the choke point.

## 5. Phased plan (each phase = its own PR(s), gated + reversible)

### Phase 0 — Freeze the seam from growing (safety net, tiny)
- Make the roster/add paths **provision a linked person consistently** so no *new* orphan-shaped
  data is created while we migrate. (Also unblocks the "add a registered account as participant"
  need directly.) Optional but recommended first — it stops the bleeding.

  **Progress — Phase 0a (lib layer) SHIPPED:** `resolveOrCreateGuestTwinForRegisteredPlayer`
  (`src/lib/playerResolve.ts`) mints/reuses a registered player's guest twin (exact-`lower(trim)`-email
  merge rule, `source:'roster_registered_twin'`, never sets `linked_profile_id` — the DB trigger
  does); `fetchBookablePersons` (`src/lib/playersOverview.ts`) returns guests **and** registered
  people with namespaced `comboboxId`s; and `addPlayersToCycle`/`swapPlayerInCycle`
  (`src/lib/cycleRoster.ts`) gained cross-identity dedup (`twinProfileIdByGuestId` / `toProfileId`)
  that closes a latent duplicate-seat hole no single-column unique index can catch. No UI change yet
  → no behaviour change.

  **Progress — Phase 0b (UI wiring) SHIPPED:** `CycleRosterInlinePicker` now searches
  `fetchBookablePersons` (guests **and** registered players, `g_`/`p_` keys) and emits the selected
  `BookablePerson`; `CycleDetailView` lifts the selection to a person, resolves a `p_` pick to its
  guest twin at add/swap (abort + toast on failure, threading `twinProfileIdByGuestId`/`toProfileId`
  into the 0a dedup) and relaxes the Change gate so registered rows are manageable too. **Closes the
  "add a registered app-account holder as a cycle participant" gap** (the PR #557 follow-up).
  Owner-accepted default: an emailless registered player mints an un-dedupable twin per add (rare —
  accounts almost always carry an email; reconciled later via `merge_guest_players`). **Phases 1–4**
  (the real `persons` table) remain per §5 below.

### Phase 1 — EXPAND (additive, zero behavior change)
- Migration: create `persons`; add nullable `person_id` to the 9 tables (+ the paid_by/booked_by/
  subject variants); add nullable `person_id`-shaped columns nowhere read yet.
- Triggers: dual-write — any insert/update that sets a `player_id`/`guest_player_id` also sets the
  matching `person_id` once persons exists (Phase 2 backfills the existing rows).
- CI: pglite test proving the new columns + triggers exist and don't change any read.
- **Reversible:** drop the columns; nothing read them.

### Phase 2 — BACKFILL + MERGE (data, one-time, verified)
- Build `persons`: one row per profile; one row per guest that is NOT an exact-email duplicate of a
  profile or another already-inserted guest.
- **Merge rule (locked):** profile.email == guest.email (case-insensitive, non-empty) → same person
  (profile wins for account fields; guest contributes non-null identity gaps). Carry
  `linked_profile_id` links too.
- **Report, do not auto-merge:** shared-email guest families (28), no-email guests (76), and any
  fuzzy name-only matches → written to a `person_merge_review` table for owner sign-off.
- Stamp `person_id` on every existing row of the 9 tables from its old FK.
- Verify: `count(distinct person)` reconciles; every non-cancelled booking/invoice has a `person_id`;
  no money row loses its person. Rehearsed in pglite against the real migration first.

### Phase 3 — MIGRATE READERS, cluster by cluster (the bulk of the work)
One domain per PR, each with tests + live-verify, in dependency order:
1. **Roster/display** (cycle detail, players-overview, pickers) → read `person_id`.
2. **Membership layer** (decide Open question P-A) → move per-owner metadata off guest_players.
3. **Booking path** (RPCs, capacity, holds) → `person_id`.
4. **Money path** (invoicing, pricing, split, mollie-webhook writeback) → `person_id`. Highest care;
   golden + mock-Mollie e2e must stay green.
5. **RLS + helpers** (`get_user_academy_ids`, `is_player_of_trainer`, the 8 guest policies, 48 fns) →
   `person_id`, and add the missing "academy manager can view persons in their academy" policy that
   PR #557 worked around.
6. Remaining single-key tables (followers, ratings, waitlist, notes).
- Old columns stay dual-written throughout, so each PR is independently shippable and revertible.

### Phase 4 — CONTRACT (remove the old world)
- Once nothing reads `player_id`/`guest_player_id`: drop the dual-write triggers, drop the columns,
  drop `guest_players` + `club_players`, retire `personIdentity.ts`'s dual-key branches.
- Final pglite + full-suite + mock-Mollie e2e green; live-verify the money paths.

## 6. Risks & mitigations
- **Money tables (bookings, invoices):** never migrate a reader without the golden/e2e money tests
  green; keep dual-write until the very end so a bad PR reverts cleanly.
- **RLS regressions = tenant leak or lockout:** every RLS PR ships with a pglite policy test that
  sets a real JWT and asserts both allow and deny. Mirror the S01/S557 verification style.
- **Auth path:** `persons.user_id UNIQUE` must match auth.users 1:1 for accounts; the signup +
  account-claim flows (`playerResolve.ts`, `link_guest_data_to_profile`) get migrated in Phase 3
  step 1–2 and live-tested.
- **Deploy discipline:** merge → pull → `db push` → deploy edge fns from `main`, every phase (the
  recurring lesson). No edge-fn deploy from an unmerged branch.

## 7. Open decisions (resolve at the phase noted)
- **P-A (Phase 3.2):** global person + membership table vs per-owner person scope. Recommended:
  global + memberships (reuse `academy_player_metadata`).
- **P-B (Phase 2):** disposition of the 76 no-email guests and 28 shared-email families after the
  review report — merge, keep, or manual case-by-case.
- **P-C (Phase 3.4):** does unification let us drop the guest-keyed assumption in pricing/invoicing,
  or do we keep person_id purely as the identity key and leave amount math untouched? (Recommended:
  identity-only; do not touch amount math in the same PRs.)

## 8. First actionable step
Phase 0 (consistent person provisioning on the roster/add paths) OR Phase 1 (Expand) — both are
safe, additive, and independently valuable. Recommend Phase 0 first: it also delivers the
"add a registered account as a cycle participant" capability the owner asked for, immediately.
