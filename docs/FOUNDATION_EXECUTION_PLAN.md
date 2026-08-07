# Foundation execution plan

**Status:** U1a authorized by owner 2026-08-07 (additive canonical membership foundation + read-only migration inventory only); every other unit remains proposed and gated. Open owner decisions: OD-07/OD-08 (gate U3/U7), OD-09 (merge semantics — gates U2), OD-10 (membership lifecycle — gates the first populated membership writer). None may be decided inside U1a  
**Baseline:** `ea54f08b3a204a4ed29c3d37976d51ed2d841ad6`

## Programme rules

- Each unit is a small release with design review, implementation, tests, independent Codex review, exact-head CI,
  and an owner gate where named.
- Additive and destructive migrations never share a release.
- No production access, migration, deployment, merge, notification activation, refund, or deletion without its gate.
- Facts/recommendations/decisions remain separate. A unit cannot silently settle an open product decision.
- Every data-moving migration has inventory, reconciliation, resumable backfill, production-shaped rehearsal, and
  rollback/roll-forward; a purely additive expand migration (U1a) requires the inventory, rehearsal, and rollback
  pieces only — its backfill belongs to a later, separately gated unit.

## Ordered units

### U0 — Owner design approval and baseline certification

**Depends on:** none.  
**Work:** record and classify the open owner decisions OD-07–OD-10 (none is a U1a prerequisite — OD-07/08
gate U3/U7, OD-09 gates U2 merge semantics, OD-10 gates membership population; recording is not resolving);
reconcile stale canonical status; freeze entity/state/permission vocabulary; capture
schema/function/grant/reference inventory at exact main SHA.

**Acceptance:** owner signs the decision ledger; no conflicting canonical statement remains unclassified; inventory
scripts are read-only and reproducible. **Rollback:** documentation revert. **Owner gate:** approve the blueprint direction and the next bounded subunit (currently U1a; each subunit gates separately).

### U1 — Additive Player membership contract (split U1a / U1b / U1c)

**Depends on:** accepted OD-02/OD-03 — sufficient for U1a (empty additive skeleton). Open OD-10 gates the
FIRST populated membership writer (U1c, or U2 if it writes membership rows earlier), not the empty U1a
table; OD-07/OD-08/OD-09 stay open and must not be decided in this unit.

#### U1a — membership foundation + migration inventory (AUTHORIZED by owner 2026-08-07)

**Work:** add the canonical `academy_player_memberships` skeleton with exactly this DDL: `id uuid PRIMARY
KEY DEFAULT gen_random_uuid()`; `academy_profile_id uuid NOT NULL` FK → `academy_profiles(id)`;
`person_id uuid NOT NULL` FK → `persons(id)` — both FKs with preservation-safe actions
(`RESTRICT`/`NO ACTION`; never cascading deletion of membership evidence or Player history; provisional
pending OD-10 — see the note below) — `UNIQUE (academy_profile_id, person_id)` (both columns NOT
NULL, so the uniqueness cannot be defeated by NULL pairs); a person-leading index (`CREATE INDEX ... ON academy_player_memberships (person_id)` — the
`idx_apm_person` precedent) for person-side reads, FK checks, and future repoints; `created_at`/`updated_at`
`timestamptz NOT NULL DEFAULT now()`, with `updated_at` maintained by the standard
`update_updated_at_column()` trigger. The FK deletion actions are PROVISIONAL while the table is empty:
the person-side action is fixed by open OD-10, and the academy-side action must reconcile with the admin
academy-delete flow (which promises removal of the academy and all associated data —
`src/pages/admin/AdminAcademies.tsx:536` — while existing academy-owned tables CASCADE); both are
confirmed in the U1a design review and re-examined before any writer populates the table. Nothing
else in U1a: no notes/status/tags/trainer-assignment/settings/billing columns (those arrive only with
later reviewed slices). RLS enabled default-deny from creation (zero policies plus named-role REVOKEs,
including the service-role table lockdown idiom). Plus a read-only, reproducible inventory/rehearsal
artifact over the legacy relationship sources — `academy_player_metadata`, `academy_player_locations`, and
the academy-/trainer-owned `guest_players` rows, resolved exclusively through existing `person_links`
(eligibility is never derived from email/phone/contact inference) — reporting: totals; rows missing
`person_id`; duplicate `(academy, person)` groups; field conflicts (notes, tags, billing email, removal
state, trainer assignment, preferred location); orphaned references; cross-tenant trainer/location
anomalies; rows deterministically eligible for later backfill; per-academy reconciliation counts; plus
read-only arms counting relationships today derivable only from bookings at academy trainers
(`bookings` × `availability_slots` × `academy_trainers` — the shipped reader rule in
`20261006120000`/`20261015130000`), so the later backfill can be reconciled against every live
derivation path, with trainer-only guest associations classified unresolved unless direct academy
evidence exists — and with split-frozen guests, email-auto-merged (`auto_merged_email_pair`) links,
trainer-owned (`trainer_profile_id`) metadata rows, dual-key visibility-only relationships (rows that
reach an academy only through the deliberately unguarded visibility arms —
`20260904100000_phase35b_rls_helpers_person.sql:106-146`, `20261015130000_notif_n3_player_visibility.sql:32-67`),
and twin/linked-bridge relationships that diverge from `person_links` each reported as their own class and
marked unresolved/ineligible, never silently folded into eligible counts. No read or write switch, no backfill, no dual-write, no legacy
modification.

