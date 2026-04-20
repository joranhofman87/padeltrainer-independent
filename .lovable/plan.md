

## Goal
When a registration's enrollment deadline has passed (but cycle status is still `open`), keep the form open and let people apply as a **waiting list** entry instead of blocking them. Show a clear notice that the deadline is overdue and they will be added to the waiting list.

When the cycle is **fully closed** (`status !== 'open'`), keep the current behavior (form closed) since the trainer/academy intentionally closed it.

## Changes

### 1. Public registration pages — show banner + keep form open
**`src/pages/CycleRegistration.tsx`** and **`src/pages/BrandedCycleRegistration.tsx`**
- Change `canApply` so deadline-passed no longer blocks: `canApply = !isEnrollmentClosed && !hasApplied`
- Replace the destructive "deadline passed" alert with an informational warning ("Deadline is verstreken — je aanmelding komt op de wachtlijst")
- Keep the destructive "enrollment closed" alert as-is (truly closed cycles stay blocked)

### 2. Application modal — same treatment
**`src/components/cycles/CycleApplicationModal.tsx`**
- Only short-circuit (block form) when `isCycleClosed`, not when only `isDeadlinePassed`
- When deadline passed but cycle open: render the form with a warning banner above it

### 3. Trainer/Academy/Location open-cycles cards — allow Apply button
**`src/components/trainer/TrainerOpenCycles.tsx`**, **`src/components/academy/AcademyOpenCycles.tsx`**, **`src/components/club/LocationOpenCycles.tsx`**
- `canApply = !hasApplied` (drop deadlinePassed gate)
- Replace destructive "Deadline passed" badge with a neutral "Wachtlijst" / "Waiting list" badge
- Apply button label switches to "Aanmelden voor wachtlijst" when deadline passed

### 4. Mark waitlist applications in the database
In **`CycleApplicationForm`** submission (or modal/page handler): when `isDeadlinePassed && !isCycleClosed`, set a flag on the inserted application — reuse existing `notes` prefix or add `is_waitlist: true` if such a column exists. We'll inspect `CycleApplicationForm` and `cycle_applications` schema during implementation; if no column exists, prepend `[WACHTLIJST]` to notes so trainers see it immediately in the registration list.

### 5. Translations
Add new keys to all 6 locale `cycles.json` files under `application`:
- `deadlinePassedWaitlist`: e.g. NL "De deadline is verstreken — je wordt op de wachtlijst geplaatst." / EN "The deadline has passed — you'll be added to the waiting list."
- `waitlistBadge`: NL "Wachtlijst" / EN "Waiting list"
- `applyWaitlist`: NL "Aanmelden voor wachtlijst" / EN "Join waiting list"

## Out of scope
- Trainer/academy management UI for waitlist filtering (a separate "show waitlisted applicants" view). Can be follow-up if you want it.

## Files touched
- `src/pages/CycleRegistration.tsx`
- `src/pages/BrandedCycleRegistration.tsx`
- `src/components/cycles/CycleApplicationModal.tsx`
- `src/components/cycles/CycleApplicationForm.tsx` (mark waitlist on submit)
- `src/components/trainer/TrainerOpenCycles.tsx`
- `src/components/academy/AcademyOpenCycles.tsx`
- `src/components/club/LocationOpenCycles.tsx`
- `src/i18n/locales/{en,nl,es,de,fr,it}/cycles.json`

