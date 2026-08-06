# Documentation Index

The canonical map of all padeltrainer documentation and the single entry point for anyone — AI agent or human — making changes to this codebase.

Audience / AI-read: yes
Status: canonical (source of truth) | last updated 2026-07-18

---

## START HERE (AI source of truth)

If you are an AI agent (Claude / Codex) or a new human contributor, read these **in order** before touching money, data, or shared components. Everything below this section is either supporting detail, historical evidence, or backlog.

| # | Doc | Read it to learn |
|---|---|---|
| 0 | [AI_DEVELOPMENT_GUIDE.md](AI_DEVELOPMENT_GUIDE.md) | How to work in this repo safely: what to read, what to never do, the change playbook. START HERE. |
| 1 | [DOMAIN_MODEL.md](DOMAIN_MODEL.md) | The 14 domains, their tables, and write boundaries. |
| 2 | [ARCHITECTURE_BOUNDARIES.md](ARCHITECTURE_BOUNDARIES.md) | Frontend/backend/edge/DB layering + role-isolation rules. |
| 3 | [MUTATION_BOUNDARIES.md](MUTATION_BOUNDARIES.md) | Every dangerous domain write + the allowlisted facade that owns it. |
| 4 | [INVARIANTS.md](INVARIANTS.md) | App-wide hard rules that must never break, and how they're enforced. |
| 5 | [COMPONENT_PATTERN_REGISTRY.md](COMPONENT_PATTERN_REGISTRY.md) | "Which component do I use for X?" lookup before building new UI. |
| 6 | [TESTING_STRATEGY.md](TESTING_STRATEGY.md) | Which tests are required for each kind of change. |
| 7 | [PERFORMANCE_QUERY_RULES.md](PERFORMANCE_QUERY_RULES.md) | Read/query rules for scale (paging, indexes, N+1). |
| 8 | [OBSERVABILITY_AND_RECOVERY.md](OBSERVABILITY_AND_RECOVERY.md) | How failures surface (Slack alerts) and how to recover. |
| 9 | [QUALITY_GATES.md](QUALITY_GATES.md) | The exact CI gates and what each one actually checks. |
| 10 | [FOUNDATION_ROADMAP.md](FOUNDATION_ROADMAP.md) | The go-forward plan and what's still open. |

Supporting canonical directories:

- [adr/](adr/) — Architecture Decision Records (the "why" behind the core model).
- [payments/](payments/) — the money-path bible (flow map, invariants, reconciliation, recovery).
- [deployment/](deployment/) — how edge functions and migrations reach prod safely.
- [technical-debt/](technical-debt/) — the prioritized backlogs feeding the roadmap.

> **Naming note:** A few canonical docs are referenced above under target names that consolidate existing content: `AI_DEVELOPMENT_GUIDE` (extends [AGENTS.md](../AGENTS.md) + [EXTENDING_THE_DOMAIN.md](EXTENDING_THE_DOMAIN.md)), `ARCHITECTURE_BOUNDARIES` ([FRONTEND_ARCHITECTURE.md](FRONTEND_ARCHITECTURE.md) + backend layering), and `FOUNDATION_ROADMAP`. Where a target file does not yet exist on disk, use the linked existing doc(s); sibling foundation work is consolidating these.

---

## Current state (2026-07-02)

- **Audit of record:** [audits/FULL_AUDIT_FRESH_EYES_2026-07-02.md](audits/FULL_AUDIT_FRESH_EYES_2026-07-02.md) — 2 P0, 9 P1, 16 P2, 11 P3.
- **Fixed + deployed to prod:** the P0 (forged-JWT service-role bypass) and P1-2 (swap_slots guard), P1-3 (merge_guest_players data-loss), P1-4 (M-17 webhook collision), P1-5/P2-7 (extras charge/invoice), P1-6 (invoice dedup RPC `create_invoice_deduped`), P1-7 (invoiceSync paging → new [src/lib/supabasePaging.ts](../src/lib/supabasePaging.ts)), P1-9 (academy-Mollie routing).
- **Still open:** P1-1 (Google Calendar OAuth, parked), P1-8 (Stripe basil, disputed), and the P2 cluster.
- **Any older audit that lists the forged-JWT P0 or P1-2..P1-9 as OPEN is STALE.** Only the fresh-eyes audit + the open items above are actionable.

---

## Full documentation classification