**Acceptance/tests:** the additive migration applies from the real chain; existing tables/rows untouched;
duplicate `(academy, person)` rejected; NULL keys rejected (both columns NOT NULL); invalid references
rejected; authenticated tenants denied by default; the new table has zero `pg_policies` rows and no direct
table privileges for `PUBLIC`/`anon`/`authenticated`/`service_role` (named-role REVOKEs verified); two
academies relate to one Player independently without seeing each other's relationship;
inventory deterministic and mutation-free; migration reset/types drift green. **Rollback:** drop the unused
additive objects. **Gate:** owner approves the production additive migration separately.

**Status:** authorized 2026-08-07; documentation checkpoint REVIEW-CLEAR 2026-08-08 (11 independent Codex
rounds — final verdict "no actionable findings beyond the recorded open owner decisions"; open: OD-09/OD-10
plus the deferred code-adjacent chores in `DOCUMENTATION_INDEX.md`); implementation not started, awaiting
the owner's answers to the U1a decision batch (OD-09, table shape, OD-10).

#### U1b — legacy mapping + backfill rehearsal (NOT authorized)

**Work:** define the deterministic mapping from every relationship source inventoried in U1a (academy
metadata, locations, guest/profile records, AND the booking-derived arms), classifying every U1a inventory
arm as eligible or one of the unresolved classes; add drift and cross-tenant anomaly reports as durable
artifacts; checkpointed, resumable backfill rehearsal.

**Acceptance/tests:** backfill rehearsal reports deterministic counts, orphans, duplicates, and
checkpoints; reconciliation stable across reruns. **Rollback:** stop writes/drop only unused additive
objects. **Gate:** owner authorizes U1b explicitly; the production backfill is a separate later gate.

#### U1c — production membership backfill execution (NOT authorized)

**Depends on:** U1b, and a membership-aware person-lifecycle slice — the shipped
`collapse_guest_person_into`, last-source cleanup, and `merge_guest_players` repoint only the legacy
stamp tables and then DELETE the `persons` row (`20260826280000_persons_backfill.sql:488-508,840-851`;
current merge definition `20260826240000_twin_reader_precedence_and_lock.sql:293`), so populated
membership FKs would block or
orphan those flows. Membership behavior on merge/collapse/anonymize/delete is **open owner decision
OD-10** (`FOUNDATION_DECISIONS.md`) and must be decided and implemented before U1c executes. (U1a is
unaffected: its table stays empty.)

**Work:** execute the U1b-rehearsed deterministic backfill against production data with resumable
checkpoints, before/after counts by academy, and reconciliation reports; no notifications, no provider
calls, no legacy modification beyond the additive membership writes.

**Acceptance/tests:** reconciliation counts match the U1b rehearsal predictions; re-running changes no
rows; unresolved classes (split-frozen, auto-merged-pair, trainer-owned, dual-key visibility-only,
bridge-divergent) remain untouched and reported.
**Rollback:** the backfill is additive — delete only the rows this backfill wrote, identified by its batch
manifest/checkpoint log (never `TRUNCATE`: later units may already write membership rows).
**Gate:** explicit owner approval; must be complete before any reader/writer switch (U3+) that depends on
complete membership data.

