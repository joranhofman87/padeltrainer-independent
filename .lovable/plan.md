## Goal

When the auto-planner (or a manual drag) places a player into a slot whose start/end falls **outside the player's `preferred_time_windows`** for that day, the player chip should show a warning icon with a tooltip — same pattern as the existing "day mismatch" warning. This tells the trainer they should contact the player before confirming.

## Background

We already warn for two mismatches on each placed player chip in `ProposalScheduleGrid.tsx`:

- **Rating out of range** (amber `AlertTriangle`)
- **Day mismatch** — player didn't pick this weekday (amber `Clock`)

But we don't warn when the slot time is outside the player's selected time windows (e.g. player asked for Monday 19:30–21:30 and the planner placed them on Monday 17:00–18:00). This is the case in the screenshot: Marijn asked for Mon 19:30–21:30, was placed at 22:30.

The data is already loaded — `IntakeRequest.preferred_time_windows: TimeWindow[]` exists in `src/lib/cycles.ts`. It's just not being forwarded to the grid component.

## Changes

### 1. `src/components/cycles/ProposalScheduleGrid.tsx`

- Extend `UnplacedPlayer` interface with `preferred_time_windows?: TimeWindow[]` (import `TimeWindow` from `@/lib/cycles`).
- Add a helper `isOutsideTimeWindow(slotStartIso, slotEndIso, dayKey, windows)` that:
  - Returns `false` if the player has no windows for that day (nothing to check — day mismatch warning already covers it).
  - Otherwise returns `true` when the slot's `[startMin, endMin]` is **not fully contained** in any of that day's windows.
- In `DraggablePlayerChip`, compute `timeMismatch` next to the existing `dayMismatch` and pass slot start/end via new props (`slotStart`, `slotEnd`).
- Render a third warning icon (amber `Clock` variant or reuse `AlertTriangle` with distinct tooltip) when `timeMismatch && !dayMismatch`. Tooltip text: `"Slot time is outside player's selected time window ({{windows}})"` — list the windows for that day in `HH:mm–HH:mm` form.
- Pass `slotStart`/`slotEnd` from the parent slot row where chips are rendered (already have the slot in scope).
- (Optional, low risk) Add a small +25/-25 adjustment in `computeManualScore` for time-window fit so manual-drop scores reflect the warning. Skip if it risks shifting existing scores; the visual warning alone satisfies the request.

### 2. Forward `preferred_time_windows` from the three pages that build `UnplacedPlayer[]`

- `src/pages/academy/AcademyCycleDetail.tsx` — `unplacedPlayers` and `allPlayersForGrid` mappers (lines ~298–311).
- `src/pages/academy/AcademyIntakeRequests.tsx` — `unplacedPlayers` mapper (line ~144).
- `src/pages/TrainerIntakeRequests.tsx` — `unplacedPlayers` mapper (line ~162).

Just add `preferred_time_windows: r.preferred_time_windows` to each object.

### 3. Translations

Add `proposals.timeMismatch` (with `{{windows}}` placeholder) to `cycles` namespace for `en` and `nl`. NL in sentence case per memory rules.

## Out of scope

- Changing the auto-planner's scoring/placement logic. The user only asked for a visible warning so the trainer knows to contact the player.
- Touching the slot occupancy/data layer or RLS.

## Verification

- Open the cycle in the screenshot: Marijn (Mon 19:30–21:30) placed at Mon 22:30 should now show an amber clock warning with tooltip "outside player's selected time window (19:30–21:30)".
- A player whose slot falls inside their window shows no warning.
- A player who didn't pick this weekday at all keeps showing only the existing day-mismatch warning (not a duplicate time warning).