Legend — **Class:** `CC` canonical-current (source of truth) · `UNU` useful-needs-update · `HAO` historical-audit-only (keep as evidence) · `OA` obsolete-archive · `DC` duplicate-conflicting. **AI:** should an AI agent read it by default.

### Root `*.md`

| Doc | Class | Purpose | Audience | AI | Current? | Superseded / next step |
|---|---|---|---|---|---|---|
| [../README.md](../README.md) | UNU | Project intro — still the default Lovable scaffold with a placeholder URL | new devs | yes | NO (stale scaffold) | Rewrite as real repo entry point |
| [../AGENTS.md](../AGENTS.md) | CC | Short AI/human guide; points into `docs/` | AI+human | yes | yes | — |
| [../DEPLOYMENT_GUIDE.md](../DEPLOYMENT_GUIDE.md) | CC | Non-technical founder ops guide (Cloudflare→Vercel→Supabase, rollback) | owner | partial | yes | Complements [deployment/EDGE_FUNCTION_DEPLOY_SAFETY.md](deployment/EDGE_FUNCTION_DEPLOY_SAFETY.md) |
| [../TEST_RUNBOOK.md](../TEST_RUNBOOK.md) | CC | Manual prod QA checklist | owner | no | yes | — |
| [../TEST_BASELINE.md](../TEST_BASELINE.md) | HAO | Point-in-time vitest snapshot (pre-QA) | dev | no | NO | [TEST_COVERAGE_GAPS.md](TEST_COVERAGE_GAPS.md) |
| [../DATA_INTEGRITY_AUDIT.md](../DATA_INTEGRITY_AUDIT.md) | HAO | 2026-06-03 read-only prod data-integrity audit | dev/owner | ref | dated | [DATA_HEALTH_CHECKS.md](DATA_HEALTH_CHECKS.md) + `audits/` |
| [../MIGRATION_STABILIZATION.md](../MIGRATION_STABILIZATION.md) | UNU | Lovable→independent cutover checklist | owner | no | mostly done | Archive once cutover fully closed |
| [../lessons-learned.md](../lessons-learned.md) | UNU | Test-automation quirks; some stale `lovable.app` URLs | test-automation | partial | partial | — |
| [../test-summary.md](archive/test-summary.md) | OA | Abandoned "Lisa Loops" run report (8/45) | — | no | NO | Archive |
| [../testability-report.md](archive/testability-report.md) | OA | Lisa Loops Stage-0 setup; `lovable.app` URLs | — | no | NO | Archive |

### `docs/` top-level

