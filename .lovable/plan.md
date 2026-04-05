

# Fix Cycles Tab: Group by Cycle + Trainer

## Root Cause
A single registration cycle (e.g. "Padeltrainingen zomer 2026", id `1e40f602-...`) contains slots for **multiple trainers** — Patrick (84 slots), Yannick (70), Rene (42), Tygho (126). The current code groups only by `cycle_id`, so it creates one row and picks the first trainer it finds (Rene). The other trainers are invisible.

## Solution
Change the grouping key from `cycle_id` to `cycle_id + trainer_id`. Each unique (cycle, trainer) combination becomes its own row. This way "Padeltrainingen zomer 2026" appears as 4 rows — one per trainer.

## Changes in `src/pages/academy/AcademyCyclusOverview.tsx`

### 1. Update the `CyclusGroup` interface
- Add a composite `group_key` field (`cyclus_id + trainer_id`) used for selection/identification
- Keep `cyclus_id` for reference

### 2. Rewrite the grouping logic (lines ~280-396)
When processing cycles from the `cycles` table:
- Instead of creating one `CyclusGroup` per cycle, **sub-group the slots by `trainer_id`** within each cycle
- For each (cycle, trainer) pair, create a separate `CyclusGroup` with:
  - `cyclus_name`: cycle name (same for all trainers in the cycle)
  - `trainer_id` / `trainer_name`: the specific trainer
  - `sessions`: count of that trainer's slots only
  - `day_time`: derived from that trainer's first slot
  - `period_start`/`period_end`: from that trainer's slot range
  - `player_names`: only players booked on that trainer's slots
  - `price_per_session`: from that trainer's slots or cycle-level price
- For academy-owned cycles with **no slots** for a specific trainer, still show one row with cycle-level data

### 3. Update selectedIds and bulk actions
- Use the composite `group_key` instead of `cyclus_id` for selection
- When applying bulk updates, resolve the correct slot IDs for the specific trainer within the cycle

### 4. Intake players
- For academy-owned cycles, intake players should be distributed to the correct trainer row (if `intake_requests` has a trainer reference) or shown on all trainer rows for that cycle

## Expected result
The Cycles tab will show:
- "Padeltrainingen zomer 2026" — Patrick (84 sessions)
- "Padeltrainingen zomer 2026" — Yannick (70 sessions)
- "Padeltrainingen zomer 2026" — Rene (42 sessions)
- "Padeltrainingen zomer 2026" — Tygho (126 sessions)
- Plus any other cycles from other registrations

## File summary

| File | Change |
|------|--------|
| `src/pages/academy/AcademyCyclusOverview.tsx` | Group by (cycle_id + trainer_id) instead of just cycle_id |

