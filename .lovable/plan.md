

# Add Privacy Toggle + Fix Edit Navigation in Schedule Overview

## What
1. Add per-slot privacy toggle (lock/unlock icon) on the overview page to mark/unmark individual slots as private (`is_marked_full`)
2. Add a privacy toggle in the cycle edit dialog to bulk-toggle all slots in a cycle
3. Fix the slot edit button URL (currently goes to `/trainer/calendar` instead of `/app/trainer/calendar`)
4. Also fetch `is_marked_full` in the overview query and use it for the "Private" badge (currently uses `is_public` which is a creation-time field, while `is_marked_full` is the manual trainer toggle)

## Changes

### 1. `src/pages/TrainerScheduleOverview.tsx`

**Query & type** — Add `is_marked_full` to the select query and `SlotWithBookings` type.

**Fix edit navigation** (line 514) — Change `/trainer/calendar?date=...` to `/app/trainer/calendar?date=...`.

**Per-slot privacy toggle** — Add a Lock/LockOpen icon button on each slot row. Clicking it toggles `is_marked_full` on that single slot via supabase update, then invalidates the query.

**Private badge** — Show "Private" badge when `is_marked_full` is true (instead of `!is_public`).

**Cycle edit dialog** — Add a Switch for "Mark as private" that bulk-updates `is_marked_full` on all slots with the cycle's `cyclus_id`. Pre-fill from first slot's `is_marked_full` value.

**Add handler** `handleToggleSlotPrivacy(slotId, currentValue)` — updates single slot's `is_marked_full`, invalidates query.

**State** — Add `togglingPrivacy` state to track loading per slot. Add `isPrivate` field to `CycleEditData`.

### 2. Translation keys (`en/trainer.json`, `nl/trainer.json`)

Add under `scheduleOverview`:
- `markAsPrivate`: "Mark as private" / "Markeer als privé"
- `markAsPublic`: "Mark as public" / "Markeer als openbaar"
- `cyclePrivate`: "Private (hidden from players)" / "Privé (verborgen voor spelers)"

### Files
- `src/pages/TrainerScheduleOverview.tsx`
- `src/i18n/locales/en/trainer.json`
- `src/i18n/locales/nl/trainer.json`

