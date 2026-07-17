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
  populates it; sources CASCADE so a deleted guest stops mapping). **Post-merge external audit
  (finding P1) added the missing shape invariant (migration `20260826270000`): at most ONE profile
  per person** — `person_links_one_profile_per_person` partial unique index — since a person
  absorbing two profiles would conflate two login accounts while `persons.user_id` can only
  represent one; N guests per person remains allowed (that IS the merge). Phase 2's backfill can
  now not violate the model even with a bug. Nullable person columns on the
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

  **Progress — BUILT (migration `20260826280000`), pglite-rehearsed:** the backfill executes the
  locked rules exactly (B1 twin-trust incl. the emailless roster twin, B2 unique email-pair — both
  case/whitespace-insensitive), gives every remaining guest its OWN person, gap-fills merged
  persons (profile wins), writes the `person_merge_review` report (pending = owner sign-off queue:
  `shared_email_cluster`, `no_email_guest`, `twin_trust_failure`, `linked_mismatch` suggestions;
  applied = audit trail of the auto-merges), sweeps all 9 pairs (user triggers disabled per table
  so `updated_at` is preserved; the SET is the trigger's own derivation), and ends with a HARD
  verification DO block — any invariant violation rolls the whole migration back. **Deterministic
  person ids:** a person REUSES its source row's uuid (profile id for account holders — surviving
  Phase 4 as their person id — guest id for guest-only persons), which makes the backfill
  idempotent and trivially debuggable. **Live map maintenance (the dual-write promise):** AFTER
  INSERT triggers mint the person at creation (profiles → H1; guests → H2 with B1/B2-at-insert,
  same-email inserts serialized by an advisory lock so a race can't defeat the uniqueness rule);
  H3 collapses a live-claimed twin into the profile's person ONLY when the trust rule passes AND
  the collapse is provably safe (sole-source, no login) — re-pointing the link, re-stamping the
  guest's rows, dropping the orphan person; anything else (unsafe collapse, stamp cleared on a
  merged guest via the repurpose guard) files a `twin_detached_needs_split` review row. H3 fires
  on ALL updates (not `UPDATE OF twin` — the repurpose guard clears the stamp inside statements
  whose SET list never mentions it). Prod dry-run (2026-07-16 re-measure): 81 profiles + 453
  guests − 46 unique-pair merges − 0 pre-existing twins ⇒ **488 persons, 534 links, ~106 pending
  review rows** (27 guests in 13 clusters — incl. the 2 profile-matching ambiguous ones, with
  `suggested_profile_id` set — 76 no-email, 1 stale mislink). `person_merge_review` +
  `persons`/`person_links` in the backup allow-list (owner decisions must survive a restore).

  **Phase-2 adversarial verification (5 agents, 21 confirmed findings — all fixed pre-PR):**
  (1 critical) review rows retained PII after source hard-deletes → the source-delete cleanup now
  DELETES pending rows and SCRUBS applied audit rows (email + name payload; the merge fact
  survives, the who does not). (highs) a surviving merged person kept the deleted account's
  profile-only PII → the keep-branch now clears account fields (incl. `user_id`, freeing
  re-signup) and re-derives identity from the remaining sources; the **guest-then-signup account
  claim** (the flow behind 47/81 pre-backfill matches) silently split persons → H1 now applies the
  reverse unique-pair rule at signup (safe-collapse or pending `signup_pair_needs_review`); a
  B2-merged guest repurposed by EMAIL move kept stamping the wrong person → watched, files
  `merged_guest_email_moved`; multi-profile emails fell through every report → `multi_profile_email`
  kind (backfill + live). (mediums) H4 concurrent last-two-source deletes race → person row
  FOR UPDATE; the live collapse tripped the invoice guard's unconditional paid-lock for
  owner-operators → the guard now exempts person-column-only updates (everything else
  byte-identical); a source-row INSERT slipping between verification and trigger installation →
  `LOCK TABLE profiles, guest_players IN SHARE ROW EXCLUSIVE`. (observability) H2 now writes the
  same audit/review rows live that the backfill writes one-time (auto-merge audits, live clusters,
  live trust failures); E1 excludes already-merged guests from the pending queue. Review kinds:
  `auto_merged_email_pair` / `auto_merged_twin_trust` (applied) · `shared_email_cluster` /
  `no_email_guest` / `multi_profile_email` / `twin_trust_failure` / `linked_mismatch` /
  `twin_detached_needs_split` / `signup_pair_needs_review` / `merged_guest_email_moved` (pending).
  **External re-audit (Codex) round 2 — the freshness layer (P1/P2, both adopted):** persons
  would have gone STALE the moment a profile/guest was edited (the write surfaces stay old-world
  until Phase 3/4), and live merges/deletes each had bespoke field logic that could drift from the
  backfill's. Fix: **ONE central `rederive_person(uuid)`** (profile wins every field it has;
  guests fill gaps PER FIELD, oldest first; account-only fields from the profile or NULL; keyless
  new-world persons never touched) — used by the backfill (D is now a rederive-all loop, so
  backfill and live semantics provably cannot diverge and the backfill is SELF-HEALING on re-run),
  the live collapse, H2 merges-at-insert, H4's keep-branches (which drop the dying source's link
  first so rederive sees only survivors — also fixing the dropped-gap-fields case), and the new
  **H5 sync triggers**: any derivation-relevant edit on profiles/guest_players re-derives the
  person (fast-path guarded; twin/link churn never fires it). `rederive_person` is
  client-REVOKEd like the collapse helper.
  Rehearsal: `personsBackfill.pglite.test.ts` (32 tests, prod-mirroring FKs) runs the REAL
  migrations over every rule + the verification-flagged mutation survivors: multi-profile emails,
  twin-in-cluster, agreeing links, both-keyed divergent rows on EVERY money pair, gap-fill email
  precedence, content-level idempotency, live H1/H2 trust behavior, the GDPR scrubs, the invoice
  guard interaction, and a NEGATIVE test proving the hard verification fires and rolls back.

