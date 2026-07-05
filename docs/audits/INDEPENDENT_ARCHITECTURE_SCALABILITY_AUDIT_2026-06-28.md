# Independent architecture, scalability, and code-quality audit

Date: 2026-06-28  
Repo: `joranhofman87/padeltrainer-independent`  
Local path audited: `/Users/tom/Cursor/padeltrainer`  
Baseline: `main` at `56ef404b`, matching `origin/main`  
Mode: **No-Fix Audit Mode**

## No-Fix Audit Mode

This pass intentionally made **no product code changes**, applied **no migrations**, deployed **no edge functions**, sent **no emails**, and invoked **no live side-effecting flows**. The only allowed changes were audit artifacts:

- `docs/audits/INDEPENDENT_AUDIT_WORKLOG.md`
- `docs/audits/INDEPENDENT_ARCHITECTURE_SCALABILITY_AUDIT_2026-06-28.md`

App description for this audit: **multi-tenant training, academy, booking, registration, invoice, and player-management software**.

## Executive verdict

I did **not** find a new P0 code blocker in the current source. The core booking/cycle/registration/invoice hardening is materially better than it was: the recent DB rehearsals are strong, the mutation boundary is guarded, the biggest cross-role component hazards were addressed, and the hot list/read paths are mostly server-paginated/RPC/windowed.

But I would **not** call the app fully scale-ready yet. The remaining risk is less "the domain model is broken" and more "the operating system around it is not yet boring enough": production deploy verification for the latest migrations, prod dependency vulnerabilities, dependency/tooling drift, incomplete server-side observability coverage, backup/restore proof, and a few stale docs/public Lovable references.

Scale target assumed: 1,000 academies / 10,000 trainers / 100,000+ bookings.

## Validation results

| Check | Result | Notes |
|---|---:|---|
| `npx tsc --noEmit` | PASS | TypeScript clean. |
| `npm run lint` | PASS | Role-isolation and lint baseline green. |
| `npm test` | PASS on rerun | Initial parallel run failed 7 PGlite `beforeAll` hooks with 10s timeouts while other heavy checks were running. Rerun alone passed: 247 files, 1849 tests. |
| `npm run build` | PASS | Non-fatal Vite warnings: mixed static/dynamic imports for `posthog.ts` and i18n JSON; stale Browserslist. |
| `npm run db:rehearse:all` | PASS | 40/40 rehearsals passed, including capacity, registration write, finalize proposals, players overview, invoice pagination, split-payment, staff capacity. |
| `npm run test:edge` | PASS | Deno `_shared` tests passed; expected port-1 fetch error is asserted in a test. |
| `npm run check:edge-config` | PASS | All 25 public edge functions are `verify_jwt=false`. |
| `npm run i18n:check` | NOT RUN LOCALLY | Failed because `bun` is missing in local PATH. CI sets up Bun. |
| `npm run db:types:check` | NOT RUN LOCALLY | Failed because local Supabase/Docker/CLI were unhealthy. `supabase status` could not reach Docker; `supabase --version` hit a local telemetry rename error. |
| `npm audit --omit=dev` | FAIL | 17 prod-scope advisories: 12 moderate, 5 high. See Finding P1-2. |

## Verdict on PRs #205-#213

| PR | Verdict | Evidence / caveat |
|---|---|---|
| #205 TSO bespoke invoice-write audit | GOOD | Correctly identified the money-write cluster and produced a useful remediation plan. |
| #206 read-only reconciliation + PGlite validation | GOOD | Audit-only validation is coherent; no product side effect. |
| #207 reconciliation query fix | GOOD | Corrected the `invoices.cycle_id` false assumption; avoids missing prod rows where `cycle_id` is null. |
| #208 inert Write A extraction | GOOD | Moved booking-id merge logic into tested lib owner without behavior switch. |
| #209 inert Write B extraction | GOOD | Moved extra-cost/total recalc into tested lib owner without behavior switch. |
| #210 Write A fix | GOOD | Routes cyclus-extend booking IDs to the correct per-player invoice. |
| #211 Write B fix | GOOD | Recalc now goes through the canonical sync pipeline and gate; PGlite coverage exists. |
| #212 registrations count + finalize proposals spec | GOOD | `db:rehearse:all` confirms `count_cycles_intakes` and finalize proposal invariants. |
| #213 TrainerEarnings server-side summary | CODE GOOD, DEPLOY VERIFY NEEDED | RPC derives trainer from `auth.uid()` and golden PGlite test compares SQL to JS money helper. The scale win only exists in production if migration `20260702150000_get_trainer_earnings_summary.sql` is live. |

