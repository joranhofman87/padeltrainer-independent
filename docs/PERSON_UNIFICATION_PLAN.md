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
2. **Auto-merge only on UNAMBIGUOUS evidence** (wording tightened after Phase 0c — see the trust
   rule + hard rule in §5). Two auto-merge keys, in order of strength: (a) an explicit
   `twin_of_profile_id` stamp that passes the Phase-2 trust rule; (b) an exact (case-insensitive,
   non-empty) email match **only when that email maps to exactly ONE profile and ONE guest** —
   never inside a shared-email cluster. Everything ambiguous (shared-email families, no-email
   guests, name-only matches) is **reported for manual review**, not auto-merged.
   **`linked_profile_id` is NEVER identity truth** (bare-email trigger link, no name guard): at
   most it seeds *suggestions* in the review report.
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
| dual-keyed person column-pairs (across 7 tables — bookings + slot_priority_claims carry two) | 9 |
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

The 7 dual-keyed tables / 9 column-pairs (each pair gets a person column; `paid_by`/`booked_by`/`subject`
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
  **Audit + fixes (2026-07-16, adversarial multi-agent review before merge — FINAL state):** the
  review confirmed 11 defects; all fixed in the 0b PR (#561). As shipped: (#1 wrong-person)
  `pickGuestIdByName` reused a LONE household-email match without a name check → a parent could
  resolve to their child's guest row and be seated/invoiced as the child + overwrite the child's
  PII → fixed with a `requireNameMatch` gate on the twin path. (#3/#4/#6/#7 duplicate seat / double
  charge) cross-identity dedup in `addPlayersToCycle`/`swapPlayerInCycle` uses **ONLY the explicit
  twin hint** — the profile the manager EXPLICITLY selected on a `p_` pick (`twinProfileIdByGuestId`
  / `toProfileId`). (#2/#8/#9 duplicate twin) the academy dedup RPC matched email case-SENSITIVELY
  vs the lowercased twin email → duplicate twin + double invoice + defeated the link trigger → fixed
  with a case-folded RPC (migration `20260826190000`) + escaped-`ilike` in the code branches. (#5)
  dedup keys on the seat-occupancy union so `pending_approval` seats count.

  **⚠ HARD RULE (learned via a second verify-the-fixes pass): never key identity/dedup decisions on
  `guest_players.linked_profile_id`.** An earlier draft of the #3/#4/#6/#7 fix resolved each
  incoming guest's `linked_profile_id` server-side for call-path independence — but that column is
  set by `link_guest_data_to_profile` on **bare email match with no name guard**, so shared-email
  families are mislinked (a child's guest → the parent's profile). Trusting it would over-block adds
  and, on swap, **cancel the parent's PAID seats**. It was reverted to hint-only before merge.
  Historical note only — the dangerous variant never shipped.

### Phase 0c — Hardening after the external (Codex) audit (SHIPPED with 0b follow-up PR)
  An independent post-merge audit confirmed the 0b fixes and found 3 further defects (+1 doc issue),
  all fixed by the **explicit twin bridge — `guest_players.twin_of_profile_id`** (manager-initiated
  person assertion; deliberately a NEW column, since `linked_profile_id` is banned for identity by
  the hard rule above):

  - **H1 (security, pre-existing since P2-2):** `find_guest_players_by_email_for_academy` trusted
    the caller-supplied `_trainer_ids` → any academy manager could use the SECURITY DEFINER fn as a
    cross-tenant email oracle. Fixed (migration `20260826200000`): the trainer set is derived
    INSIDE the fn from `academy_trainers` (status='active'); the parameter is kept but ignored.
  - **H2 (race):** twin resolution was select-then-insert with NO DB backstop → two managers adding
    the same registered player concurrently could mint two twins (duplicate seats + double
    invoice). Fixed (migration `20260826210000`): partial UNIQUE index
    `uniq_guest_twin_per_academy (academy_profile_id, twin_of_profile_id)`; the resolve flow is now
    (1) lookup by profile id → (2) compare-and-set CLAIM of the email+name-matched candidate via
    `claim_guest_twin_for_academy` → (3) mint stamped with the profile id, where every race
    converges (23505 → re-read the winner via `find_guest_twin_for_academy`). Bonus: an emailless
    registered player now mints ONE twin total (found by profile id on later adds), retiring the
    old "un-dedupable twin per add" accepted default. The generic 23505 recovery also now honors
    `requireNameMatch` (was a blind email re-select — a wrong-person landmine).
  - **H3 (ambiguity):** with several same-email SAME-NAME rows the client picked the first —
    a guess. Now ambiguity yields no candidate → fresh stamped twin (never the wrong human; the
    duplicate is Phase-2-mergeable). Repeat adds bypass name heuristics entirely via the stamp.
  - **M4 (visibility):** a shared-email family member's twin never gets `linked_profile_id` (the
    trigger requires a SINGLE unlinked match), so the registered player couldn't see those bookings
    in their own app. Fixed across ALL FOUR player-side readers: `get_my_linked_guest_bookings` +
    `get_my_paid_booking_ids` (migration `20260826210000`) and `get_my_pending_priority_claims` +
    `can_book_member_window` clauses (d)/(e) (migration `20260826230000` — the rebook dashboard
    card and the member-window auth gate; without these the family twin saw their sessions but got
    no rebook invite and was denied member-window self-booking).
  - `merge_guest_players` (migration `20260826220000`) now refuses to merge rows referencing two
    DIFFERENT persons and carries the twin stamp to the surviving row. Per ROW the explicit twin
    OUTRANKS the email-inferred `linked_profile_id` (a stale family mislink must not dead-end an
    explicitly twinned row); across rows two different effective references still refuse.
  - **Repurpose guard:** the guest-edit surfaces write name fields only, so renaming a stamped twin
    row to a DIFFERENT human would have silently redirected every future add of the original person
    onto that row (and the Phase-2 email rule can't catch it — a rename keeps the email). The
    `trg_clear_guest_twin_on_rename` trigger (migration `20260826210000`) detaches the stamp on any
    name change that doesn't explicitly rewrite it; a same-person typo fix self-heals (the next add
    re-claims the same row via email+exact-name).

  0c itself went through the same two-pass discipline: a 5-agent adversarial verification of the
  hardening confirmed the core design (RPC security + client orchestration clean, all race
  interleavings converge) and surfaced the rename-repurpose vector, the two missed rebook readers,
  and the merge dead-end above — all fixed before merge. The pglite suite executes the REAL
  migration files (only GRANT/REVOKE stripped), so weakening the shipped DDL fails tests.

  **Round 3 (third external audit → migration `20260826250000`):** one confirmed finding — the
  repurpose trigger read `profiles.email` WITHOUT `SECURITY DEFINER`, so on the common client edit
  path (manager under RLS, twin profile row invisible — the same asymmetry behind PR #557) the
  email-away check silently no-oped; it only worked via merge's DEFINER context, and the superuser
  pglite harness couldn't see it. Fixed (DEFINER + same body; leaks nothing — no data returned, and
  managers already see registered emails via `get_players_overview`). The pglite suite now has an
  RLS-role environment (`SET ROLE authenticated` + own-row-only profiles policy) proving the clear
  fires for an editor who cannot read the profile row — verified to FAIL without the fix. Lesson:
  **any trigger/function that reads OTHER tables must be SECURITY DEFINER or it silently degrades
  under the caller's RLS** — and superuser test harnesses can't catch that class; test under a
  restricted role.

  **Round 2 (second external audit of 0c → migration `20260826240000`):** three confirmed findings,
  all fixed. (1) The raw `can_book_member_window(_user_id, _cycle_id)` was granted to
  anon/authenticated — an eligibility oracle. The lock (`20260717100000`, service_role only +
  `can_current_user_book_member_window` wrapper for clients) had ALREADY been undone by
  `20260731100000` re-granting on re-create, and `20260826230000` copied it forward — re-locked,
  plus a textual test that pins the revoke AND fails if any later migration re-grants (the exact
  mistake class that shipped in 0731). (2) A conflicted row (linked = parent via the no-name-guard
  email trigger, twin = child via an explicit claim) leaked the child's bookings/invoices/rebook
  eligibility to the parent via the linked path. **Read-time precedence rule (now doctrine): a
  row's explicit `twin_of_profile_id` OUTRANKS its `linked_profile_id` in every player-side reader**
  (`twin = me OR (twin IS NULL AND linked = me)`) — closes the leak for every conflicted row
  however it arises (claim on a mislinked row, trigger re-inference, merge). The merge additionally
  no longer CARRIES a conflicting stale link onto the survivor. (3) The repurpose guard also
  detaches the stamp when a row's email moves AWAY from the twin profile's email (corrections
  toward it, case/whitespace changes, emptying, and emailless profiles keep it) — closing the
  same-name email-only repurpose the rename rule missed.

  **Phase 2 trust rule (forward-looking):** managers can row-level UPDATE their own guests (same
  pre-existing surface as `linked_profile_id`), so the backfill may auto-consume
  `twin_of_profile_id` as person ground truth ONLY where the guest's email matches the profile's
  (case-insensitive) or the guest is emailless with `source='roster_registered_twin'`; anything
  else goes to the `person_merge_review` report. Residual accepted gap (unchanged): a `g_` pick of
  a person who ALSO holds a `player_id` booking is not cross-identity-deduped (duplicate seat at
  worst, never wrong-person/data loss) — Phases 1–4 close it. **Phases 1–4** remain per §5 below.

### Phase 1 — EXPAND (additive, zero behavior change)
- Migration: create `persons`; add nullable person columns to the 7 dual-keyed tables (9 pairs,
  incl. the paid_by/booked_by/subject variants); nothing reads them yet.
- Triggers: dual-write — any insert/update that sets a `player_id`/`guest_player_id` also sets the
  matching `person_id` once persons exists (Phase 2 backfills the existing rows).
- CI: pglite test proving the new columns + triggers exist and don't change any read.
- **Reversible:** drop the columns; nothing read them.

  **Progress — SHIPPED (migration `20260826260000`):** `persons` (plan §4.1 schema, RLS enabled
  with NO policies → client-invisible until Phase 3) + **`person_links`** — the old→new identity
  map (one row per absorbed profile/guest, UNIQUE per source, exactly-one-source CHECK; Phase 2
  populates it; sources CASCADE so a deleted guest stops mapping). Nullable person columns on the
  7 dual-keyed tables (9 pairs: `bookings.person_id`+`paid_by_person_id`, `invoices.person_id`,
  `intake_requests.person_id`, `slot_priority_claims.person_id`+`booked_by_person_id`,
  `session_player_notes.subject_person_id`, `academy_player_locations.person_id`,
  `academy_player_metadata.person_id`) with partial indexes. Dual-write BEFORE triggers (one per
  table, **SECURITY DEFINER** per the 0c round-3 doctrine — person_links is RLS-locked, a
  non-DEFINER trigger would silently stamp NULL for RLS-restricted writers). **Stamping rule
  (hardened after the Phase-1 adversarial verification): the person columns are PURE DERIVED DATA
  on any row that carries — or carried — an old-world key.** Recomputed from person_links whenever
  the trigger fires; a writer-supplied value on a keyed row is re-derived (unforgeable — the 7
  tables are client-UPDATEable and the financial-column guards don't cover the new columns, so
  writer-wins would have been a forgery hole once persons is populated); keys removed
  (anonymization) → derives NULL; only keyless rows (Phase-3 new-world writers) are
  writer-managed. **Lookup is GUEST-side first** (verification finding): the guest key is the
  row's original subject — player_id on both-keyed rows is only ever added later by the email
  linkers via `linked_profile_id`, the banned inference, so profile-first would let it overwrite
  the correct subject on divergent rows. The trigger OF-lists include the person columns
  DELIBERATELY (a forged person-only PATCH fires the trigger and gets re-derived); hot-path
  status/payment updates still never fire them. With `person_links` empty (until Phase 2) every
  stamp is NULL — literally zero behavior change. `persons` + `person_links` added to the backup
  allow-list (a restore must never recover stamped rows without the map). pglite suite
  `personsExpand.pglite.test.ts` runs the REAL migration, table-driven over ALL 9 pairs:
  constraints, derivation, forge-neutralization, divergent-both-keyed guest-wins, merge-repoint,
  anonymization-to-NULL, keyless writer-managed, RLS-restricted-writer stamping per table, and
  client-invisibility. **Phase 3 decision to record (P-D): new-world writers should go through
  RPCs, not direct column writes — when the first Phase-3 writer lands, either guard the person
  columns (extend the protect-financial-columns triggers) or route all person-column writes
  through SECURITY DEFINER RPCs.**

### Phase 2 — BACKFILL + MERGE (data, one-time, verified)
- Build `persons`: one row per profile; one row per guest that is NOT auto-merged into a profile's
  person by the rules below.
- **Merge rule (LOCKED, updated post-0c):** a guest collapses into a profile's person ONLY on
  (a) an explicit `twin_of_profile_id` stamp passing the **Phase-2 trust rule** (guest email
  matches the profile's case-insensitively, OR guest is emailless with
  `source='roster_registered_twin'`), or (b) an exact (case-insensitive, non-empty) email match
  where that email maps to **exactly ONE profile and ONE guest** system-wide (never inside a
  shared-email cluster). Profile wins for account fields; guest contributes non-null identity gaps.
  **`linked_profile_id` is NEVER consumed as identity truth** (hard rule, §5 Phase 0): it may only
  SEED suggestions in the review report, and a link that conflicts with an explicit twin is
  reported as a stale mislink, not carried.
- **Report, do not auto-merge:** shared-email guest families (28), no-email guests (76), trust-rule
  failures, linked-vs-twin conflicts, and any fuzzy name-only matches → written to a
  `person_merge_review` table for owner sign-off.
- Stamp the person columns on every existing row of the 7 dual-keyed tables (9 pairs) from the
  old FKs — same derivation the Phase 1 triggers use (guest-side first).
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
