## Goal

Make the agenda denser by removing the 4 summary cards at the top and surfacing the same information directly inside the week-by-trainer table.

Scope: `AcademyCalendar` (week view only) + `AgendaWeekByTrainer`. Day/Month/Cycles/Hours/Reports views are untouched. Trainer-side `TrainerCalendar` uses the same component so it inherits the cell changes automatically — but the trainer page only ever has 1 row, so we'll keep the same logic; no special branching.

## Changes

### 1. `src/pages/academy/AcademyCalendar.tsx`
- Remove the 4-tile `grid grid-cols-2 md:grid-cols-4` summary block (the "Trainers training / Locations in use / Booked hours / Free hours" cards, ~lines 780–880).
- Pass the already-computed `summaryStats` (active trainers, active locations, bookedHours, freeHours) down into `<AgendaWeekByTrainer />` as a new optional `summary` prop so it can render them in the footer.

### 2. `src/components/agenda/AgendaWeekByTrainer.tsx`

**Day cells (`renderCell`)** — for cells with sessions:
- Remove the dots row (the `slotsForCell.slice(0, 6).map(...)` rendering colored dots and the `+N` overflow).
- Remove the "session / sessions" label text (keep just the number).
- Add a small row of location logo avatars (dedup by `location_id`, max 3 shown, `+N` overflow), reusing the same circular `<img>` styling used in the existing "Locations in use" tile.
- Add two compact stats: booked hours and free hours for that day-cell, computed from each slot's duration × fillRatio (matching the formula in `AcademyCalendar.summaryStats`).
- Bump cell height slightly (h-20 → h-24 on sm) to fit the new content; keep mobile stack untouched.

**Header / Total column**:
- Rename the `Total` header so its sub-line shows two numbers per trainer row: booked hours and free hours for the visible week (instead of the current single hours value). Render as two stacked tabular-nums values, e.g. `6.0h booked` / `2.5h free`, muted styling.
- Compute per-trainer free hours the same way as the global summary (`dur * (1 - fillRatio)` summed over their week's slots).

**Footer row** (new, desktop only):
- Add a footer strip below the trainer rows showing the academy-wide totals previously in the cards: trainers-training count + avatar stack, locations-in-use count + logo stack, booked hours, free hours, plus the existing `sessions / hours / fillRate`.
- Drives off the new `summary` prop from `AcademyCalendar`; falls back to internally-computed `totals` when the prop isn't passed (so `TrainerCalendar` still works).

**Mobile stack**: out of scope — leaves the existing per-day stack as-is. Only the desktop grid changes.

### 3. Translations
- Reuse existing keys: `calendar.summary.bookedHours`, `calendar.summary.freeHours`, `calendar.summary.activeTrainers`, `calendar.summary.locationsInUse`, `calendar.total`.
- Add short keys for the per-cell labels if needed: `calendar.cell.booked` ("booked"), `calendar.cell.free` ("free"). Sentence case for NL per project convention.

## Out of scope
- Day view, Month view, Cycles, Hours, Reports tabs.
- Mobile layout of the week view.
- Any data-fetching or business-logic changes — purely presentational; `summaryStats` already exists.
