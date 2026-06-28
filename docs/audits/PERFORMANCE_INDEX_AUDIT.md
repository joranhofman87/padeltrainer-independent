# Performance & Index Audit — Hot Pages and Data Layers at Scale

**Scope:** padeltrainer main @ `cee9da68`. Target scale: ~1,000 academies / ~10,000 trainers / 100,000+ bookings.
**Method:** every hot read/list/calendar/dashboard data layer was traced to its Supabase query, then matched against the migration that provides the backing index. Each query was classified by how its result set is *bounded* and assigned a residual scale risk.

---

## Verdict

The hot-path data layer is in good shape for the target scale. Every list page (Players, Invoices, Registrations) is now **server-paginated via a clamped RPC with an exact `total_count`**, every calendar/agenda surface is **time-windowed and trainer-scoped over a composite index**, and the previously unbounded aggregation pages (cyclus overview, players sidebar) have been moved **server-side into SECURITY DEFINER RPCs that return grouped rows, not raw scans**. The two P0/P1 fixes that mattered most — **C1** (AcademyCalendar known-players sidebar, task #182) and the **Phase-3 history-window** scoping (TrainerScheduleOverview, task #173/#160) — are confirmed landed on this HEAD.

There is exactly **one genuinely raw/unbounded hot read path remaining**, and it is a *deploy-gated transient*: the `AcademyCyclusOverview` client fallback (`buildGroupsClientSide`) that streams an academy's entire slot+booking+intake set into the browser. It runs **only** when the `get_academy_cyclus_groups` RPC is not yet applied to prod. The fix is operational, not code: **ensure the RPC migrations are actually applied so the fallback never executes at scale.** No new migration is required — the RPCs and indexes already exist in the tree; they must be confirmed live.

The recurring hazard across the codebase is **PostgREST's implicit 1000-row cap** on un-paginated `select()`. Every silent-truncation bug we have fixed (the old players sidebar, the old invoice scoreboard) was a 1000-cap truncation. The reference patterns below exist specifically to make that cap unreachable.

---

## Risk legend

| Bound | Meaning |
|---|---|
| `paginated` | Server-side `p_limit`/`p_offset` RPC with exact `total_count`; explicit pages, 1000-cap unreachable. |
| `RPC-aggregated` | Aggregation done in the DB; client receives grouped/summary rows (count = #groups, not #rows). |
| `windowed` | Time- and/or owner-scoped to a bounded slice (a day/week/month, one trainer, one cycle); index-backed. |
| `raw-unbounded` | Whole dataset shipped to the client; bounded only by client memory. The thing we are eliminating. |

| Risk | Meaning |
|---|---|
| `fixed` | Was a problem; remediated and confirmed on this HEAD. |
| `low` | Acceptable at target scale; reference-quality or naturally bounded. |
| `medium` | Acceptable today but worth a watch / has a residual concern called out below. |

---

## Summary table (page/query → bound → backing index → risk → fix)

| Surface | Query (file:line) | Bound | Backing index | Risk | Fix / action |
|---|---|---|---|---|---|
| **AcademyCalendar** grid | `fetchSlotsForRange` `AcademyCalendar.tsx:283-330` | windowed | `idx_availability_slots_trainer_start` + `idx_bookings_slot_id` | low | none — reference windowing |
| **AcademyCalendar** players sidebar | `fetchAllKnownPlayers` `AcademyCalendar.tsx:397-420` | RPC-aggregated | `get_players_overview` + `idx_academy_trainers_academy_status`, `idx_bookings_guest_player_id`, `idx_guest_players_linked_profile` | **fixed (C1, #182)** | none — fix landed |
| **TrainerCalendar** grid | `fetchSlots` `TrainerCalendar.tsx:139-165` | windowed | `idx_availability_slots_trainer_start` + `idx_bookings_slot_id` | low | none — narrowest calendar scope |
| **AcademyCyclusOverview** (primary) | `fetchGroupsViaRpc` `AcademyCyclusOverview.tsx:112-140` | RPC-aggregated | `get_academy_cyclus_groups` + `idx_availability_slots_cyclus_trainer`, `idx_bookings_slot_status` (partial) | low | none — *when RPC is deployed* |
| **AcademyCyclusOverview** (fallback) | `buildGroupsClientSide` `AcademyCyclusOverview.tsx:145-568` | **raw-unbounded** | `idx_availability_slots_cyclus`, `idx_bookings_slot_id` (but full set shipped) | **medium** | **deploy `get_academy_cyclus_groups` (20260630140000) so this never runs; add alert if hit** |
| **AcademyCyclusOverview** bulk actions | `getSelectedSlotIds`/`handleBulkDelete`/`handleBulkPriceUpdate` `AcademyCyclusOverview.tsx:643-666,708-711,766-771` | windowed | `idx_availability_slots_cyclus_trainer` | low | none — user-selection-bounded, 500-chunked writes |
| **TrainerScheduleOverview** main fetch | `TrainerScheduleOverview.tsx:196-227` | windowed | `idx_availability_slots_trainer_start` + `idx_bookings_slot_id` | low | none — Phase-3 history-window (#160) |
| **Players LIST** | `fetchPlayersOverview` `playersOverview.ts:147-159` | paginated | `get_players_overview` (clamp ≤500) + overview indexes | low | none — reference list pattern |
| **Invoices LIST** | `fetchAcademyInvoices`/`fetchTrainerInvoices` `invoicesList.ts:73-89,186-199` | paginated | `get_*_invoices` (clamp ≤500) + `idx_invoices_(academy|trainer)_status_created` | low | none — reference list + summary pattern |
| **Registrations LIST** | `getCyclesWithCounts`→`count_cycles_intakes` `cycles.ts:301-330` | RPC-aggregated | `count_cycles_intakes` + `idx_cycles_owner`, `idx_intake_requests_cycle` | low | **confirm `count_cycles_intakes` deployed so fallback scan never runs** |
| **TrainerDashboard** stats/activity | `fetchTrainerStats`/`fetchTrainerActivity` `TrainerDashboard.tsx:81-201` | windowed | `idx_availability_slots_trainer_start` + `idx_bookings_slot_id` + `idx_bookings_created_at` | low | none — single-trainer, LIMIT-capped |
| **AcademyDashboard** activity | `AcademyDashboard.tsx:124-162` (+ stats `55-77`) | windowed | `idx_bookings_created_at`, `idx_invoices_academy_status_created`, `idx_availability_slots_trainer_start` | **medium** | watch; recent-bookings sort+`.in(trainerIds)` can scan deep for a large/old academy — see below |
| **agendaSlots** data layer | `fetchTrainerAgenda`/`fetchAcademyAgenda` `agendaSlots.ts:117-158` | windowed | `idx_availability_slots_trainer_start` + `idx_bookings_slot_id` | low | none — reference agenda pattern |
| **cycleDetail** data layer | `getCycleDetail` `cycleDetail.ts:52-153` | windowed | `idx_availability_slots_cyclus` + `idx_bookings_slot_status` (partial) | low | none — single-cycle detail pattern |
| **TrainerScheduleOverview** invoice reconcile | `handleSaveCycleEdit` `TrainerScheduleOverview.tsx:623-657,701-823` | windowed | GIN on `invoices.booking_ids` (task #151, migration E) | low | none — `.overlaps()` GIN-backed, one cycle's bookings |

---

## Reference patterns (the template — copy these for any new hot surface)

These three patterns are the canonical answers to "how do I read a large, growing table without hitting the 1000-cap or shipping the table to the browser." New hot surfaces should match one of them.

### 1. RPC-paginated list (Players / Invoices)
Server-side `p_limit`/`p_offset` clamped in the RPC, exact `total_count` returned as a window count in row 0.

- **Players:** `playersOverview.ts:147-159` → `get_players_overview` clamps `v_limit := least(greatest(p_limit,1),500)` (`20260611160001`); total via `rows[0].total_count`. Default page 50.
- **Invoices:** `invoicesList.ts:73-89,186-199` → `get_academy_invoices`/`get_trainer_invoices` (same ≤500 clamp, `20260614160000`); `INVOICE_PAGE_SIZE=50`. The composite `idx_invoices_(academy|trainer)_status_created (owner, status, created_at DESC)` (`20260614140000`) exactly covers filter+sort.

Why it's correct: explicit pages mean the 1000-cap is never reached, and `total_count` is exact even when the *current* page is empty. The `fetchAll*` bulk variants cap at a 20k hard ceiling + dedup, and the page-0 "planning" trick (`playersOverview.ts:162-220`) avoids 50 sequential pipeline re-runs.

**One caveat to track:** offset pagination re-runs the membership pipeline per page (no keyset cursor). Fine at hundreds/low-thousands of players per scope. If a single academy crosses ~5k players, switch that RPC to keyset (cursor on `(created_at, id)`).

### 2. Summary scoreboard (Invoices receivables tiles)
Read aggregate tiles from a **dedicated 1-row summary RPC**, never by summing the visible page client-side.

- `invoicesList.ts:107-162` reads receivables from a 1-row summary RPC. This is what fixed the old client-side sum that dropped the oldest unpaid rows at the 1000-cap. Tiles stay correct even when the page is empty or filtered.

Rule of thumb: **any total/count/sum tile on a paginated page must come from its own aggregate query, not from the rows on screen.**

### 3. Windowed calendar / agenda (Trainer + Academy calendars, agendaSlots)
Always bound by an explicit time window (`gte/lte(start_time, …)`) **and** owner scope (`eq/in(trainer_id, …)`), then resolve the small `.in(slot_id, …)` follow-up over `idx_bookings_slot_id`.

- `TrainerCalendar.tsx:139-165` (one day/week/month, single trainer) — narrowest scope, the gold standard.
- `AcademyCalendar.tsx:283-330` (one week/month, trainer-scoped).
- `agendaSlots.ts:117-158` (caller-supplied `from`/`to`).
- `TrainerScheduleOverview.tsx:196-227` — the **history-window** variant: lower-bounded to the last 6 months by default with an explicit "Load older" (+12mo) widening, so no history is *silently* dropped (Phase-3, #160).

Why it's correct: `idx_availability_slots_trainer_start (trainer_id, start_time)` lets the planner range-scan exactly the window, and every `.in(slotIds)` list derives from that one bounded window of slots — so it can never explode.

---

## What C1 / Phase-3 already fixed (do not re-flag)

- **C1 — AcademyCalendar known-players sidebar (task #182).** `AcademyCalendar.tsx:397-420` now calls `fetchAllPlayersOverview({kind:'academy'})`, which pages the canonical `get_players_overview` RPC (≤500/page, 5-way concurrency, 20k hard cap, dedup by `player_key`). This **replaced two unbounded scans** (every academy slot, then every booking) that truncated at the 1000-cap and undercounted players. Confirmed correct on this HEAD.
- **Phase-3 history-window — TrainerScheduleOverview (task #160).** The main slot+nested-bookings fetch (`TrainerScheduleOverview.tsx:196-227`) is now lower-bounded to the last `historyMonths` (default 6) with explicit "Load older", instead of loading all history. Per-trainer, index-backed; the nested embed returns only one trainer's roster.
- **count_cycles_intakes — Registrations list (task #173).** `cycles.ts:301-330` now gets per-cycle intake counts from **one indexed `GROUP BY`** (`count_cycles_intakes`, `20260629120000`), replacing the old unbounded `intake_requests` client scan. Falls back to the old scan only on `PGRST202/42883`.

---

## Genuinely remaining raw/unbounded hot path

There is **one**, and it is deploy-gated rather than a code defect:

### AcademyCyclusOverview client fallback — `buildGroupsClientSide` (`AcademyCyclusOverview.tsx:145-568`) — risk: medium
- **What it does:** streams the academy's **entire** slot set (paginated 1000/page loop, `209-229`), then **all** bookings on those slots in 500-chunks (`250-298`), then **all** intakes in 500-chunks (`302-347`), and does the 3-tier grouping in JavaScript.
- **When it runs:** only when `get_academy_cyclus_groups` 404s (`PGRST202/42883`) or errors — i.e. the RPC migration (`20260630140000`) is not applied to the environment. The primary path `fetchGroupsViaRpc` (`AcademyCyclusOverview.tsx:112-140`) does the same grouping + payment-status aggregation server-side and returns only the grouped rows.
- **Why it's a risk:** the pagination loop dodges the 1000-cap, but it then holds the **whole dataset in browser memory** — it OOMs/thrashes at 10k+ slots. This is literally the reason the RPC exists.
- **Fix — operational, no new migration:** confirm `get_academy_cyclus_groups` (`20260630140000`) is applied in prod so the fallback never executes at scale. **Recommended:** add a one-line ops alert (e.g. a `logger.warn`/Slack ping) when the fallback path is taken, so a missing-migration regression is loud instead of a silent slow-down. The same applies to the `count_cycles_intakes` fallback in `cycles.ts`.

> Net: **no schema migration is owed.** Every RPC and index this audit relies on already exists in the tree (`20260123113924`, `20260611160000/160001`, `20260614140000/160000`, `20260629120000`, `20260630140000`, plus the `invoices.booking_ids` GIN). The only outstanding action is **deploy verification** of the two aggregation RPCs.

---

## Watch item (not yet a defect): AcademyDashboard recent-bookings

`AcademyDashboard.tsx:124-162` orders **all** bookings by `created_at DESC` (over `idx_bookings_created_at`) and then filters to `.in('availability_slots.trainer_id', trainerIds)` via the slot inner-join, taking 40. The planner can walk newest-first, but it must probe each candidate booking's `slot.trainer_id` until it has collected 40. For a **large academy with many trainers but sparse recent activity** (or a small/old academy whose newest 40 are far down the global `created_at` order), this can scan deep at 100k+ bookings.

- **Today:** acceptable — `LIMIT 40`, `staleTime` 5 min, and the outstanding-invoices tile is a covered index-only `count(exact, head)` over `idx_invoices_academy_status_created`.
- **If academy dashboards slow at scale:** denormalize `trainer_id` (or `academy_profile_id`) onto `bookings` and add a partial index `(trainer_id, created_at DESC)` so the recent-bookings query becomes a direct range scan instead of a probe-and-discard. This *would* require a migration; defer until measured.

---

## The recurring hazard: PostgREST's 1000-row cap

Every silent-truncation bug this codebase has fixed was the same shape: an un-paginated `select()` that returns at most 1000 rows, so the 1001st+ row is **silently dropped** with no error — undercounting players, dropping the oldest unpaid invoices, missing slots in a grouping. The defenses are exactly the reference patterns above:

1. **Lists** → clamped `p_limit`/`p_offset` RPC + exact `total_count` (never an un-paginated table read for display).
2. **Totals/scoreboards** → a dedicated aggregate RPC (never a client-side sum of the visible page).
3. **Aggregations over a whole owner's data** → push the `GROUP BY` into a SECURITY DEFINER RPC that returns grouped rows.
4. **Necessary bulk reads** → an explicit `.range()`/1000-per-page loop **with a hard ceiling** (the `fetchAll*` 20k cap), used only off the hot render path.

When you add a new query, ask: *"can this table exceed 1000 rows in this scope at target scale?"* If yes, it must be one of patterns 1–4. A bare `.select()` for display is the bug.

---

## How to keep this current

- **When you add a hot read/list/calendar/dashboard query,** add a row to the summary table and classify its `bound`. If it's `raw-unbounded` and the table can exceed ~1000 rows in scope, it must move to an RPC (lists/aggregations) or gain a time/owner window (calendars) before merge.
- **When you add an index,** record the migration timestamp in the row whose query it backs. When you add an RPC with a `p_limit`, confirm it clamps (`least(greatest(p_limit,1),500)`).
- **Re-verify the deploy-gated fallbacks** (`get_academy_cyclus_groups`, `count_cycles_intakes`) whenever you bump environments — these audits assume the RPCs are live; the only way the one remaining `raw-unbounded` path executes is a missing migration.
- **Re-run the trace after any change to** `playersOverview.ts`, `invoicesList.ts`, `cycles.ts`, the calendar pages, or the dashboards — those files are the load-bearing data layers this audit certifies.
- Revisit the two `medium` watch items (cyclus fallback alerting; AcademyDashboard recent-bookings denormalization) once you have real production query timings at >10k slots / >100k bookings per scope.