## Findings

| Priority | Finding | Evidence | Risk | Recommended action |
|---|---|---|---|---|
| P1 | Production deploy state is not authoritatively reconciled for the newest backend changes | `audit/DEPLOY_CHECKLIST.md` is strong but predates PRs #205-#213 in several places and does not clearly list `20260702150000_get_trainer_earnings_summary.sql`. Local audit did not query prod. | Repo can be correct while prod still runs expensive fallbacks or stale edge code. | Create one current release ledger for PRs #205-#213: `supabase migration list`, `db push --dry-run`, and `functions list`; record exact live status. Do not claim scale-ready until latest migrations are applied or explicitly deferred. |
| P1 | Production dependency audit is red | `npm audit --omit=dev`: high/moderate advisories in `dompurify@3.4.7`, `posthog-js` OpenTelemetry chain, `ws` via Supabase realtime, `lodash` via Recharts, `glob/minimatch/picomatch/yaml` via Tailwind/tooling. `SafeHtml` uses DOMPurify at runtime. | Security and DoS risk in runtime/browser packages; DOMPurify is directly load-bearing for rich HTML. | Dedicated dependency PR: update safe ranges, rerun `npm audit --omit=dev`, `npm test`, build, and browser smoke rich-text surfaces. |
| P1 | Deploy-gated scale fallbacks are silent/too easy to miss | `AcademyCyclusOverview` falls back when `get_academy_cyclus_groups` is missing/failing. `cycles.ts` has `count_cycles_intakes` fallback. `TrainerEarnings` falls back to full-load when `get_trainer_earnings_summary` is missing. | Correctness is protected, but missing migrations silently remove scale benefits and can reintroduce browser-heavy scans. | Add a deploy verification checklist plus a Slack/log alert when a scale fallback runs in production. Treat fallback hits as deploy drift. |
| P1 | Server-side observability is still partial | Top three gaps from the old audit are fixed (`finalize-proposals`, `sync-invoice-to-bookings`, `submit-guest-intake`), but only 23/93 function folders reference Slack. `slack-notify` has no heartbeat/rate-limit/dead-man switch. | Some auth/email/rebooking/admin failures can still be console-only. Slack itself can silently fail or flood. | Add server-side error backstop or log drain dashboard, Slack heartbeat, alert throttling/dedup, missed-cron freshness, and promote auth/payout/rebooking functions first. |
| P1 | Backup/restore posture is documented but not proven | `audit/RUNBOOK_BACKUP_RESTORE.md` explains Supabase PITR + JSON backup. It explicitly says PITR must be confirmed, JSON backup is incomplete, and no restore drill exists. | A bad migration or data incident at scale is recoverable only if backups and restore paths have been tested. | Verify PITR in Supabase, run one restore drill into scratch/staging, extend JSON backup to now-critical tables, document last successful drill. |
| P1 | Staging/E2E/load confidence is not yet at the target scale | CI has unit, DB rehearsals, edge tests, i18n, scheduled E2E, SEO smoke. But no full authenticated staging flow with seeded academies/trainers/bookings was run in this audit. | Bugs that only appear with real role auth, browser/mobile, payments disabled/mocked, or high data volume may escape. | Build a staging seed + non-destructive authenticated smoke suite for academy/trainer/player flows, plus a synthetic 100k-booking performance rehearsal for hot RPCs. |
| P2 | Mutation boundary is guarded but not finished | `src/test/mutationBoundary.test.ts` passes and blocks new high-risk writes, but allowlist is still 36 direct writes across 26 UI/component files. `MUTATION_BOUNDARY_AUDIT.md` still contains an older 92/34 count. | Future fixes are safer, but some legacy page/component writes remain and docs can mislead. | Refresh the audit doc counts; shrink the allowlist opportunistically, prioritizing money/status writes. |
| P2 | Shared component architecture is much better, but adoption is incomplete | Role-isolation `no-restricted-imports` baseline is zero. Shared `DateInputField`, `ListPageShell`, player cards, invoice list/table pieces exist. Remaining debt: trainer/academy invoice settings convergence, trainer/club/player ListPageShell adoption, `PageHeader`/trainer chrome, large page extraction. | Not a launch blocker, but slows safe AI-assisted changes and increases copy-paste risk. | Continue small mechanical adoption slices; never combine visual redesign with logic/money changes. |
| P2 | Lint/type debt is still large | `eslint-suppressions.json`: 857 `@typescript-eslint/no-explicit-any`, 105 `react-hooks/exhaustive-deps`, 30 refresh suppressions. Large files: `CycleForm.tsx` 2476 LOC, `cycles.ts` 2197, `AddSlotDialog.tsx` 1997, `ProposalScheduleGrid.tsx` 1967, `TrainerScheduleOverview.tsx` 1771. | More surface area for subtle regressions and AI edits that miss hidden dependencies. | Ratchet by touched-area: no new suppressions; burn down top 10 high-churn files. |
| P2 | Public/clean-app Lovable references remain | Runtime code search found `src/pages/marketing/Brand.tsx` linking to `github.com/lovable-dev/padeltrainer/...`. `README.md` is still the stock Lovable README. Many legacy docs/scripts mention Lovable as migration history. | Brand/README polish issue; can confuse contributors and users. | Replace Brand link, rewrite README, archive/label legacy migration docs. Keep historical migration scripts if needed but mark as legacy. |
| P2 | Build/bundle hygiene is acceptable but not finished | Build passed, but Vite warned about mixed static/dynamic imports for `posthog.ts` and locale JSON. Large chunks include charts, Supabase, React, map modules. | Not a correctness issue, but mobile performance can suffer as data/users grow. | Run a mobile Lighthouse/WebPageTest pass and clean dynamic import warnings where easy. |

