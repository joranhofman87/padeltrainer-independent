# Foundation Verification Worklog

Anti-drift evidence artifact for the Codex foundation-verification sprint
(`docs/audits/CODEX_FOUNDATION_VERIFICATION_FOR_CLAUDE.md`). Branch history:
findings 1–2 shipped on their own branches before this one; findings 3–5 + this
worklog land on `hardening/codex-findings-3-4-5`.

| Item | Status | Evidence | Files touched | Tests/checks | Remaining risk |
|---|---|---|---|---|---|
| **1. Public single-slot online booking double-insert** | **fixed (merged + deployed)** | PR #183. Page no longer inserts the booking; `create-mollie-payment` owns creation via `book_slot_for_payment`; `_notes` param added (migration `20260701130000`), edge fn deploy-gap-resilient. Verified against source: `BookLesson.tsx` single-slot online branch now passes no `bookingIds` + no page insert; edge fn creates exactly one booking. | `src/pages/BookLesson.tsx`, `supabase/functions/create-mollie-payment/index.ts`, `supabase/migrations/20260701130000_book_slot_for_payment_notes.sql` | `src/test/bookLessonPaymentBookingIds.test.ts` (guard: no `create-mollie-payment` call both omits `bookingIds` and follows a page insert); `scripts/db/rehearse-book-slot.mjs` (notes stored, capacity enforced); full `vitest run`, `deno check`, rehearsal | **Live in prod** (edge fn deployed, migration applied, FE auto-deployed). Option A is the clean boundary. |
| **2. Vitest red suite** | **fixed (merged)** | PR #182. `adminListUiPhase1.test.ts` asserted pages literally contain `AppPage`/`PageHeader`/`ListPageSkeleton`, which `ListPageShell` now composes internally. Rewrote as an architecture guard (accepts `ListPageShell` OR the three directly). | `src/test/adminListUiPhase1.test.ts` | full `npx vitest run` → 237 files / 1784 tests green (was 1 file / 2 tests red) | None. Process fix: full `vitest run` is now a required gate (the red suite slipped through targeted-only runs). |
| **3. Dangerous mutations not fully out of UI** | **addressed (audit + guard; facade moves documented as follow-up)** | 45 direct high-risk-table writes inventoried on `main` (20 invoices, 6 bookings, 9 availability_slots, 6 cycles, 3 email_campaign_recipients, 1 slot_priority_claims-in-lib). Invoice delete/cancel IS draft-gated (paid invoices are cancelled, never hard-deleted) but the guard is duplicated across 6 files. | `docs/audits/MUTATION_BOUNDARY_AUDIT.md` (classification), `src/test/mutationBoundary.test.ts` + `src/test/fixtures/mutationBoundaryAllowlist.json` (shrink-only guard) | `mutationBoundary.test.ts` fails if a NEW direct high-risk write is added to `pages/`/`components/` outside the allowlist | Existing 45 writes are allowlisted, not yet moved. The invoice-facade consolidation (`src/lib/invoices.ts`) is the recommended next P1 move; documented, not done (avoids an untested money-path rewrite). |
| **4. Deploy checklist ambiguity** | **fixed** | `supabase db push --dry-run --linked` (owner-run) showed only `20260701130000` pending — all other post-06-24 migrations are LIVE. Reconciled the checklist to distinguish merged-vs-live + added verification commands. | `audit/DEPLOY_CHECKLIST.md` | owner-run `supabase migration list` / `db push --dry-run` | Edge-fn deploy state is owner-verified via `supabase functions list` (no CLI pending-tracker); checklist lists the candidates. |
| **5. Stale docs** | **fixed** | `UI_COMPONENT_STANDARDS.md` listed completed items (DateInputField, EmptyState-vs-DashboardEmptyState, neutral components) as follow-ups. Updated to state the canonical patterns + guards. `FRONTEND_ARCHITECTURE.md` was already current (updated PR #180). | `docs/UI_COMPONENT_STANDARDS.md` | n/a (docs) | None. |

## Required checks (run on the final branch)
- `npx tsc --noEmit` · `npm run lint` · `npm run build` · **full `npx vitest run`** · `npm run check:edge-config` · `npm run db:rehearse:all`
- `npm run i18n:check` (this env HAS bun, unlike Codex's machine)
- `deno check` on any touched edge fn

## Merge-readiness verdict
See the final report. Findings 1–2 are merged + live; 3–5 land here as additive docs + a guard (no behavior change), so this branch is **technically safe to merge**; the only production action outstanding is owner-side edge-fn redeploy verification (Finding 4) — no migration is destructive.
