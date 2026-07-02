# Performance Backlog (ranked, scale-blocking first)

> Purpose: the ranked, file-referenced list of open performance/scale debt, with the rough scale at which each breaks. Fix top-down; each item cites current source.
>
> Audience / AI-read: yes
>
> Status: canonical (source of truth) | last updated 2026-07-02

Rules for writing the fix: [`../PERFORMANCE_QUERY_RULES.md`](../PERFORMANCE_QUERY_RULES.md). Full traces: [`../audits/PERFORMANCE_INDEX_AUDIT.md`](../audits/PERFORMANCE_INDEX_AUDIT.md), [`../audits/FULL_APP_SCALE_READINESS_AUDIT_2026-06-29.md`](../audits/FULL_APP_SCALE_READINESS_AUDIT_2026-06-29.md), [`../audits/FULL_AUDIT_FRESH_EYES_2026-07-02.md`](../audits/FULL_AUDIT_FRESH_EYES_2026-07-02.md).

## Verdict

The hot-path data layer is **in good shape** for target scale: every display list is server-paginated via a clamped RPC, calendars/agenda are date+owner windowed, and whole-owner aggregations are pushed into SECURITY DEFINER RPCs. **P1-7** (money-path invoice re-sync truncation) is **FIXED + DEPLOYED** via the shared `src/lib/supabasePaging.ts` helpers (`invoiceSync.ts:298,486,521,554,648,659`). The remaining debt is a small, bounded set of unbounded display lists (degrade for power users) and one server-side aggregation truncation (understated GMV) — none are architectural breakage.

## Already fixed — do NOT re-flag