### Phase 3 — MIGRATE READERS, cluster by cluster (the bulk of the work)
One domain per PR, each with tests + live-verify, in dependency order:
1. **Roster/display** (cycle detail, players-overview, pickers) → read `person_id`.

   **Progress — 3.1 SHIPPED (migration `20260826290000`):** the CYCLE-DETAIL chain + the three
   player-side DISPLAY readers are person-keyed. (a) `personIdentity.ts` gains
   `unifiedPersonKeyOf` — person_id-first with a CONGRUENT raw-uuid fallback (deterministic ids +
   guest-side-first derivation make stamped and unstamped rows of the same person key
   identically; a merged twin's unstamped row degrades to today's split — never worse). (b)
   `getCycleDetail` selects `bookings.person_id`, groups the roster by the unified key;
   `CycleRosterEntry` gains `personId` + `refs: PersonRef[]` (ALL old-world refs the person's
   seats span; the XOR pair stays as the guest-preferred primary). (c) `CycleDetailView`:
   row keys + picker exclusions cover every ref; **Remove/Change iterate refs** — the one
   deliberate behavior change: a merged human is managed as ONE entry, so no half stays silently
   seated (swap-per-ref reuses swap's existing collision handling for duplicate seats). (d)
   `get_cycle_roster_names` gains a person-keyed arm (old arms + auth block + grants verbatim —
   deterministic ids do NOT make them sufficient: a merged guest's person id is the profile's id,
   absent from the profile arm without a player_id booking). (e) `get_my_person_id()` = the "who
   am I in the new world" choke point; the three player display readers
   (`get_my_linked_guest_bookings`, `get_my_paid_booking_ids`, `get_my_pending_priority_claims`)
   go person-first with the Phase-0c twin-precedence bridge kept VERBATIM (covers the
   linked-but-unmerged guests pending P-B). Explicitly deferred: `can_book_member_window`
   (booking-path auth gate → 3.3), `get_players_overview` re-key + picker person-dedup (→ 3.2),
   every write-path person predicate (→ 3.3).

   **External audit (Codex) hardening rounds on 3.1:** (r1) the claims reader's bridge had lost
   twin-precedence — restored VERBATIM. (r2) the split-pending freeze was person-arm-only —
   hoisted OUTSIDE every OR arm of all three readers (a frozen guest is invisible on ALL paths,
   not just the person path). (r3) **the direct player path is now PURE-PROFILE**: dual-keyed
   rows are the GUEST person's (FAM-02), so the four player bookings RLS policies gain
   `AND guest_player_id IS NULL`, the three client `.eq('player_id', me)` reads add
   `.is('guest_player_id', null)`, and `get_my_linked_guest_bookings` re-partitions from
   `player_id IS NULL` to `guest_player_id IS NOT NULL` — legitimately-merged both-keyed rows
   reach the player view-only through the frozen RPC, and split-pending rows are invisible on
   BOTH paths (pglite pins under `SET ROLE authenticated`). Doctrine: a freeze or ownership rule
   is only real once every path — RPC arms, RLS policies, AND direct client reads — enforces it.
   Known r3 consequence to fold into the 3.3 booking/session-report reader pass (Codex
   non-blocking note, confirmed): `PendingAttendanceCard.fetchPendingPlayerSlots` still reads
   bookings via plain `.eq('player_id', me)`, so it now surfaces only pure-profile sessions —
   a both-keyed (guest-person) session no longer triggers the account holder's attendance
   prompt until that surface goes person-keyed.

   **Progress — 3.2 BUILT (migration `20260827100000`):** the PLAYERS OVERVIEW + CYCLUS GROUPS
   render persons. (a) `is_guest_split_frozen(uuid)` — the split-pending freeze as a NAMED
   choke point (DEFINER, client-REVOKEd, spliced); both list RPCs use it instead of hand-copied
   EXISTS blocks. (b) `get_players_overview` returns ONE ROW PER PERSON: sides resolve through
   person_links (frozen/unlinked → self), merged rows carry BOTH ids + a new `person_id`
   column, identity comes from the persons row (the rederive choke point — precedence is NOT
   re-derived per field in the reader), `player_key` stays g_/p_-parseable (guest-preferred;
   invoiceCustomer + detail routes parse it), metadata joins person-wide (tag UNION,
   guest-first metadata_id/notes), and ALL booking/intake activity matching is ref-set based
   with the FAM-02 pure-profile guard — an unmerged parent stays LISTED (membership predicate
   deliberately unchanged this phase) but no longer wears the child's activity chips; invoices
   keep the 3.1-r3 addressee exemption. (c) `get_academy_cyclus_groups` roster names key by
   person uuid (guest-first, frozen-as-self, congruent fallback), names from persons; a person
   intaken via profile + booked via guest seat dedups by KEY, not just name equality.
   (d) client: `BookablePerson.personId` + merged rows carry both ids; the roster picker gains
   `excludePersonIds` (closes the profile-only-entry vs guest-keyed-picker-row exclusion gap).
   pglite suite (27) runs the REAL migration incl. a frozen guest with a deliberately STALE
   person stamp — readers must resolve links, never trust stamps for identity.

   **Adversarial verify pass on 3.2 (81 agents, 25 raw → 18 confirmed, all fixed or tracked):**
   headline fixes — (r1) resolvePersonToGuest now passes the merged row's profileId as the twin
   hint (person_links-sourced, NOT linked_profile_id), restoring the cross-identity roster dedup
   that prevented double seats + double invoices; (r2) metadata editors write exactly-one key
   (the CHECK constraint) and the overview reads tags/notes from THE SAME guest-first row it
   exposes as metadata_id; (r3) merged-row identity is SCOPE-SAFE — in-scope-profile-first, not
   persons contact/billing fields (which aggregate cross-tenant); only full_name comes from
   persons; (r4) removal is person-level for merged persons; (r5) all owner trainers of a
   multi-guest person filter/chip; (r6) side identities stay searchable + side emails still
   badge deliverability; (r7) deterministic pick tiebreakers; (r8) groups intake suppression
   compares BOTH display and side names. Tracked, not fixed here: a merged person's PROFILE-side
   detail page is unreachable from the list (row links g_; person-keyed detail = 3.3 scope), and
   is_guest_split_frozen is a per-row definer call in the two list RPCs (bounded scopes, tiny
   review table — accepted until profiling says otherwise).
   **Progress — 3.3a BUILT (migration `20260828100000`), BADGE-ONLY scope:** the roster badge
   tells LOGINS, not seats (owner-reported after 3.2: a merged human read 'registered' on the
   Players page but 'Guest' inside a cycle). (a) `get_cycle_roster_names` gains `has_login` per
   row — person arm from `persons.user_id`, profile arm from `profiles.user_id`, guest arm
   through person_links ONLY (never linked_profile_id) and suspended while split-frozen; DISTINCT
   ON keeps the person arm's verdict. (b) `CycleRosterEntry.hasLogin` + the badge flips to
   `!hasLogin`, with a primary-ref fallback that reproduces the old badge exactly until the
   extended RPC is deployed (Vercel ships before `db push`). (c) hardening: `get_academy_cyclus_
   groups` REVOKEd from PUBLIC/anon (was default-executable; its auth gate already rejected anon).
   **Adversarial verify (16 findings, 3 confirmed test-gaps fixed + 1 real bug caught):** the
   render test found the badge condition had been left as `p.hasLogin` (inverted) — fixed to
   `!p.hasLogin`; the pglite matrix now pins the guest-arm `profile_id IS NOT NULL` join (a guest
   linked only to its own profile-less person → false) and the profile arm's TRUE direction.
   **PULLED from 3.3a → its own slice (3.3-attendance):** the `PendingAttendanceCard` player-side
   person-keying. Surfacing a guest-seated session for attendance is a DEAD-END until the
   `session_reports` INSERT/UPDATE/SELECT RLS policies (which require a `player_id = me` booking
   on the slot) are person-keyed — that write-path RLS change belongs with the booking-path work,
   not a badge fix. The 3.1 tracked gap (attendance card sees only pure-profile sessions) stays
   open until then.

   **Progress — 3.3-attendance PART 1 (RLS) BUILT (migration `20260831100000`):** a guest-seated
   session is now REPORTABLE. The player attendance write path (session_reports INSERT/UPDATE) +
   the player trainer-summary view gated on `b.player_id = me` (pure-profile), so a player seated
   under their linked guest twin (guest_player_id set, player_id NULL) hit a DEAD-END on submit —
   exactly why the PendingAttendanceCard surfacing was PULLED from 3.3a. New SECURITY DEFINER
   `can_report_attendance_on_slot(slot, require_active)` answers "does the caller's PERSON hold a
   (optionally active) booking here?" — profile seat OR linked-guest seat, resolved EXACTLY like
   `get_my_linked_guest_bookings` (person-stamp arm OR Phase-0c twin/link bridge, split-frozen
   excluded) so every session the player can SEE is one they can WRITE (no surface-vs-write skew).
   The profile arm is PURE-PROFILE — `b.player_id = me AND guest_player_id IS NULL` — NOT the old
   policy's bare `b.player_id = me` (which predated FAM-02 and let a DUAL-KEYED row bypass the
   freeze/person checks — Codex P1, fixed). It stays a superset for account holders (a pure-profile
   seat still grants; a dual-keyed row that is genuinely my merged person still grants via the guest
   arm's `b.person_id = my person`). INSERT + UPDATE policies + the summaries view re-emitted with
   the helper; the reporter-based SELECT policy is unchanged. **NO frontend change here** — this
   only ENABLES guest-seated reporting; deliberately SPLIT so the PendingAttendanceCard surfacing
   re-lands in PART 2 (after this deploys), avoiding any Vercel-before-`db push` window where a
   surfaced prompt would dead-end. pglite (14) drives the real policies under `SET ROLE authenticated`
   incl. two FAM-02 dual-keyed bypass pins (frozen-guest + different-person seat).

   **Progress — 3.3-attendance PART 2 (card) BUILT:** re-landed the PendingAttendanceCard
   person-keying pulled from 3.3a — now safe because PART 1 (RLS) makes guest-seated sessions
   writable. `src/lib/pendingAttendance.ts` (extracted, testable): the direct read is PURE-PROFILE
   (`player_id = me AND guest_player_id IS NULL`, FAM-02) merged with `fetchLinkedGuestBookingRows`
   (the frozen linked-guest RPC), same 14-day/status window applied to the merged rows, ONE prompt
   per slot (a merged person can hold both keys on one session), session_reports dedup. The card
   uses the lib. 6 unit tests. **This CLOSES the 3.1 tracked attendance gap** — a guest-seated
   session now both surfaces AND is reportable.

   **Progress — 3.3b BUILT (migration `20260829100000`):** the player DETAIL page reaches the
   whole PERSON. (a) new SECURITY DEFINER RPC `get_person_refs_for_scope(scope, scope_id,
   guest_id, profile_id)` resolves a clicked g_/p_ ref → the person's IN-SCOPE ref set —
   `(guest_ids, profile_id)`, REFS ONLY, no identity/PII (do NOT copy the dangerous first-cut
   model that returned name/email/has_login; see the verify note below). person_id is deliberately
   not returned either (it equals the profile id for account holders, so echoing it would disclose
   a gated profile uuid). Authorized exactly like get_players_overview; the clicked ref is
   validated in-scope (IDOR guard); split-freeze aware (frozen clicked guest = its own person;
   frozen siblings excluded); the profile id is released only when the caller can already see it
   (in-scope booking or invoice). person_links is RLS-locked, hence DEFINER. (b) client
   (`playerDetailData.ts`): `fetchPersonRefSet` (falls back to the single clicked ref on
   PGRST202/error — pre-deploy congruence), `fetchPersonBookingSlotIds` (unions bookings across
   refs, FAM-02 pure-profile guard on the profile side, RLS-scoped to the caller's slots),
   `fetchPersonInvoices` (unions guest- + profile-addressed invoices, addressee exemption, deduped).
   Both AcademyPlayerDetail + TrainerPlayerDetail now show a merged human's full session +
   invoice history. **Scope note:** identity/edit machinery + `linked_profile_id` reads left
   UNCHANGED (write behavior untouched); rating history left as-is (player_rating_history has
   only a self-view RLS policy → already dormant on the manager/trainer detail page, a separate
   pre-existing non-feature, not a unification gap). linked_profile_id retirement stays for the
   Phase-4 prep sweep.
   **Adversarial verify (8 confirmed, all fixed) — the RPC's first cut was a cross-tenant PII
   oracle:** it returned identity fields the client never uses AND (a) never validated the CLICKED
   ref was in-scope (IDOR — any manager could dereference an arbitrary guest/profile uuid to its
   PII), (b) resolved the profile side with no scope gate, (c) sourced identity from persons.*
   contact fields, which aggregate SYSTEM-WIDE (the exact leak 3.2's overview already forbids).
   Fix: the RPC now returns REFS ONLY (guest_ids, profile_id — no name/email/phone, and no
   person_id since it equals the profile id for account holders and would leak a gated profile
   uuid), validates the clicked ref is in-scope (a clicked guest must be a scope guest; a clicked
   profile must have an in-scope confirmed/completed booking), and returns profile_id only when the caller
   can already see it (in-scope booking OR invoice). DOCTRINE (re-confirmed): a person-resolution
   reader must expose no ref/PII the caller couldn't already see in its scope, and identity NEVER
   comes from persons.* contact fields.

2. **Membership layer** (decide Open question P-A) → move per-owner metadata off guest_players.
3. **Booking path** (RPCs, capacity, holds) → `person_id`.

   **Progress — 3.3c BUILT (migration `20260830100000`):** the booking ELIGIBILITY gate is
   person-keyed. The scout confirmed every booking WRITER already keys seats on
   player_id/guest_player_id and inherits `person_id` from the Phase-1 stamp trigger — so the
   only booking-path function still inferring identity from twin/link was `can_book_member_window`
   (its guest clauses (d)/(e): "is this priority guest the same human as me?"). Those clauses now
   carry a PERSON ARM (guest and my profile resolve to the same person via person_links — catches
   merges with no twin stamp) UNIONed with the Phase-0c twin-precedence bridge kept VERBATIM
   (linked-but-unmerged guests are still pending in the P-B owner queue, so the twin/link reads
   can't be hard-removed until Phase 4 after the queue drains), and the split-freeze now excludes
   uncertain-identity guests from BOTH arms. The union is a strict SUPERSET of prior behavior — no
   eligibility lost, person-merged guests gain coverage; the freeze is the one deliberate
   subtraction (a pending-split guest no longer grants eligibility — correct: identity uncertain).
   No types-drift because the SIGNATURE is unchanged (NOT because of the grant — Supabase generates
   types for every function regardless of grants, so `can_book_member_window` does appear in
   types.ts; the service_role lock is a runtime guard, not a type-gen exclusion). The function is
   service_role-only at runtime; clients only ever call the `can_current_user_book_member_window`
   wrapper. The client twin-hint (CycleDetailView.resolvePersonToGuest) was already person-sourced
   in 3.2. **Twin/link column RETIREMENT stays for Phase 4** (drop twin_of_profile_id/
   linked_profile_id once the review queue is drained and nothing reads them).
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
- **P-C (Phase 3.4): RESOLVED — identity-only.** Owner chose "dedup/grouping only, amount math
  UNCHANGED". 3.4 (migration `20260902100000`) person-keys `create_invoice_deduped`'s double-bill
  guard and nothing else. The two headcount/recipient-count divisors (`split-invoice` N,
  `cycle-commitment` `group.size`) are deferred to a future explicit money-amount phase.

## 8. First actionable step
Phase 0 (consistent person provisioning on the roster/add paths) OR Phase 1 (Expand) — both are
safe, additive, and independently valuable. Recommend Phase 0 first: it also delivers the
"add a registered account as a cycle participant" capability the owner asked for, immediately.

   **Progress — 3.3d BUILT (migration `20260901100000`):** the player DETAIL-page type badge tells LOGINS, not the clicked seat (owner-reported after the 3.3 deploy: Adri Govers — a merged account holder — showed 'Guest' on his contact page because the badge keyed on parsed.kind=g_). `get_person_refs_for_scope` gains a person-level `has_login` boolean (resolved person's persons.user_id; a boolean, not PII; frozen clicked guest → own accountless person → false); both AcademyPlayerDetail + TrainerPlayerDetail badge on `refs.hasLogin ?? seat-type` (fallback = old seat-based until deployed). The players-LIST type column was already correct (get_players_overview returns player_type='registered' — verified in prod; a stale bundle explains the reported list symptom). Deferred still: the fuller detail-page identity person-keying (name/linked_profile_id) → Phase-4 prep.

**3.3e (migration `20260901110000`): the players-overview TYPE column tells LOGINS.** Owner
saw 6 RL Padel account holders labelled 'Guest' in the list Type column — `get_players_overview`
computed `player_type` from `b_has_login = bool_or(profile side IN SCOPE)`, so a login holder who
only ever attended as a GUEST (no in-scope player_id booking → no profile side in `sided`) showed
'guest'. Same seat-vs-login bug as the roster (3.3a) + detail (3.3d). player_type now = the resolved
PERSON has a login (persons.user_id of b_person_id); a 'registered' row may carry profile_id NULL
(profile out of scope) — the Type/Status badges only read player_type and detail links/edit flows key
on guest/profile ids independently, so nothing downstream breaks. CREATE OR REPLACE (signature
unchanged → no drift), everything else verbatim from 20260827100000. Diagnosed in prod: 375/419
players genuinely accountless ('almost all guest' is correct), only 6 mislabelled → now 'registered'.

**3.4 (migration `20260902100000`): person-key the invoice double-bill guard — AMOUNT-NEUTRAL.**
Resolves open decision **P-C = identity-only** (§7): dedup/grouping only, amount math untouched.
`create_invoice_deduped` (the atomic P1-6 per-recipient create guard; the auto-create-invoice dedup
insert path — NOT the only way an invoice row is inserted: event-registration, public-rebook, and the
manual custom-invoice flows insert directly, out of 3.4's scope) keyed its advisory lock + overlap
recheck on the OLD-WORLD ref
(player_id XOR guest_player_id). After unification a person can hold BOTH a profile ref and a guest
ref, so two creates for the SAME bookings under the two keys took DIFFERENT locks and the per-key
recheck missed the sibling → a SECOND active invoice = cross-key double charge (P1-6 closed only
same-key concurrency). Fix: resolve the recipient to a PERSON guest-first (byte-identical to
`stamp_person_id_invoices`) and (a) key the advisory lock on the person so cross-key concurrent
creates serialize on ONE lock, (b) add a person arm `i.person_id = v_person_id` to the overlap
recheck so the serialized second create FINDS + returns the sibling (deduped=true). The
booking-overlap gate is UNCHANGED, so it only ever returns a pre-existing invoice billing the SAME
bookings — never merges distinct charges, never divides, never restates a total. Congruent
degradation: an unlinked / pre-backfill recipient → v_person_id NULL → exact pre-3.4 per-key
behaviour; unstamped invoices still caught by the retained per-key arms. CREATE OR REPLACE (signature
unchanged → no types.ts drift). Adversarial verify: 0 confirmed findings (3 P3s refuted as
congruent/self-healing). **SPLIT-FREEZE (external audit P2, folded in — a real money-path
regression my verify + one auditor MISSED): the 3.4 person arm had no freeze handling.** While a
`twin_detached_needs_split`/`merged_guest_email_moved` review is pending the guest's link may be a
DIFFERENT human, so nothing may act on it (doctrine since 3.1). The dedup did: a frozen guest's create
resolved to the sibling person and deduped onto that human's invoice → auto-create-invoice's
`syncDedupedInvoiceToPaid` (M-27) could flip the other human's invoice to paid AND the guest was never
billed. Fixed exactly like the 3.3-attendance guard: inbound `v_person_id` → NULL when
`is_guest_split_frozen(guest)` (collapses to pre-3.4 per-key), and the person arm also excludes a
sibling invoice addressed to a frozen guest (`is_guest_split_frozen(NULL)`=false so profiles/
profile-addressed siblings are unaffected). +3 pins, mutation-checked (the 2 freeze pins fail on the
pre-freeze migration). **FAM-02 dual-key follow-up (audit round 3, folded in): re-derived the WHOLE
recheck arm-set from the FAM-02 recipient rule (a dual-keyed row belongs to the GUEST).** Freezing
`v_person_id` alone wasn't enough for a dual-key payload (reachable — auto-create-invoice passes both
keys from `bookings[0]`): P1-6's bare profile arm still deduped a frozen dual-key create onto the other
human's profile invoice. Final 3 arms = A pure-profile (`v_guest_player_id IS NULL AND i.guest_player_id
IS NULL` on both sides) | B guest-recipient (`v_guest_player_id IS NOT NULL AND i.guest_player_id =
v_guest_player_id` — fires for guest-only AND dual-key, keeps the double-bill guard alive for a frozen
dual-key recipient, freeze-safe by construction) | C person cross-key (freeze-guarded both sides).
+3 dual-key pins, each mutation-checked. Lesson: person-keying a predicate = re-derive the whole
arm-set, don't narrow one arm (narrowing A silently broke B's coverage → a double-insert).
**Lock-key follow-up (audit round 4): the advisory lock must use the SAME guest-first recipient rule
as the recheck.** It was profile-first (`COALESCE(v_person_id, v_player_id, v_guest_player_id)`), so a
frozen/unlinked dual-key payload locked on the profile while a guest-only create for the same guest
locked on the guest — the two didn't serialize, and since arm B now cross-matches them the P1-6
double-bill race was reopened for mixed shapes. Lock key is now guest-first (`COALESCE(v_person_id,
v_guest_player_id, v_player_id)`) = the recipient rule, so every same-recipient shape serializes on one
lock. +2 mixed-shape recheck pins (lock serialization isn't exercisable in single-connection PGlite).
Four audit rounds on this one migration; the lock↔recheck-key coherence is the general lesson.
**Freeze-transition follow-up (round 5, my own verify): the lock must use a FREEZE-INDEPENDENT
recipient id.** Arm B is freeze-blind, but the lock followed the freeze-gated `v_person_id`, so a
twin-split/email-move review committing between two concurrent same-guest creates split them onto
`trainer:person` vs `trainer:guest` → double-insert. Fixed by keying the lock on a separate raw
`v_lock_person_id` (no freeze gate); the recheck keeps the freeze-gated `v_person_id`. The lock now
only ever OVER-serializes (harmless), never under-serializes. Residual (~P4, accepted): a
`person_links` mutation in the same window — advisory-locked in the merge paths, far rarer, resyncs
via rederive; tracked for a broader freeze/lock-coherence pass. DOCTRINE: when a guard pairs an
advisory lock with a freeze-gated recheck, the lock key must be the freeze-INDEPENDENT recipient id. **SECURITY (external audit P1, folded in): locked the RPC to service_role
only.** It is SECURITY DEFINER and INSERTs invoices with no internal ownership check;
`auto-create-invoice` is the authz boundary (admin / slot trainer / academy manager, else 403) and
calls it with the service-role client (`requireUser()` hands every caller a service client), so the
pre-3.4 `GRANT … TO authenticated` was pure attack surface — any logged-in user could mint an
arbitrary invoice directly via PostgREST. `REVOKE … FROM authenticated`; `GRANT … TO service_role`
(mirrors the `can_book_member_window` service-role lock). No caller breaks (verified sole caller +
service client). **Deferred (amount-affecting divisors, need an explicit money-amount
phase):** `split-invoice`'s `Object.keys(playerBookings).length` (that grouping count IS the split
divisor N = `floor(total/N)`) and `_shared/cycle-commitment-invoicing.ts` `group.size` — both are
recipient-COUNT math, not recipient dedup. The client `groupChargeableBookingsByRecipient` add-player
partition is a per-operation single-key-per-person no-op (new bookings carry one key) fully
backstopped by the atomic RPC guard.