| Doc | Class | Purpose | AI | Current? | Superseded / next step |
|---|---|---|---|---|---|
| **DOCUMENTATION_INDEX.md** (this file) | CC | The map + entry point | yes | yes | — |
| [DOMAIN_MODEL.md](DOMAIN_MODEL.md) | CC | 14-domain map + write boundaries | yes | yes | — |
| [MUTATION_BOUNDARIES.md](MUTATION_BOUNDARIES.md) | CC | Dangerous writes + allowlist | yes | yes | — |
| [INVARIANTS.md](INVARIANTS.md) | CC | App-wide hard rules + enforcement | yes | yes | — |
| [COMPONENT_PATTERN_REGISTRY.md](COMPONENT_PATTERN_REGISTRY.md) | CC | "Which component for X" lookup | yes | yes | — |
| [PERFORMANCE_QUERY_RULES.md](PERFORMANCE_QUERY_RULES.md) | CC | Read/query rules for scale | yes | yes | — |
| [PUBLIC_DIRECTORY_RPC_PATTERN.md](PUBLIC_DIRECTORY_RPC_PATTERN.md) | CC | Recipe for converting an unbounded public "browse + filter" page to a bounded server-side RPC (worked example: `/trainers`) | yes | yes | Apply-elsewhere checklist + parked candidates (city/province directory) |
| [NOTIFICATION_FOUNDATION.md](NOTIFICATION_FOUNDATION.md) | CC | **The notification foundation as built** — ownership boundaries, event catalogue, instant vs digest, the precedence that decides a send, idempotency + provider ambiguity, the no-backlog activation boundary, every state machine, tenant/PII boundaries, how to add an event or a provider | yes | yes | CANONICAL. Read this before touching any notification/email send path. Drift-pinned by `src/test/notificationFoundationDocs.test.ts` |
| [NOTIFICATION_OPERATIONS.md](NOTIFICATION_OPERATIONS.md) | CC | **Running it** — what the admin page tells you, stopping a send, reading the monitors, diagnosing without exposing recipients, every recovery procedure and what refuses it, the owner-gated rollout sequence, rollback, and what "deployed inert" means | yes | yes | CANONICAL for operations. Drift-pinned by the same test |
| [NOTIFICATION_ARCHITECTURE.md](NOTIFICATION_ARCHITECTURE.md) | CC | Notification pipeline rebuild — the 2026-07 current-state audit, reconciliation decisions and PR sequence | yes | no | HISTORICAL design record, superseded by NOTIFICATION_FOUNDATION.md |
| [TESTING_STRATEGY.md](TESTING_STRATEGY.md) | CC | Required tests by change type | yes | yes | — |
| [TEST_COVERAGE_GAPS.md](TEST_COVERAGE_GAPS.md) | CC | Honest coverage map | yes | yes | — |
| [QUALITY_GATES.md](QUALITY_GATES.md) | CC | CI/gate map | yes | yes | Links to [technical-debt/QUALITY_GATES_BACKLOG.md](technical-debt/QUALITY_GATES_BACKLOG.md) |
| [OBSERVABILITY_AND_RECOVERY.md](OBSERVABILITY_AND_RECOVERY.md) | CC | Operational index | yes | yes | Links to [technical-debt/OBSERVABILITY_BACKLOG.md](technical-debt/OBSERVABILITY_BACKLOG.md) |
| [EXTENDING_THE_DOMAIN.md](EXTENDING_THE_DOMAIN.md) | CC | Playbook for changing money/data core | yes | yes | — |
| [FRONTEND_ARCHITECTURE.md](FRONTEND_ARCHITECTURE.md) | CC | FE org + role-isolation lint rule | yes | yes | — |
| [UI_COMPONENT_STANDARDS.md](UI_COMPONENT_STANDARDS.md) | CC | Shared-component rules (invoice-form worked example) | yes | yes | — |
| [LINTING.md](LINTING.md) | CC | Shrink-only eslint baseline mechanics | yes | yes | — |
| [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) | CC | Marketing visual tokens (source of truth, `/brand` mirror) | partial | yes | — |
| [DATA_HEALTH_CHECKS.md](DATA_HEALTH_CHECKS.md) | UNU | Read-only slots/cycles health SQL | ref | mostly historical | Cleanup shipped (see CYCLE_SERIES_SPLIT) |
| [CYCLE_SERIES_SPLIT_RUNBOOK.md](archive/CYCLE_SERIES_SPLIT_RUNBOOK.md) | OA | One-time mega-cycle split (APPLIED to prod 2026-06-29) | no | done | Archive |
| [SCHEDULING_ARCHITECTURE.md](SCHEDULING_ARCHITECTURE.md) | UNU | Academy-first scheduling strategy note | yes | partial | Overlaps [DOMAIN_MODEL.md](DOMAIN_MODEL.md) |
| [SHORT_LINKS.md](SHORT_LINKS.md) | CC | Branded `/s/<code>` short-link primitive (schema, worker, seams, invariants) | yes | yes | Distinct from `/t/` `/a/` profile slugs |
| [PERSON_UNIFICATION_PLAN.md](PERSON_UNIFICATION_PLAN.md) | CC | **Person-unification program tracker** — one `persons` table over `profiles`+`guest_players` (`person_links` map, FAM-02, split-freeze), strangler-phased; phases 1–3.4 shipped, Phase 4 contract pending | yes | yes | Canonical model summarized in [DOMAIN_MODEL.md](DOMAIN_MODEL.md) §5 |
| [../src/lib/personIdentity.ts](../src/lib/personIdentity.ts) | CC | Code-as-doc: **the single TS home of the FAM-02 person rule** (person key, XOR ref, booking match scope, display name) — read it before touching any `player_id`/`guest_player_id` logic | yes | yes | SQL surfaces encode the same rule inline; keep in sync |
| [COMPONENT_REUSE_AUDIT.md](COMPONENT_REUSE_AUDIT.md) | HAO | 2026-06-30 reuse audit + plan | ref | plan | [technical-debt/COMPONENT_REUSE_BACKLOG.md](technical-debt/COMPONENT_REUSE_BACKLOG.md) |
| [EDGE_FUNCTIONS_FICWB_AUDIT.md](EDGE_FUNCTIONS_FICWB_AUDIT.md) | HAO | 2026-05-31 edge-fn deploy-status audit | ref | dated | — |
| [FICWB_SECRETS_AUDIT.md](FICWB_SECRETS_AUDIT.md) | HAO | 2026-06-02 edge secrets audit | ref | dated | — |
| [P0_PR1_PR4_NOTES.md](P0_PR1_PR4_NOTES.md) | HAO | P0 hardening PR-1..4 deploy notes | no | historical | — |
| [PUBLIC_BOOKING_WIDGET_PLAN.md](PUBLIC_BOOKING_WIDGET_PLAN.md) | UNU | Not-started feature plan (audited 2026-07-01) | ref | plan (not built; re-base on persons first) | — |
| [PHASE2_REGISTRATIONS_SPLIT.md](archive/PHASE2_REGISTRATIONS_SPLIT.md) | OA | Phase-2 migration spec (shipped) | no | done | [adr/0001](adr/0001-registrations-cycles-split.md) · Archive |
| [PHASE2_STEP3_RUNBOOK.md](archive/PHASE2_STEP3_RUNBOOK.md) | OA | One-time cutover backfill runbook | no | done | Archive |
| [PHASE4_CE_INTEGRITY_INDEX_RUNBOOK.md](archive/PHASE4_CE_INTEGRITY_INDEX_RUNBOOK.md) | OA | One-time FK+GIN owner runbook | no | done | Archive |
| [PHASE4_PLAN.md](archive/PHASE4_PLAN.md) | OA | Revised Phase-4 slice plan (shipped) | no | done | [adr/0001](adr/0001-registrations-cycles-split.md), [adr/0002](adr/0002-slot-is-price-source-of-truth.md) · Archive |
| [PHASE5_DEPLOYMENT.md](archive/PHASE5_DEPLOYMENT.md) | OA | Vercel preview deploy notes (cutover done) | no | done | [../DEPLOYMENT_GUIDE.md](../DEPLOYMENT_GUIDE.md) · Archive |
| [SHARED_TABLE_MIGRATION_PLAN.md](archive/SHARED_TABLE_MIGRATION_PLAN.md) | OA | Not-started shared-table plan (2026-06-30) | ref | plan (superseded) | Archive |
| [UI_AUDIT_SPRINT1.md](archive/UI_AUDIT_SPRINT1.md) | OA | 2026-05-30 visual audit sprint | no | done | [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) · Archive |
| [W06-DEDUPE-DRYRUN.md](archive/W06-DEDUPE-DRYRUN.md) | OA | Club-dedupe dry-run approval gate (2026-05-30) | no | done | Archive |
| [WAVE4-SCOPE.md](archive/WAVE4-SCOPE.md) | OA | Wave-4 scope/plan (2026-06-12) | no | done | Archive |
| [AUDIT-2026-06.md](archive/AUDIT-2026-06.md) | HAO | June-2026 consolidated pre-launch audit | ref | historical | [audits/FULL_AUDIT_FRESH_EYES_2026-07-02.md](audits/FULL_AUDIT_FRESH_EYES_2026-07-02.md) · Archive |

