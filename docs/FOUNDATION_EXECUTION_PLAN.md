# Foundation execution plan

**Status:** U1a authorized by owner 2026-08-07 (additive canonical membership foundation + read-only migration inventory only); every other unit remains proposed and gated. OD-07/OD-08 stay open and must not be decided inside U1a  
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
**Work:** resolve remaining OD-07–OD-08 (not a U1a prerequisite — the owner keeps both open as of 2026-08-07;
they gate U3 and U7 respectively); reconcile stale canonical status; freeze entity/state/permission vocabulary;
capture schema/function/grant/reference inventory at exact main SHA.

**Acceptance:** owner signs the decision ledger; no conflicting canonical statement remains unclassified; inventory
scripts are read-only and reproducible. **Rollback:** documentation revert. **Owner gate:** approve blueprint and U1.

### U1 — Additive Player membership contract (split U1a / U1b)

**Depends on:** accepted OD-02/OD-03 only — explicitly not OD-07/OD-08, which stay open and must not be
decided in this unit.

#### U1a — membership foundation + migration inventory (AUTHORIZED by owner 2026-08-07)

**Work:** add the canonical `academy_player_memberships` skeleton with exactly this DDL: `id uuid PRIMARY
KEY DEFAULT gen_random_uuid()`; `academy_profile_id uuid NOT NULL` FK → `academy_profiles(id)`;
`person_id uuid NOT NULL` FK → `persons(id)` — both FKs with preservation-safe actions
(`RESTRICT`/`NO ACTION`; never cascading deletion of membership evidence or Player history; the final
action is fixed in the U1a design review) — `UNIQUE (academy_profile_id, person_id)` (both columns NOT
NULL, so the uniqueness cannot be defeated by NULL pairs); `created_at`/`updated_at` `timestamptz NOT NULL
DEFAULT now()`, with `updated_at` maintained by the standard `update_updated_at_column()` trigger. Nothing
else in U1a: no notes/status/tags/trainer-assignment/settings/billing columns (those arrive only with
later reviewed slices). RLS enabled default-deny from creation (zero policies plus named-role REVOKEs,
including the service-role table lockdown idiom). Plus a read-only, reproducible inventory/rehearsal
artifact over the legacy relationship sources — `academy_player_metadata`, `academy_player_locations`, and
the academy-/trainer-owned `guest_players` rows, resolved exclusively through existing `person_links`
(eligibility is never derived from email/phone/contact inference) — reporting: totals; rows missing
`person_id`; duplicate `(academy, person)` groups; field conflicts (notes, tags, billing email, removal
state, trainer assignment, preferred location); orphaned references; cross-tenant trainer/location
anomalies; rows deterministically eligible for later backfill; per-academy reconciliation counts — with
split-frozen guests, email-auto-merged (`auto_merged_email_pair`) links, and trainer-owned
(`trainer_profile_id`) metadata rows each reported as their own class and marked unresolved/ineligible,
never silently folded into eligible counts. No read or write switch, no backfill, no dual-write, no legacy
modification.

**Acceptance/tests:** the additive migration applies from the real chain; existing tables/rows untouched;
duplicate `(academy, person)` rejected; NULL keys rejected (both columns NOT NULL); invalid references
rejected; authenticated tenants denied by default; the new table has zero `pg_policies` rows and no direct
table privileges for `PUBLIC`/`anon`/`authenticated`/`service_role` (named-role REVOKEs verified); two
academies relate to one Player independently without seeing each other's relationship;
inventory deterministic and mutation-free; migration reset/types drift green. **Rollback:** drop the unused
additive objects. **Gate:** owner approves the production additive migration separately.

**Status:** authorized 2026-08-07; the documentation checkpoint completed three independent Codex review
rounds WITHOUT clearance (round-3 findings remain open — recorded in the owner report of 2026-08-07);
implementation not started.

#### U1b — legacy mapping + backfill rehearsal (NOT authorized)

**Work:** define the deterministic mapping from every academy metadata/guest/profile record; add drift and
cross-tenant anomaly reports as durable artifacts; checkpointed, resumable backfill rehearsal.

**Acceptance/tests:** backfill rehearsal reports deterministic counts, orphans, duplicates, and
checkpoints; reconciliation stable across reruns. **Rollback:** stop writes/drop only unused additive
objects. **Gate:** owner authorizes U1b explicitly; the production backfill is a separate later gate.

#### U1c — production membership backfill execution (NOT authorized)

**Work:** execute the U1b-rehearsed deterministic backfill against production data with resumable
checkpoints, before/after counts by academy, and reconciliation reports; no notifications, no provider
calls, no legacy modification beyond the additive membership writes.

**Acceptance/tests:** reconciliation counts match the U1b rehearsal predictions; re-running changes no
rows; unresolved classes (split-frozen, auto-merged-pair, trainer-owned) remain untouched and reported.
**Rollback:** the backfill is additive — truncate/delete only the backfilled membership rows.
**Gate:** explicit owner approval; must be complete before any reader/writer switch (U3+) that depends on
complete membership data.

### U2 — Player claim and identity writer convergence

**Depends on:** U1a; reconfirm D-07 (recorded direction, no dated record) at unit start; the B2
nonconformance recorded in `FOUNDATION_DECISIONS.md` must be owner-resolved in or before this unit.  
**Work:** one idempotent server command for academy-created Player and later account claim; route bounded creation/linking
flows through canonical person/membership writes while maintaining compatibility projections.

**Acceptance/tests:** same Player UUID before/after signup; replay stable; email/phone signals alone never merge
(the shipped unique-pair B2 auto-merge is recorded nonconformance to D-04 — its remediation must be
owner-authorized in or before this unit); existing merge command remains sole duplicate resolution; failure
injection leaves no partial auth/person link; no notification backfill. **Rollback:** switch callers back while dual-write remains. **Gate:** owner approves auth-flow rollout.

### U3 — Read migration and tenant/capability foundation

**Depends on:** U2, OD-04/05/07; U1c (executed membership backfill) for any reader that depends on
complete membership data; reconfirm D-07 if not already reconfirmed at U2.  
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
