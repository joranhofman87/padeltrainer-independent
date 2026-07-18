# Archived documentation

Purpose: historical context that is **kept, not deleted**. These docs described one-time
migrations, cutovers, or planning sprints that are now complete (or plans that were
superseded). They are preserved as an evidence trail — do **not** treat them as current
guidance, and do not follow their runbooks against prod.

Audience / AI-read: **no** (historical only)
Status: archived | moved 2026-07-02 · additions 2026-07-18

For current, canonical guidance start at [`../DOCUMENTATION_INDEX.md`](../DOCUMENTATION_INDEX.md)
and [`../AI_DEVELOPMENT_GUIDE.md`](../AI_DEVELOPMENT_GUIDE.md).

| Archived doc | What it was | Superseded by |
|---|---|---|
| `PHASE2_REGISTRATIONS_SPLIT.md` | Phase-2 registrations/cycles split spec (shipped) | [ADR-0001](../adr/0001-registrations-cycles-split.md), [DOMAIN_MODEL](../DOMAIN_MODEL.md) |
| `PHASE2_STEP3_RUNBOOK.md` | One-time cutover backfill runbook (done) | — |
| `PHASE4_PLAN.md` | Phase-4 slice plan (shipped) | ADR-0001/0002 |
| `PHASE4_CE_INTEGRITY_INDEX_RUNBOOK.md` | One-time FK+GIN owner-apply runbook (done) | — |
| `PHASE5_DEPLOYMENT.md` | Vercel preview deploy notes (cutover done) | [DEPLOYMENT_GUIDE](../../DEPLOYMENT_GUIDE.md) |
| `WAVE4-SCOPE.md` | Wave-4 scope/plan (done) | — |
| `W06-DEDUPE-DRYRUN.md` | Club-dedupe dry-run approval gate (done) | — |
| `UI_AUDIT_SPRINT1.md` | 2026-05-30 visual audit sprint (done) | [DESIGN_SYSTEM](../DESIGN_SYSTEM.md) |
| `SHARED_TABLE_MIGRATION_PLAN.md` | Not-started shared-table plan (superseded by the foundation direction) | — |
| `CYCLE_SERIES_SPLIT_RUNBOOK.md` | One-time mega-cycle split (applied to prod 2026-06-29) | — |
| `test-summary.md` | "Lisa Loops" test-automation run report (abandoned run) | [TEST_COVERAGE_GAPS](../TEST_COVERAGE_GAPS.md) |
| `testability-report.md` | "Lisa Loops" Stage-0 setup report (stale, lovable.app URLs) | [TESTING_STRATEGY](../TESTING_STRATEGY.md) |
| `AUDIT-2026-06.md` | June-2026 consolidated pre-launch audit (97 findings, generated 2026-06-12) | [audits/FULL_AUDIT_FRESH_EYES_2026-07-02.md](../audits/FULL_AUDIT_FRESH_EYES_2026-07-02.md) — the audit of record |
| `REBOOK_LINKED_GUEST_BACKFILL.sql` | One-time linked-guest backfill, executed at rebook go-live. **DO NOT RERUN** — keys on `linked_profile_id`, banned as identity truth by the person doctrine | [PERSON_UNIFICATION_PLAN](../PERSON_UNIFICATION_PLAN.md) |

> Point-in-time audit reports live under [`../audits/`](../audits/) instead — those are **not**
> archived here; they remain the evidence trail for findings and fixes. (One exception:
> `AUDIT-2026-06.md` predates the `audits/` convention and is fully superseded by the 2026-07-02
> fresh-eyes audit, so it lives here.)

- `PHASE2_STEP3_CUTOVER.sql` (moved 2026-07-18) — one-time Phase-2 cutover backfill SQL, executed —
  **DO NOT RERUN**. `src/test/settingsSplit.golden.test.ts` still reads it as the frozen
  form-allowlist source, so its content must not change.
- `CYCLE_SERIES_SPLIT.sql` (moved 2026-07-18) — one-time mega-cycle split, applied to prod
  2026-06-29 — **DO NOT RERUN**. `scripts/db/rehearse-cycle-series-split.ts` still rehearses it in
  CI (retiring that rehearsal is an open owner decision).
- `EDGE_FUNCTIONS_FICWB_AUDIT.md` (moved 2026-07-18) — cutover-era deploy-status snapshot; header
  note added, deploy list must not be used.