### `docs/adr/` — Architecture Decision Records (all CC, all Accepted)

| Doc | AI | Current? |
|---|---|---|
| [adr/README.md](adr/README.md) | yes | yes |
| [adr/0001-registrations-cycles-split.md](adr/0001-registrations-cycles-split.md) | yes | yes |
| [adr/0002-slot-is-price-source-of-truth.md](adr/0002-slot-is-price-source-of-truth.md) | yes | yes |
| [adr/0003-mutation-boundary-facades.md](adr/0003-mutation-boundary-facades.md) | yes | yes |
| [adr/0004-rebooking-priority-claims.md](adr/0004-rebooking-priority-claims.md) | yes | yes |

### `docs/technical-debt/` — prioritized backlogs (all CC)

| Doc | AI | Current? |
|---|---|---|
| [technical-debt/COMPONENT_REUSE_BACKLOG.md](technical-debt/COMPONENT_REUSE_BACKLOG.md) | yes | yes |
| [technical-debt/INVARIANT_BACKLOG.md](technical-debt/INVARIANT_BACKLOG.md) | yes | yes |
| [technical-debt/MUTATION_BOUNDARY_BACKLOG.md](technical-debt/MUTATION_BOUNDARY_BACKLOG.md) | yes | yes |
| [technical-debt/PERFORMANCE_BACKLOG.md](technical-debt/PERFORMANCE_BACKLOG.md) | yes | yes |
| [technical-debt/TEST_FIXTURE_BACKLOG.md](technical-debt/TEST_FIXTURE_BACKLOG.md) | yes | yes |
| [technical-debt/OBSERVABILITY_BACKLOG.md](technical-debt/OBSERVABILITY_BACKLOG.md) | yes | yes |
| [technical-debt/QUALITY_GATES_BACKLOG.md](technical-debt/QUALITY_GATES_BACKLOG.md) | yes | yes |

