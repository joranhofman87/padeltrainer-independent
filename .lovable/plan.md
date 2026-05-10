## Problem
The four "Padeltraining…" rows still bundle every slot of a registration cycle into one giant per-trainer row (Patrick 84, Yannick 70, Rene 42, Tygho 126 sessions). Each of those numbers is actually 5–9 separate weekly classes that the user wants to see as individual cycli (one row per recurring weekly slot, with its 1–4 booked players).

Example (Tygho): 126 slots = 9 weekly series × 14 weeks. Each series has its own day-of-week, start time, end time, and roster of up to 4 players. Those should be 9 rows, not 1.

## Solution
When building per-trainer groups inside a cycle, sub-group by the recurring schedule key, not just trainer.

### Change (single file: `src/pages/academy/AcademyCyclusOverview.tsx`)

In `fetchCyclusData`, replace the current `slotsByTrainer` Map with a `slotsBySeries` Map keyed by:

```
`${trainer_id}::${weekday(start_time)}::${HH:mm(start_time)}-${HH:mm(end_time)}`
```

Apply this sub-grouping in **both** processing paths:
1. The cycles-table loop (lines ~292–399, the `else` branch where `slotsByTrainer.size > 0`).
2. The orphan-slots loop (lines ~404–456) — already groups by trainer; expand the same way for consistency.

For each series:
- `group_key`: `${cycleId}::${seriesKey}` (or `${cyclusId}::${seriesKey}` for orphans) — keeps selection/sort stable.
- `cyclus_name`: derive a per-series label so the rows are distinguishable. Use `${weekdayName} ${HH:mm} - ${first booked player name}` when there are bookings, otherwise `${weekdayName} ${HH:mm}`. This mirrors the legacy "Maandag 14:00 - Floris" format the user already likes. Only do this for slots inside a registration-type cycle; for non-registration cycles keep `cycle.name` so they still group as one named cyclus.
- `day_time`: as today (`${weekdayName} HH:mm - HH:mm`), now naturally consistent within the series.
- `period_start` / `period_end`: first/last `start_time` within the series.
- `sessions`: `seriesSlots.length` (will become 14, not 126).
- `player_names` / `player_count`: union of names across all slots in the series — equals the recurring 1–4 players for the class.
- `max_participants`, `price_per_session`, `location_name`, `first_slot_id`, `status`, `type`: take from the first slot in the series; price falls back to `cycle.price_per_session`.

### Detail-view click target
`handleRowClick` opens by `cyclus_id`. For series rows we still pass the same `cyclus_id` — but also pass `first_slot_id` so the detail page can scope to that series. Verify `AcademyCycleDetail` already supports a `slot` query/state param; if not, follow up in a separate task. (No changes to detail page in this plan.)

### What stays
- The empty-intake-form skip (`if (cycle.type === 'registration' && slotsByTrainer.size === 0) return;`) remains.
- Sorting, filters, time filter, single-line row styling, header — unchanged.
- Non-registration cycles still render as one row per trainer (most have a single weekly schedule anyway, and the cycle name is meaningful).

## Out of scope
- Schema changes. No new `series_id` column is added; we derive the series key on the fly.
- Detail page rework.
- Mobile card view (still untouched).