### U2 — Player claim and identity writer convergence

**Depends on:** U1a; reconfirm D-07 (recorded direction, no dated record) at unit start; open owner
decision OD-09 (B2 disposition, `FOUNDATION_DECISIONS.md`) must be answered before this unit relies
on merge semantics; and if this unit writes membership rows before U1c, the OD-10 membership-lifecycle
prerequisite applies to it first (it is then the first populated membership writer).  
**Work:** one idempotent server command for academy-created Player and later account claim; route bounded creation/linking
flows through canonical person/membership writes while maintaining compatibility projections.

**Acceptance/tests:** same Player UUID before/after signup; replay stable; merge semantics conform to the
owner's OD-09 answer (the shipped unique-pair B2 auto-merge conflicts with D-04 read strictly — see the
recorded conflict in `FOUNDATION_DECISIONS.md`); the reviewed merge command remains the sole duplicate
resolution — with, if OD-09 retains B2, the documented narrow unique-email auto-merge as the one automatic
exception; failure injection leaves no partial auth/person link; no notification backfill. **Rollback:** switch callers back while dual-write remains. **Gate:** owner approves auth-flow rollout.

### U3 — Read migration and tenant/capability foundation

**Depends on:** U2, OD-04/05/07; U1c (executed membership backfill) for any reader that depends on
complete membership data — and membership-dependent readers retain compatibility reads for every
class U1c leaves unresolved (split-frozen, auto-merged-pair pending OD-09, trainer-owned, dual-key
visibility-only, bridge-divergent) until the owner-gated adjudication resolves them; reconfirm D-07 if
not already reconfirmed at U2.  
**Work:** central academy scope and trainer capability predicates; fix `get_player_locations`; migrate player roster/detail
readers in bounded clusters; add permission audit ledger and management UI with planning off by default.

**Acceptance/tests:** complete role×tenant×capability matrix under real JWT/RLS; foreign refs refused; revoked grants take
effect immediately; Player/academy visibility matrix passes; no page-local authorization. **Rollback:** feature flag/read
switch to compatibility readers; preserve grants/mappings. **Gate:** owner accepts permission UX and any MFA rollout.

### U4 — Planning publication boundary

**Depends on:** U3 and accepted OD-04 association-publication semantics; reconfirm D-08/D-09/D-10
(recorded direction, no dated record) at unit start.  
**Work:** explicit planning revision/state model; immutable proposal input; impact preview; atomic idempotent publish command;
Calendar becomes read-only and bounded.

**Acceptance/tests:** stale/double publish refused or replayed; injected failure rolls back every session/booking; suggestions
cannot publish; queries use bounded windows/keysets; keyboard and screen-reader workflow tests. No source notifications are
sent during backfill. **Rollback:** keep legacy planning path available behind a switch until parity proven. **Gate:** owner
approves publish UX and rollout.

### U5 — Atomic session/cycle change commands

**Depends on:** U4; reconfirm D-09/D-10 if not already reconfirmed at U4.  
**Work:** replace `TrainerScheduleOverview` multi-write edit with preview + explicit scope + one transaction; model linked
reschedule/cancel transitions; enqueue after-commit work only.

**Acceptance/tests:** real concurrent edit/book/publish tests; failure at each stage rolls back; DST and capacity invariants;
paid records protected; preview lists affected Players/bookings/invoices/payments/notifications; stale preview rejected.
**Rollback:** disable new command and retain old reads; data writes are compatible. **Gate:** owner approves scheduling rollout.

### U6 — Billing parties, financial state machines, and adapters

**Depends on:** U2/U5, OD-06; reconfirm D-11 (recorded direction, no dated record) at unit start.  
**Work:** additive billing profiles and immutable invoice snapshots; canonical allowed transitions; normalized payment adapter
contract around Mollie/manual; no provider switch and no historical rewrite.