### `docs/deployment/` & `docs/payments/` (all CC)

| Doc | AI | Current? | Notes |
|---|---|---|---|
| [deployment/EDGE_FUNCTION_DEPLOY_SAFETY.md](deployment/EDGE_FUNCTION_DEPLOY_SAFETY.md) | yes | yes | Canonical deploy procedure |
| [payments/PAYMENT_FLOW_MAP.md](payments/PAYMENT_FLOW_MAP.md) | yes | yes | Money-flow map (file:line) |
| [payments/PAYMENT_INVARIANTS.md](payments/PAYMENT_INVARIANTS.md) | yes | yes | Money-path rules |
| [payments/PAYMENT_RECONCILIATION_PLAN.md](payments/PAYMENT_RECONCILIATION_PLAN.md) | yes | yes | Drift detection (`reconcile_payments` RPC) |
| [payments/PAYMENT_RECOVERY_RUNBOOK.md](payments/PAYMENT_RECOVERY_RUNBOOK.md) | owner | yes | Manual recovery |
| [payments/PAYMENT_OBSERVABILITY_AUDIT.md](payments/PAYMENT_OBSERVABILITY_AUDIT.md) | ref | yes | Telemetry map + gaps |
| [payments/PAYMENT_OPERATOR_TOOL_GAPS.md](payments/PAYMENT_OPERATOR_TOOL_GAPS.md) | ref | yes | Tools-not-built backlog |
| [payments/PAYMENT_TEST_GAPS.md](payments/PAYMENT_TEST_GAPS.md) | yes | yes | G1–G10 |
| [payments/PAYMENT_RELIABILITY_FOUNDATION_REPORT.md](payments/PAYMENT_RELIABILITY_FOUNDATION_REPORT.md) | ref | yes | Summary of the foundation build |

### `docs/audits/` — ALL historical-audit-only (KEEP as evidence; do NOT delete or archive)

These are the evidence trail behind the canonical docs. Read them only when you need the reasoning behind a rule. **The current audit of record is the first row.**

