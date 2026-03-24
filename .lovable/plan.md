

# Fix: Guest Player Creation Fails from Academy Calendar

## Root Cause
When an academy manager opens the "Add Player" dialog from a slot (via `AddSlotDialog` or `BulkCreateSheet`), the `trainerId` can be `null` if no specific trainer is selected in the filter dropdown (`selectedTrainerId === "all"`). The `AddPlayerDialog` is never given an `academyId`.

This means the insert sends both `trainer_id: null` and `academy_profile_id: null`, which:
1. Violates the database CHECK constraint (`trainer_id IS NOT NULL OR academy_profile_id IS NOT NULL`)
2. Fails RLS because neither condition in the INSERT policy matches

## Fix

### 1. Pass `academyId` from `AcademyCalendar` to slot dialogs
**File: `src/pages/academy/AcademyCalendar.tsx`**

Pass `academyId={activeAcademy?.id}` as a new prop to both `AddSlotDialog` and `BulkCreateSheet`.

### 2. Accept and forward `academyId` in `AddSlotDialog` / `BulkCreateSheet`
**File: `src/components/trainer/AddSlotDialog.tsx`**

- Add `academyId?: string` to both component prop interfaces
- Forward it to `AddPlayerDialog`: `academyId={academyId}`

### 3. `AddPlayerDialog` already handles `academyId`
The dialog already accepts `academyId` and inserts it as `academy_profile_id`. No changes needed there.

## Files
- `src/pages/academy/AcademyCalendar.tsx` — Pass `academyId` to `AddSlotDialog` and `BulkCreateSheet`
- `src/components/trainer/AddSlotDialog.tsx` — Add `academyId` prop, forward to `AddPlayerDialog`

