# Foundation architecture audit — August 2026

**Status:** Owner review completed 2026-08-07 — accepted decisions recorded in `FOUNDATION_DECISIONS.md`; first authorized slice is U1a (`FOUNDATION_EXECUTION_PLAN.md`)  
**Audited head:** `ea54f08b3a204a4ed29c3d37976d51ed2d841ad6` (`main`, 2026-08-07)  
**Scope:** A1–A7, read-only inspection of application code, migrations, tests, and canonical docs  
**Non-scope:** production access, migrations, notification sends, deployment, data mutation, or implementation

## Executive result

The platform has sound foundations to evolve rather than rewrite: UUID primary keys, Supabase/Postgres
RLS, a canonical `persons` identity map, database-owned capacity guards, guarded financial records,
paginated invoice/player readers, reusable UI primitives, and the frozen notification foundation. It is
not yet ready to claim a simple 100,000-player architecture. Four load-bearing seams remain:

1. canonical identity is additive but the legacy `profiles`/`guest_players` world is still active;
2. cycle edits and several planning operations are multi-step client orchestration rather than one atomic command;
3. academy-to-trainer authority has no granular relationship permission model;
4. billing/recovery and some high-volume UI reads remain operationally or client-side oriented.

The recommended direction is an incremental expand → validate → backfill → dual-read/write → switch →
owner-gated contract programme. No rewrite or early table deletion is justified.

## Method and evidence rules

- Historical audits were used only as leads. Findings below were reproduced on the audited head.
- “Confirmed” means the cited current code/schema still exhibits the condition.
- “Already fixed” means the older condition is contradicted by current code or tests.
- “Stale documentation” means a canonical-looking document describes a superseded state.
- Recommendations are proposals, not accepted decisions.

## Verified findings

