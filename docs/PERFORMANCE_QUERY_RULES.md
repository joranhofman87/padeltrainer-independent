# Performance & Query Rules (Scale Foundation)

> Purpose: the canonical rules a human or AI agent follows to write reads that stay correct and fast at target scale (~1,000 academies / ~10,000 trainers / 100,000+ bookings). Follow these before adding any list/calendar/dashboard/public query.
>
> Audience / AI-read: yes
>
> Status: canonical (source of truth) | last updated 2026-07-02

## The one hazard behind every rule

PostgREST silently caps every un-paginated `select()` at **1,000 rows** (Supabase default; no repo override found). Row 1001+ is dropped with **no error** — an invisible correctness bug: undercounted players, dropped oldest unpaid invoices, missing slots in a grouping, understated GMV. Every truncation bug this codebase has fixed was this exact shape. When you add a query, ask: *"can this table exceed 1,000 rows in this scope at target scale?"* If yes, it must follow one of the reference patterns below.

Deep detail (do not repeat — link): [`audits/PERFORMANCE_INDEX_AUDIT.md`](audits/PERFORMANCE_INDEX_AUDIT.md) (per-surface trace + backing indexes), [`audits/FULL_APP_SCALE_READINESS_AUDIT_2026-06-29.md`](audits/FULL_APP_SCALE_READINESS_AUDIT_2026-06-29.md) (scale verdict).

## The paging primitive: `src/lib/supabasePaging.ts`

For any **necessary bulk read** off the hot render path (money-path re-sync, backfills), reuse the shared helpers — do not hand-roll a `while(true)` loop:

- `fetchAllRows(buildQuery, pageSize=1000)` — range-pages one ordered query until a short page returns. The query **must** carry a stable, unique `.order(...)` (e.g. by PK) or windows skip/duplicate rows.
- `fetchAllByInChunks(ids, buildQuery, opts)` — chunks a large `.in(col, ids)` (default 200/chunk) so neither the URL nor the `ANY()` array grows unbounded; each chunk is itself range-paged.

Reference use: `src/lib/invoiceSync.ts:298,486,521,554,648,659` (money-path re-sync — the P1-7 fix). These helpers are the ONLY sanctioned way to read a >1,000-row set in full.

---

## The rules (DO / DON'T, each with a real reference)

### 1. Never `.select()` an unbounded table for display

**DON'T** load an entire table ordered by date with no `.range`/`.limit`/date-window. Silent truncation at 1,000 + a wide payload.

```ts
// ❌ src/pages/TrainerBookings.tsx:113-126 — all-time, no pagination (OPEN, P1-4)
.from('bookings').select(`id, status, ... availability_slots!inner(...)`)
  .eq('availability_slots.trainer_id', id).order('created_at', { ascending: false });
```

**DO** page server-side with a clamped RPC returning an exact `total_count`. Reference: `src/lib/playerBookings.ts` (`.range`), `src/lib/playersOverview.ts:147-159` (`get_players_overview`, clamp ≤500, default page 50).

### 2. Lists paginate by default (invoices / bookings / registrations)

**DON'T** `select('*')` a whole owner's invoices with no pagination:

```ts
// ❌ src/components/trainer/InvoiceList.tsx:104-108 — select('*'), no pagination (OPEN, P1-4)
.from('invoices').select('*').eq('trainer_id', trainerId).order('created_at', { ascending: false });
```

**DO** use the clamped list RPC + fixed page size. Reference: `src/lib/invoicesList.ts:73-89,186-199` → `get_academy_invoices`/`get_trainer_invoices` (clamp ≤500, `INVOICE_PAGE_SIZE=50`), backed by `idx_invoices_(academy|trainer)_status_created (owner, status, created_at DESC)`. Registrations: `src/lib/cycles.ts:301-330` → `count_cycles_intakes` (one indexed `GROUP BY`, not a client scan).

### 3. Totals/scoreboards come from a dedicated aggregate query — never a sum of the visible page

**DON'T** sum receivables/GMV from the rows currently on screen — the page is capped, so the oldest unpaid rows silently drop out of the total.

**DO** read tiles from a 1-row summary RPC. Reference: `src/lib/invoicesList.ts:107-162` (receivables summary RPC — fixes the old client-side sum). Rule of thumb: **any total/count/sum tile on a paginated page must come from its own aggregate query.**

### 4. Aggregations over a whole owner's data go into a SECURITY DEFINER RPC (`GROUP BY` in SQL)

**DON'T** stream an academy's entire slot+booking+intake set to the browser to group it in JS. Reference anti-pattern (deploy-gated fallback, must never run at scale): `src/pages/academy/AcademyCyclusOverview.tsx:145-568` (`buildGroupsClientSide`).

