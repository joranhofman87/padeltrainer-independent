## Problem
The "Reset skipped" button I previously added landed on `AcademyIntakeRequests.tsx` and `TrainerIntakeRequests.tsx`, but the screen in the screenshot (`/app/academy/cycles/:id?step=registrations&status=skipped`) is rendered by `AcademyCycleDetail.tsx` — a different file with its own copy of the skipped-summary alert. So the button isn't visible there.

## Fix
Add the same "Reset skipped" button to the skipped-summary alert in `src/pages/academy/AcademyCycleDetail.tsx` (around lines 763-780).

Behavior:
- Calls `resetSkippedRequests(cycleId)` from `src/lib/cycles.ts` (already exists).
- Clears `skip_reason` on all skipped registrations of the current cycle so they go back to plain "new".
- Shows a success toast, refreshes data, and switches the tab from "Skipped" to "New" so the user can immediately re-run "Generate proposals".
- Disabled while resetting.

Also check the trainer-side equivalent page (`TrainerCyclus.tsx` / `src/pages/TrainerCyclus.tsx`) for the same skipped summary block and add the button there too, to keep Trainer/Academy parity.

## Out of scope
No DB or planner changes. The reset just unblocks re-running the existing "Generate proposals" flow.