| ID | Sev | Area | State | Current evidence | Risk and testable correction |
|---|---|---|---|---|---|
| A1-01 | P1 | Canonical Player | **Confirmed** | `persons` and `person_links` were added in `20260826260000_persons_expand.sql`, but `PERSON_UNIFICATION_PLAN.md` §5 Phase 4 (CONTRACT) still leaves physical contraction open. Current search finds 270 TS/TSX files in `src` and edge functions referencing `guest_players` or `guest_player_id`. | Two identity worlds keep authorization, deduplication, and money paths harder to prove. Complete reader/writer conversion in bounded slices; retain deterministic mappings and compatibility columns until reconciliations are zero. |
| A1-02 | P1 | Academy membership | **Confirmed / owner direction supplied** | `academy_player_metadata` remains keyed by legacy profile/guest references with a derived person stamp; `DOMAIN_MODEL.md` describes this as transitional. | Academy-private data needs one durable `(academy_id, person_id)` owner. Expand to a canonical membership relation, backfill deterministically, prove no cross-tenant collisions, then switch reads. |
| A1-03 | P2 | Scoped player lookup | **Confirmed** | `get_player_locations` in `20260906100000_phase35d_small_readers_person.sql:115-215` accepts caller-supplied profile/guest IDs and resolves them before proving the clicked reference belongs to the academy. Later expansion is academy-scoped, limiting but not eliminating membership inference. | Derive references from an academy-scoped subject identifier or reject foreign refs first. Add two-tenant tests with a shared location and direct foreign profile/guest arguments. |
| A1-04 | P2 | Account attachment | **Partially fixed** | Person links, twin precedence, split-freeze, and signup linking exist and are tested. Active code still creates/reads guest twins and uses compatibility heuristics. | Registration must attach credentials to the existing person without changing its UUID. Add an explicit idempotent claim command keyed by reviewed evidence; never merge on email/phone alone. |
| A2-01 | P1 | Trainer permissions | **Confirmed** | `academy_trainers` has relationship/status/payment/display fields but no capability grants. Current migrations only expose broad helpers such as `can_manage_slot`; search finds no relationship permission model. | Introduce server-enforced capabilities with planning/registration management off by default, audit every grant change, and test each role × tenant × capability combination. |
| A2-02 | P2 | Trainer identity ownership | **Already fixed, residual UX** | `20261109100000_identity_is_self_service.sql` and `identitySelfService.pglite.test.ts` prevent academy managers changing global trainer identity. `A1_A7_TRIAGE.md` records that trainer creation endpoints still return temporary passwords and edit UIs still submit forbidden global fields. | Replace temporary-password ownership with invitation/account-claim flows and make UI fields accurately reflect tenant-owned versus trainer-owned data. |
| A2-03 | P2 | Clubs/locations boundary | **Owner decision — resolved 2026-08-07** | Current canonical docs model clubs as a separate manager role, while some academy flows carry location ownership assumptions. | Clubs/venues remain independent. Model academy↔venue as many-to-many “trains at”; academy managers edit only association data and club managers alone edit venue details. Only the confirmation workflow/dispute mechanics remain detailed design; the venue-confirmation requirement itself is settled (OD-04). |
| A3-01 | P1 | Planning boundary | **Confirmed** | Registration, intake, proposal, and cycle modules exist, but orchestration is spread across `cycles.ts`, `cycleProposal*`, pages, and `finalize_cycle_proposals`. Calendar pages still contain mutations. | Make Planning the command workspace and Calendar a bounded read model. Publication must be one idempotent server command producing auditable sessions/bookings and an impact preview. |
| A3-02 | P2 | Proposal lifecycle | **Confirmed** | `proposed_assignments` and `finalize_cycle_proposals` exist, but no single documented state machine defines draft/reviewed/published/withdrawn and replay semantics across the UI and DB. | Add explicit planning-publication states, revision IDs, idempotency keys, preview hashes, and concurrency tests for double publish/stale review. |
| A4-01 | P1 | Cycle editing atomicity | **Confirmed** | `TrainerScheduleOverview.tsx:528-805` updates slots, inserts sessions/bookings, mutates cycle settings, resyncs invoices, invokes invoice splitting, swallows some failures, and then reports success. | Replace with a server-owned transaction that accepts explicit scope, locks affected rows, previews impact, updates sessions/bookings/unpaid invoices, emits after-commit work, and rolls back on injected failure at every stage. |
| A4-02 | P2 | Capacity | **Partially fixed** | Current `enforce_booking_slot_tier` revisions use slot-keyed transaction advisory locking for authenticated writers, and the public/guest booking RPCs repeat the lock/count guard; but the trigger returns early for service-role writers and `finalize_cycle_proposals` (service-role-only, `20260701120000`) inserts bookings with no capacity lock or recount — an uncovered capacity path. | Preserve the shared Postgres capacity contract — the authenticated-path trigger plus the identical lock/count guard in the service-role booking RPCs — as the sole backstop, and close the `finalize_cycle_proposals` gap with the same guard in a separately authorized fix. Add real concurrent tests for each future booking command and never rely on a client count. |
| A4-03 | P2 | Change scope | **Confirmed product gap** | Existing edit flows encode page-specific choices; no shared command contract always asks “this session / future sessions / whole cycle” and previews bookings, money, and notifications. | Introduce an immutable impact preview token and require the command to echo the selected scope and preview revision. Reject stale previews. |
| A5-01 | P1 | Billing party | **Confirmed** | Identity records contain billing/company fields and invoices point directly at legacy player identities; there is no first-class billing-party/profile snapshot model. | Add player-owned billing profiles and immutable invoice party snapshots. A company is a billing party, never a Player. Backfill without altering issued invoice evidence. |
| A5-02 | P1 | Financial state machines | **Partially fixed** | Paid invoice guards, deduped creation, webhook idempotency, refund/chargeback handling, and audit logging exist, and booking/invoice transitions are already captured in trigger-owned transition records (append-only `booking_lifecycle_events`; trigger-populated `invoice_status_history`, which cascades with its invoice and permits reason annotation; payment events in `payment_audit_log`). Allowed transitions are not enforced server-side and no single canonical state-machine contract spans booking/invoice/payment. | Document and enforce allowed transitions server-side over the existing ledgers; preserve provider events separately; make refunds/reconciliation explicit idempotent commands. |
| A5-03 | P2 | Payment adapters | **Confirmed** | Mollie logic is distributed across multiple edge functions and shared helpers. Stripe code is the separate, active platform-subscription rail (platform→trainer/academy/club; it must be preserved); neither provider sits behind a uniform interface and capability matrix. | Define a provider adapter around create/get/cancel/refund/webhook-verify with frozen request IDs and normalized outcomes. Keep manual invoicing as a separate adapter/method. |
| A5-04 | P2 | Recovery tooling | **Confirmed** | `payments/PAYMENT_OPERATOR_TOOL_GAPS.md:3-18` records routine recovery that still needs raw SQL, Mollie dashboard work, or direct function calls. | Build read-first admin reconciliation, scoped verification, and audited one-entity recovery. Refund execution remains a separate owner and permission gate. |
| A6-01 | P2 | Frontend boundaries | **Confirmed** | Shared primitives and role-isolation lint are strong, but current largest files include `CycleForm` (2,523 lines), `ProposalScheduleGrid` (1,967), `TrainerScheduleOverview` (1,833), and `AcademyCyclusOverview` (1,680). The shrink-only mutation-boundary allowlist still freezes 34 direct high-risk table writes across 25 files in pages/components (live static scan: 29 across 21). | Split by domain workflow, not cosmetic fragments: thin role pages, neutral command hooks/components, and server-owned mutations. Add guards that prevent new direct writes. |
| A6-02 | P2 | Scale reads | **Confirmed** | Pagination infrastructure is present, but canonical backlogs and current code still contain broad list reads and client aggregation/fallback paths (agenda, dashboards, cycle overview, earnings). | Require keyset pagination for growing lists, bounded date windows for agenda/calendar, server aggregates, explicit maximums, and telemetry when compatibility fallbacks run. |
| A6-03 | P2 | Accessibility/usability | **Partially fixed** | UI standards, shared tables, empty/loading states, and date controls exist. Complex planning grids and long forms remain high-risk for keyboard, screen-reader, and non-technical use. | Each release unit needs keyboard/focus/error-summary tests plus task-based usability acceptance; do not create a giant universal component. |
| A7-01 | P1 | Tenant authorization | **Confirmed programme gap** | RLS and SECURITY DEFINER tests are extensive, but identity compatibility and future capability work span many policies/functions. | Centralize tenant/capability predicates, minimize DEFINER grants, test with real JWT claims and two tenants, and add an automated function/grant inventory. |
| A7-02 | P2 | DR and privileged access | **Confirmed** | Canonical recovery docs state that exports are not full backups and a restore drill is not proven. No application-level AAL2 gate was found for privileged operations. | Owner-gated disposable restore drill with RPO/RTO evidence; require or explicitly risk-accept MFA/step-up for platform admin and high-risk academy actions. |
| A7-03 | P2 | Canonical documentation drift | **Confirmed** (living docs corrected in the 2026-08-07 checkpoint; cited line refs are as of the audited head) | `FOUNDATION_ROADMAP.md:173-176` says audits must not start and `:328-330` says N0 production smoke is outstanding, while the owner has confirmed completion and current main includes #637–#639. `PERSON_UNIFICATION_PLAN.md` also carries dated phase/PR status. | Reconcile canonical status after owner approval; mark history as history instead of deleting it. Add “verified at SHA/date” headers. |
| A7-04 | P2 | Scale verification | **Confirmed** | Strong unit/PGlite coverage exists, but no single gate proves 100k-person pagination, high-volume academy windows, concurrent publish/edit/book, and financial reconciliation together. | Add synthetic scale fixtures and real Postgres concurrency suites with explicit latency/query-count budgets before contraction. |

