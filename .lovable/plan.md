

# Merge `is_marked_full` into `is_public` on Slots

## Problem
Two boolean fields on `availability_slots` — `is_marked_full` and `is_public` — control the same thing: whether a slot is visible to players on public booking pages. This creates confusion. We consolidate into a single `is_public` field and show a Lock icon when a slot is hidden.

## Changes

### 1. Database migration — Merge fields

```sql
-- Set is_public = false wherever is_marked_full = true (is_marked_full wins)
UPDATE availability_slots
SET is_public = false
WHERE is_marked_full = true AND is_public = true;

-- Drop the redundant column
ALTER TABLE availability_slots DROP COLUMN is_marked_full;
```

### 2. Files to update (replace all `is_marked_full` references with `is_public`)

| File | What changes |
|------|-------------|
| `src/pages/academy/AcademySlotDetail.tsx` | Replace `is_marked_full` → `is_public` (inverted logic). Toggle updates `is_public`. Lock icon shows when `!is_public`. Edit form uses `is_public`. |
| `src/pages/academy/AcademyOpenSlots.tsx` | Remove `is_marked_full` from query (already uses `is_public`). Add Lock icon next to Switch when `!is_public`. |
| `src/pages/academy/AcademyCycleDetail.tsx` | Replace `is_marked_full` → `!is_public` in toggle and slot creation. |
| `src/components/academy/AcademyCalendarOverview.tsx` | Replace `is_marked_full` → `!is_public` in status check and Lock icon display. |
| `src/components/academy/AcademyDayGrid.tsx` | Replace `is_marked_full` in isFull check → `!is_public`. |
| `src/components/academy/AcademyReportsTab.tsx` | Replace `is_marked_full` → `!is_public` in queries and stats. |
| `src/components/academy/SlotDetailDialog.tsx` | Replace `is_marked_full` → `is_public` (inverted). |
| `src/components/academy/AcademyPublicOpenSlots.tsx` | Remove `.eq('is_marked_full', false)` — already filtered by `.eq('is_public', true)`. |
| `src/pages/TrainerScheduleOverview.tsx` | Replace all `is_marked_full` → `is_public` (inverted logic) in queries, edits, toggles, badges. |
| `src/pages/BookLesson.tsx` | Remove `.eq('is_marked_full', false)` — already has `.eq('is_public', true)`. |
| `src/pages/PlayerDashboard.tsx` | Remove `.eq('is_marked_full', false)` — already has `.eq('is_public', true)`. |
| `src/pages/OpenSlots.tsx` | Replace `.eq('is_marked_full', false)` with `.eq('is_public', true)`. |
| `src/pages/academy/AcademyCalendar.tsx` | Remove `is_marked_full` from query/interface, use `is_public` instead. |

### 3. UI — Lock icon

Everywhere visibility is shown, display a small `Lock` icon when `is_public = false`:
- **Open Spots table**: Lock icon next to the Switch toggle
- **Calendar Overview**: Already has Lock icon (just change data source)
- **Slot Detail page**: Lock badge already exists (just change data source)
- **Trainer Schedule**: Lock icon already exists (just change data source)

### 4. Logic inversion note

`is_marked_full = true` meant "hidden" → `is_public = false` means "hidden". So every check like `slot.is_marked_full` becomes `!slot.is_public`, and every update `{ is_marked_full: value }` becomes `{ is_public: !value }`.