| Doc | Notes |
|---|---|
| [audits/FULL_AUDIT_FRESH_EYES_2026-07-02.md](audits/FULL_AUDIT_FRESH_EYES_2026-07-02.md) | **Current audit of record** — 2 P0, 9 P1, 16 P2, 11 P3 |
| [audits/FULL_APP_SCALE_READINESS_AUDIT_2026-06-29.md](audits/FULL_APP_SCALE_READINESS_AUDIT_2026-06-29.md) | Scale audit |
| [audits/CORE_BOOKING_DOMAIN_HARDENING_AUDIT.md](audits/CORE_BOOKING_DOMAIN_HARDENING_AUDIT.md) | Booking-domain invariant audit |
| [audits/FRONTEND_COMPONENT_ARCHITECTURE_AUDIT.md](audits/FRONTEND_COMPONENT_ARCHITECTURE_AUDIT.md) | FE maintainability audit |
| [audits/INDEPENDENT_ARCHITECTURE_SCALABILITY_AUDIT_2026-06-28.md](audits/INDEPENDENT_ARCHITECTURE_SCALABILITY_AUDIT_2026-06-28.md) | Independent audit |
| [audits/INDEPENDENT_AUDIT_WORKLOG.md](audits/INDEPENDENT_AUDIT_WORKLOG.md) | Worklog |
| [audits/MUTATION_BOUNDARY_AUDIT.md](audits/MUTATION_BOUNDARY_AUDIT.md) | Codex Finding 3; superseded map by [MUTATION_BOUNDARIES.md](MUTATION_BOUNDARIES.md) |
| [audits/OBSERVABILITY_AND_ALERTING_AUDIT.md](audits/OBSERVABILITY_AND_ALERTING_AUDIT.md) | Gap analysis behind [OBSERVABILITY_AND_RECOVERY.md](OBSERVABILITY_AND_RECOVERY.md) |
| [audits/PERFORMANCE_INDEX_AUDIT.md](audits/PERFORMANCE_INDEX_AUDIT.md) | Index audit behind [PERFORMANCE_QUERY_RULES.md](PERFORMANCE_QUERY_RULES.md) |
| [audits/PRODUCTION_RELEASE_LEDGER_2026-06-29.md](audits/PRODUCTION_RELEASE_LEDGER_2026-06-29.md) | Inferred deploy-state ledger |
| [audits/DECOMPOSITION_DEDUP_ROADMAP.md](audits/DECOMPOSITION_DEDUP_ROADMAP.md) | God-component roadmap (plan) |
| [audits/DEPENDENCY_SECURITY_2026-06-28.md](audits/DEPENDENCY_SECURITY_2026-06-28.md) | Dependency-audit pass |
| [audits/TSO_INVOICE_WRITES_AUDIT.md](audits/TSO_INVOICE_WRITES_AUDIT.md) | Narrow deferred-P2 audit |
| [audits/CODEX_FOUNDATION_VERIFICATION_FOR_CLAUDE.md](audits/CODEX_FOUNDATION_VERIFICATION_FOR_CLAUDE.md) | Codex handoff |
| [audits/FOUNDATION_VERIFICATION_WORKLOG.md](audits/FOUNDATION_VERIFICATION_WORKLOG.md) | Worklog |
| [audits/CODEX_BOOKING_REBOOKING_AUDIT_BRIEF.md](audits/CODEX_BOOKING_REBOOKING_AUDIT_BRIEF.md) | Audit brief (starting map) |
| [audits/CODEX_PLAYER_REBOOK_AUDIT_BRIEF.md](audits/CODEX_PLAYER_REBOOK_AUDIT_BRIEF.md) | Audit brief |
| [audits/CODEX_SLICE_A_NOLOGIN_REBOOK_PAYMENT_REVIEW_FOR_CLAUDE.md](audits/CODEX_SLICE_A_NOLOGIN_REBOOK_PAYMENT_REVIEW_FOR_CLAUDE.md) | Codex review of #311 |
| [audits/SLICE_A_NOLOGIN_REBOOK_PAYMENT_DESIGN.md](audits/SLICE_A_NOLOGIN_REBOOK_PAYMENT_DESIGN.md) | Design doc (built) |

---

## Archived / historical

These docs describe one-time work that has **shipped** (migrations applied, cutovers closed, sprints done). They are kept for context only and should **not** be followed as instructions. The orchestrator moves the `OA` rows into `docs/archive/` (they are marked historical in place until then). **Nothing under `docs/audits/` is ever archived** — audits are permanent evidence.

To be archived under `docs/archive/`:

- `docs/archive/PHASE2_REGISTRATIONS_SPLIT.md`, `docs/archive/PHASE2_STEP3_RUNBOOK.md`
- `docs/archive/PHASE4_PLAN.md`, `docs/archive/PHASE4_CE_INTEGRITY_INDEX_RUNBOOK.md`
- `docs/archive/PHASE5_DEPLOYMENT.md`
- `docs/archive/CYCLE_SERIES_SPLIT_RUNBOOK.md`
- `docs/archive/SHARED_TABLE_MIGRATION_PLAN.md`
- `docs/archive/UI_AUDIT_SPRINT1.md`
- `docs/archive/W06-DEDUPE-DRYRUN.md`
- `docs/archive/WAVE4-SCOPE.md`
- `docs/archive/test-summary.md`, `docs/archive/testability-report.md`
- `docs/archive/AUDIT-2026-06.md` (moved 2026-07-18)
- `docs/archive/REBOOK_LINKED_GUEST_BACKFILL.sql` (one-time backfill, executed; moved 2026-07-18 — do not rerun)

**Superseded, keep in place (historical/needs-update):** `README.md` (rewrite pending), `MIGRATION_STABILIZATION.md`, `lessons-learned.md`, `TEST_BASELINE.md`, `DATA_INTEGRITY_AUDIT.md`, `docs/DATA_HEALTH_CHECKS.md`, `docs/EDGE_FUNCTIONS_FICWB_AUDIT.md`, `docs/FICWB_SECRETS_AUDIT.md`, `docs/P0_PR1_PR4_NOTES.md`, `docs/SCHEDULING_ARCHITECTURE.md`, `docs/COMPONENT_REUSE_AUDIT.md`, `docs/PUBLIC_BOOKING_WIDGET_PLAN.md` (re-base on persons/person_links before build).