## Stale findings not reopened

- General “bookings can overbook because there is no lock” claims are stale; the database guard locks.
- General “paid invoices can be deleted/overwritten” claims are stale; current guards and
  `deleteOrCancelInvoices` refuse paid rows and re-check status at write time.
- “Mollie refunds/chargebacks are ignored” is stale on this head.
- “Academy managers can edit a shared trainer’s login identity” is stale after the self-service guard.
- The earlier DST extension defect is fixed by `planWeeklySessionsAfter`; atomic cycle editing remains open.

## Positive evidence to preserve

- Stable UUIDs and an additive canonical person map.
- Database-owned capacity enforcement and expiring payment holds.
- Protected paid records, deduped invoice creation, provider webhook guards, and payment audit data.
- Server-paginated player/invoice surfaces and shared paging primitives.
- Role-isolation lint, neutral component folders, shared tables/forms, and shrink-only lint baselines.
- Notification activation boundary, no-backlog controls, kill/recovery paths, and operational visibility.

## Audit conclusion

Proceed with the blueprint as a sequence of bounded releases. The first implementation unit should be
an additive identity/membership contract and inventory—not destructive contraction—and only after the
ownership decisions that gate that unit are approved (OD-02/OD-03 suffice for the first additive slice;
OD-07/OD-08 gate later units — see `FOUNDATION_EXECUTION_PLAN.md`).