**Acceptance/tests:** personal/company cases, issued snapshot immutability, duplicate/reordered webhook concurrency,
charge/confirm organization equality, refund/chargeback audit, provider-adapter contract suite, reconciliation counts.
**Rollback:** continue reading legacy invoice party fields while dual-write/snapshots remain. **Gate:** owner approves money
path migration and separately approves any refund capability.

### U7 — Operations, recovery, scale, and DR proof

**Depends on:** U3–U6, OD-07/08.  
**Work:** reconciliation dashboard/alerts, one-entity verify/relink/recovery, query budgets, synthetic 100k dataset, real
concurrency suite, retention jobs, disposable restore rehearsal and RPO/RTO record.

**Acceptance/tests:** no routine recovery needs raw SQL; every action previews and audits; 100k list queries remain bounded
and index-backed; high-volume agenda/date windows meet agreed budgets; restore drill proves critical tables and evidence.
**Rollback:** recovery tools are disableable and read-first; no auto-remediation. **Gate:** production/credentials and restore
drill require explicit owner approval.

### U8 — Read/write switch completion

**Depends on:** all prior units and an observation window.  
**Work:** switch remaining canonical readers/writers to Player/membership/billing models; keep compatibility projections;
inventory every legacy reference and historical row.

**Acceptance:** zero legacy-only writes; zero unmapped rows; reconciliations stable for owner-agreed window; exports,
functions, RLS, generated types, edge functions, and admin tools all use canonical IDs. **Rollback:** switch reads/writes
back through still-present compatibility layer. **Gate:** owner approves declaring contraction eligible.

### U9 — Destructive contraction (separate later release)

**Depends on:** U8 plus explicit owner deletion approval.  
**Work:** remove guest terminology and compatibility code, then old columns/tables only in separately reviewed steps.
Physical `persons` rename is excluded unless OD-02 explicitly chooses it.

**Acceptance:** pre/post counts and hashes reconcile; no references in code, DB functions, policies, views, exports, docs,
or historical rows; production-shaped restore and roll-forward rehearsed. **Rollback:** restore compatibility schema/code from
the immediately preceding release; take verified backup/checkpoint. **Owner gate:** destructive approval for each contraction.

### U10 — Final combined integration/load/security audit

**Depends on:** U1–U8 (and U9 only if separately approved).  
**Work:** fresh end-to-end journeys for account claim, multi-academy Player, registration→planning→calendar, standalone/cycle
changes, public booking/payment, invoice/refund/reconciliation, permissions, deletion/retention, and notification seams.

**Acceptance:** no actionable P0/P1/P2; synthetic scale and real concurrency budgets pass; full local gates and exact-head CI
green; independent Codex review clear; canonical docs match the shipping tree. **Gate:** owner decides release/deployment.

## Required proof for every data-moving unit

(Expand-only units such as U1a owe the inventory, rehearsal, rollback, and no-notification rows only;
the backfill/dual-write rows apply from U1b/U1c onward.)

- before/after counts by table/tenant/state and mapping coverage;
- orphan, duplicate, ambiguity, and cross-tenant reports;
- deterministic mapping/version and resumable checkpoint log;
- transaction boundaries and injected-failure tests;
- production-shaped rehearsal without provider sends;
- explicit rollback and roll-forward;
- statement that no notification/email backlog was created;
- contract/drop/delete deferred to an owner-gated release.

## Review workflow for each approved implementation slice

The implementing Claude session (model/mode per the operator policy in `CLAUDE.md`, verified and truthfully
reported at session start) with Ultracode implements one bounded slice, runs focused and
repository-required tests, and then asks Codex through MCP (GPT-5.6-sol, read-only) to inspect the actual
working-tree/branch diff. Claude evaluates each P1–P3 finding, fixes every valid P1/P2 and actionable P3,
reruns affected tests, and asks Codex again until clear. There is no arbitrary round cap, but rounds must
converge: three consecutive rounds of defects in one invariant family trigger the codex-review convergence
protocol (design-level review) instead of another isolated patch, and when a session directive imposes a
stricter round bound, hitting that bound means stop and report — never claim clearance. Exact-head CI is
required before the owner gate. The agent stops at merge, deploy, production, migration, notification,
money-movement, and legacy-deletion gates. It never turns this programme into one giant rewrite prompt.