## Confirmed fine

- Current checkout is `main` at `56ef404b` and matches `origin/main`.
- Core validation passed after rerunning `npm test` alone.
- DB rehearsals are unusually valuable here: 40/40 passed and cover capacity locks, staff capacity, registration writes, players overview, finalization atomicity, invoices, split-payment, shared emails, and more.
- Recent high-risk `SECURITY DEFINER` functions look scoped correctly:
  - `finalize_cycle_proposals` is service-role-only.
  - `book_slot_for_payment` is service-role-only.
  - `get_trainer_earnings_summary` derives trainer from `auth.uid()`, with no trainer-id parameter.
  - `get_academy_cyclus_groups` checks academy manager scope.
- Role isolation is now CI-enforced and the `no-restricted-imports` suppression total is zero.
- `DateInputField` is canonical; raw `<Input type="date">` is lint-blocked. The only direct date-type hit was the sanctioned component plus one `datetime-local` admin field.
- The earlier top three observability money gaps are now wired to Slack in source.
- No stale Lovable/Supabase preconnects were found in `index.html`.

## Accepted residuals

- The first `npm test` run failed because several PGlite hooks timed out while other heavy suites were running in parallel. Since the same command passed alone, I treat this as a local resource-contention artifact, not a source failure. It is still worth watching CI for flakes.
- Fallbacks for missing RPCs are acceptable for deploy gaps, not for steady-state production scale.
- The six AI-gateway edge functions are intentionally deferred in `audit/DEPLOY_CHECKLIST.md`; that is acceptable if those features remain off.
- Local `i18n:check` and `db:types:check` could not be completed because of local tool/runtime issues. CI is configured to provide Bun and Supabase local stack.
- This was a code/static/local-test audit only. No live Supabase, Vercel, Cloudflare, Resend, Mollie, Stripe, PostHog, or backup dashboard state was verified.

## Top 10 highest-leverage next changes

1. **Production release ledger for PRs #205-#213.** One doc row per migration/edge function: merged commit, expected deploy, prod observed version/timestamp, owner/date.
2. **Dependency security PR.** Start with `dompurify`, `posthog-js`/OpenTelemetry, `@supabase/supabase-js`/`ws`, `recharts`/`lodash`; rerun audit and full gates.
3. **Scale-fallback alerting.** Alert if `get_academy_cyclus_groups`, `count_cycles_intakes`, or `get_trainer_earnings_summary` fallbacks run in production.
4. **Staging environment with seed data.** Realistic academies/trainers/players/bookings/invoices, no live emails/payments, repeatable reset.
5. **Authenticated E2E smoke suite.** Academy creates/edits registration/cycle/slot, trainer books/marks paid, player books/cancels/pays in mocked mode, mobile viewport included.
6. **Server observability backbone.** Error sink beyond Slack, Slack heartbeat, Slack rate-limit/dedup, missed-cron freshness checks.
7. **Backup/restore drill.** Confirm PITR, perform one scratch restore, extend JSON backup table list, document proof.
8. **Mutation-boundary shrink.** Refresh doc counts, then move remaining high-value invoice/booking/slot writes into facades/RPCs in tiny tested slices.
9. **Component adoption pass.** Finish `InvoiceSettingsCardBase` convergence and ListPageShell/DataTable adoption on trainer/club/player high-traffic pages.
10. **Clean legacy Lovable residue.** Rewrite README, fix Brand-page docs link, archive/label old migration docs, update stale Phase 5 docs.