**DO** push the grouping into the DB and return only grouped rows. Reference primary path: `AcademyCyclusOverview.tsx:112-140` (`fetchGroupsViaRpc` → `get_academy_cyclus_groups`). **Operational note:** these RPC fallbacks (`get_academy_cyclus_groups`, `count_cycles_intakes`) only fire when the migration isn't live — verify deploy after any environment bump, else the app silently reverts to the unbounded scan (see [scale audit P1-5](audits/FULL_APP_SCALE_READINESS_AUDIT_2026-06-29.md)).

### 5. Calendar/agenda queries are bounded by a date window AND owner scope

**DON'T** fetch all-time slots for a trainer/academy.

**DO** bound by `gte/lte(start_time, …)` **and** `eq/in(trainer_id, …)`, then resolve the small `.in(slot_id, …)` follow-up over `idx_bookings_slot_id`. References (gold standard, don't touch):
- `src/pages/TrainerCalendar.tsx:139-165` — one day/week/month, single trainer (narrowest scope).
- `src/pages/academy/AcademyCalendar.tsx:283-330` — trainer-scoped week/month.
- `src/lib/agendaSlots.ts:117-158` — caller-supplied `from`/`to`.
- `src/pages/.../TrainerScheduleOverview.tsx:196-227` — history-window variant: lower-bounded to last 6 months + explicit "Load older" (no silent drop).

Backing index: `idx_availability_slots_trainer_start (trainer_id, start_time)` range-scans exactly the window.

### 6. Server-side filtering — don't filter a large table in the client

**DON'T** pull a wide result and `.filter()` in JS to narrow it. The pre-filter set is what truncates.

**DO** push filters (`.eq/.in/.gte`) into the query so the DB returns only matching rows, and index the hot filter columns. Filter+sort must be index-covered — see the invoices composite in Rule 2.

### 7. Avoid N+1 — batch multi-entity reads with `.in(...)`

**DON'T** loop per-row issuing one query each.

**DO** collect ids from a bounded window and issue one `.in(...)` follow-up. Reference: `src/pages/Trainers.tsx:226-229` batches `profiles_public`/`trainer_locations`/`availability_slots` via `.in(userIds/trainerIds)`. (The scale audit confirms **no N+1 patterns** remain in multi-entity reads.) For very large id sets use `fetchAllByInChunks` (Rule: paging primitive).

### 8. Heavy dashboards aggregate in SQL, not in a Deno edge function over capped arrays

**DON'T** load whole tables into a function and aggregate in JS.

```ts
// ❌ supabase/functions/get-admin-stats/index.ts:76-90 — six uncapped selects,
//    GMV/fees/trends summed in JS over PostgREST-capped 1,000-row arrays (OPEN, P2-16)
.from("bookings").select("id, payment_amount, payment_status, paid_at, created_at, slot_id")
```

Past 1,000 bookings this reports **materially understated GMV/fees** with no error; at 100k+ it risks OOM/timeout. **DO** move the aggregation into a COUNT/SUM RPC and return summary rows (as the invoice scoreboard and cyclus grouping already do). Single-trainer dashboards are fine because they're owner+`LIMIT`-bounded: `TrainerDashboard.tsx:81-201`, `AcademyDashboard.tsx:55-77,124-162`.

### 9. Public pages avoid expensive client waterfalls

**DON'T** chain many dependent sequential fetches on an anonymous public page.

**DO** batch independent reads (`Promise.all` + `.in(...)`) and read from RLS-safe `_public`/`_safe` views. Reference: `src/pages/Trainers.tsx:206-229` (one trainer query, then a single parallel batch over `profiles_public`, `trainer_locations`, `availability_slots`). Note: the public `Trainers.tsx` directory list itself is **not yet paginated** (P1-4) — bound it before the public directory grows large.

---

## Adding a new hot query — checklist

1. Can this set exceed ~1,000 rows in scope at target scale? If yes → it MUST be Pattern 1 (paginated RPC), 2 (summary RPC), 3 (GROUP BY RPC), 4 (windowed calendar), or a `supabasePaging` bulk read.
2. Every `.range()`-paged query carries a stable unique `.order(...)`.
3. Filter+sort columns are covered by an index (record the migration timestamp).
4. New `p_limit` RPCs clamp: `least(greatest(p_limit,1),500)`.
5. Any total/count/sum tile reads its own aggregate query, not the visible page.
6. Add a row to the summary table in [`audits/PERFORMANCE_INDEX_AUDIT.md`](audits/PERFORMANCE_INDEX_AUDIT.md) classifying the new query's bound.

See the ranked open items in [`technical-debt/PERFORMANCE_BACKLOG.md`](technical-debt/PERFORMANCE_BACKLOG.md).