| Item | Where | Status |
|---|---|---|
| P1-7 — cycle invoice re-sync truncated at 1,000 bookings | `src/lib/invoiceSync.ts` (now via `fetchAllByInChunks`/`fetchAllRows`) | FIXED + DEPLOYED (2026-07-02) |
| C1 — AcademyCalendar known-players sidebar unbounded scan | `AcademyCalendar.tsx:397-420` → `fetchAllPlayersOverview` | FIXED (#182) |
| Phase-3 — TrainerScheduleOverview all-history load | `TrainerScheduleOverview.tsx:196-227` (6-mo window) | FIXED (#160) |
| Registrations intake counts client scan | `cycles.ts:301-330` → `count_cycles_intakes` | FIXED (#173) |
| Players / Invoices lists 1,000-cap | `playersOverview.ts:147-159`, `invoicesList.ts:73-89,186-199` | FIXED (server-paginated RPCs) |

---

## Ranked open backlog

### P1 — scale-blockers (silent correctness at target volume)

#### P1-a · `get-admin-stats` loads whole tables → wrong GMV/fees past 1,000 rows
- **Where:** `supabase/functions/get-admin-stats/index.ts:76-90` — six uncapped selects (`bookings`, `trainer_profiles`, `profiles`, `trainer_mollie_accounts`, `club_profiles`, `guest_players`); GMV/fees/monthly-trends summed in JS over PostgREST-capped arrays. Live via `src/lib/admin.ts:173`.
- **Breaks at:** > 1,000 total bookings the admin financial dashboard **understates GMV/fees with no error**; at 100k+ it risks OOM/timeout removing the cap.
- **Fix:** move aggregation into COUNT/SUM RPCs; return summary rows. (Fresh-eyes **P2-16**, CONFIRMED — ranked P1 here because it is a silent money-accuracy defect, though admin-only blast radius.)

#### P1-b · `TrainerBookings` unbounded all-time fetch
- **Where:** `src/pages/TrainerBookings.tsx:113-126` — `.select(...)` all-time, no `.range`/`.limit`/date-window, ordered `created_at DESC`.
- **Breaks at:** a trainer crossing 1,000 lifetime bookings → older bookings **silently vanish** from the list; wide payload meanwhile.
- **Fix:** server-side `.range` pagination like `src/lib/playerBookings.ts`, or a date-window. (Scale audit **P1-4**.)

#### P1-c · Trainer `InvoiceList` — `select('*')`, no pagination
- **Where:** `src/components/trainer/InvoiceList.tsx:104-108` — `.from('invoices').select('*').eq('trainer_id', …)` all-time.
- **Breaks at:** a trainer crossing 1,000 lifetime invoices → truncation + heavy `*` payload.
- **Fix:** reuse the paginated `get_trainer_invoices` RPC path (`invoicesList.ts`) + column projection. (Scale audit **P1-4**.)

#### P1-d · Deploy-gated aggregation fallbacks can silently revert to unbounded scans
- **Where:** `AcademyCyclusOverview.tsx:145-568` (`buildGroupsClientSide`), `cycles.ts:93-94`/`301-330`, `priorityClaims.ts:416`, `TrainerEarnings.tsx:226` — all fall back to the legacy unbounded path on `PGRST202`/`42883`.
- **Breaks at:** any environment where the aggregation RPC (`get_academy_cyclus_groups` `20260630140000`, `count_cycles_intakes` `20260629120000`) isn't applied → app streams the whole owner's dataset to the browser (OOM at 10k+ slots) invisibly.
- **Fix (operational + telemetry):** verify the RPCs are live after every env bump; add a `notifySlackEdge`/PostHog ping when any fallback branch fires so a missing migration is loud, not a silent slow-down. (Scale audit **P1-5**; index audit "remaining raw-unbounded path".)

### P2 — degrade at scale / defer until measured

#### P2-a · Public `Trainers.tsx` directory list not paginated
- **Where:** `src/pages/Trainers.tsx:206-229` — trainer directory query has no pagination (batch follow-ups are correctly `.in(...)`-bounded).
- **Breaks at:** public directory > 1,000 trainers → truncation on an anonymous SEO page.
- **Fix:** paginate (or windowed load-more) the directory query.

#### P2-b · Missing `availability_slots(academy_profile_id, start_time)` composite index
- **Where:** only `idx_availability_slots_academy` + `(trainer_id, start_time)` exist today.
- **Breaks at:** academy calendar over 100k+ slots may slow (trainer-scoped path is covered; academy-scoped isn't).
- **Fix:** add the composite index **if** the academy calendar slows at scale — requires a migration; defer until measured. (Scale audit **P2-10**.)

#### P2-c · AcademyDashboard recent-bookings probe-and-discard
- **Where:** `AcademyDashboard.tsx:124-162` — orders ALL bookings `created_at DESC` over `idx_bookings_created_at` then `.in('availability_slots.trainer_id', trainerIds)` LIMIT 40.
- **Breaks at:** a large academy with sparse recent activity at 100k+ bookings → planner scans deep to collect 40. Acceptable today (LIMIT 40 + 5-min staleTime).
- **Fix:** denormalize `trainer_id` onto `bookings` + partial index `(trainer_id, created_at DESC)` → direct range scan. Requires a migration; defer until measured. (Index audit "watch item".)

#### P2-d · Offset pagination re-runs the membership pipeline per page (Players list)
- **Where:** `playersOverview.ts` `get_players_overview` uses `p_limit`/`p_offset`, no keyset cursor.
- **Breaks at:** a single academy over ~5k players → later pages re-run the pipeline.
- **Fix:** switch that RPC to keyset (cursor on `(created_at, id)`). Defer. (Index audit caveat.)

---

## How to work this list

1. Fix top-down (P1-a → P1-d before P2).
2. Each fix follows [`../PERFORMANCE_QUERY_RULES.md`](../PERFORMANCE_QUERY_RULES.md); reuse `src/lib/supabasePaging.ts` for any full-set bulk read.
3. Verify with a PGlite/seed test (e.g. seed 2k bookings for one entity, assert no 1,000-cap truncation) per `db:rehearse:*` conventions.
4. When fixed, move the row to "Already fixed" with the PR/commit and update the matching row in [`../audits/PERFORMANCE_INDEX_AUDIT.md`](../audits/PERFORMANCE_INDEX_AUDIT.md).
5. Re-verify the deploy-gated fallbacks (P1-d) whenever environments are bumped — the audits assume those RPCs are live.