## Simplification / dead-code / stale-doc list

- `src/pages/marketing/Brand.tsx`: public "Read the docs" link points at `github.com/lovable-dev/padeltrainer`. Replace with the actual repo/docs URL or an internal `/brand`/docs route.
- `README.md`: still the generated Lovable README. Rewrite for Padeltrainer setup, scripts, deployment, Supabase manual deploy warning, and local env.
- `docs/PHASE5_DEPLOYMENT.md`: still says stop before Lovable deletion and references Sentry as a blocker; it conflicts with newer monitoring/deploy docs.
- `docs/DOMAIN_MODEL.md` and `docs/EXTENDING_THE_DOMAIN.md`: still mention types-drift as permanently/perma red; CI now has a types-drift job, so reword to the current truth.
- `docs/audits/MUTATION_BOUNDARY_AUDIT.md`: refresh old 92/34 count to current 36/26, or clearly mark older count as historical.
- `docs/audits/FRONTEND_COMPONENT_ARCHITECTURE_AUDIT.md`: useful but stale in parts; current source has already resolved player detail/remove sharing, DateInputField, EmptyState, and role-isolation zero.
- `audit/OBSERVABILITY_AND_ALERTING_AUDIT.md`: useful but stale in the top Tier-D list; first three money gaps are fixed. Refresh remaining gap list.
- `test-plan.json` and `testability-report.md`: still describe Supabase Auth via Lovable Cloud / Lovable URLs. Archive or update.
- `docs/cloudflare-worker.js` and migration scripts: many Lovable references are historical; label as legacy migration material if retained.

## Suggested Claude execution prompt for fixes

Use this as the next-session prompt:

```md
You are technical lead for Padeltrainer. Start from `/Users/tom/Cursor/padeltrainer` on latest `origin/main`.

Read `docs/audits/INDEPENDENT_ARCHITECTURE_SCALABILITY_AUDIT_2026-06-28.md` and `docs/audits/INDEPENDENT_AUDIT_WORKLOG.md`.

Rules:
- Verify every finding against current source before editing.
- Work in small PR-sized slices.
- No production deploys, live emails, live rebooking, or live payment actions.
- For every fix: add/adjust tests, update docs, run targeted checks, then run the broader gates.
- Do not claim "scale-ready" until every P1 is fixed or explicitly owner-verified.

Phase 1 fixes:
1. Refresh deploy/release documentation for PRs #205-#213, especially migration `20260702150000_get_trainer_earnings_summary.sql`; do not mark live unless verified from Supabase output supplied by the owner.
2. Fix production dependency audit findings in a dedicated dependency PR; prioritize runtime `dompurify`, `posthog-js`/OpenTelemetry, `ws`, and `lodash`.
3. Add production-visible alerting when scale fallbacks run (`get_academy_cyclus_groups`, `count_cycles_intakes`, `get_trainer_earnings_summary`).
4. Clean public/stale Lovable references: Brand page docs link, README, stale Phase 5 docs, stale audit counts.

Definition of done:
- Full local gates pass or blocked reasons are exact.
- `npm audit --omit=dev` is clean or residual advisories are documented with package path and risk acceptance.
- Docs distinguish repo merged vs production live.
- Report changed files, tests, remaining risks, and reviewer self-check.
```

## Reviewer self-check

- I did not edit product code.
- I did not apply migrations.
- I did not deploy edge functions.
- I did not invoke live side-effecting flows.
- I reran the initially failing `npm test` alone and recorded the pass.
- I recorded every command that failed locally and why that weakens the audit.
- I did not claim production is updated; production verification remains owner/Supabase dependent.
- I treated older audit docs as evidence, not truth, and rechecked current source where practical.
