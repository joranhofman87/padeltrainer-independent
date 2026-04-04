

# Add Slot Edit/Delete Actions to Manage Tab

## Problem
The Manage tab's slot cards have no way to edit slot details (time, day, trainer, max participants, location, rating) or delete slots/cyclus. Users can only drag-and-drop players but can't manage the slots themselves.

## Changes

### 1. AcademyDayGrid.tsx — Add edit slot button + wire `onEditSlot` prop

| What | Detail |
|------|--------|
| New prop | `onEditSlot?: (slot: SlotWithBookings) => void` |
| SlotCard UI | Add a pencil (Edit) icon button and a Trash icon button in the slot card header (next to the existing UserPlus button), visible on hover. Edit opens the EditSlotDialog; Delete triggers the existing `onDeleteSlot`. |
| Pass through | Wire `onEditSlot` from props into each `SlotCard` |

### 2. AcademyCalendar.tsx — Add EditSlotDialog state + handler

- Import `EditSlotDialog`
- Add state: `editSlotOpen`, `slotToEdit`
- Add handler `handleEditSlot` that sets the slot and opens the dialog
- Render `<EditSlotDialog>` in the dialogs section
- Pass `onEditSlot={handleEditSlot}` to `AcademyDayGrid`

### 3. EditSlotDialog.tsx — Extend with location, trainer, max participants

The existing dialog only edits time, date, duration, rating, and cyclus name. Extend it with:

- **Trainer selector** (dropdown of available trainers, passed as new prop)
- **Location selector** (dropdown of available locations, passed as new prop)
- **Max participants** (number input)
- **Mark as full** toggle
- Save updates these fields to `availability_slots` alongside the existing fields
- "Apply to cyclus" checkbox also applies trainer/location/max_participants changes to all future slots

### 4. DeleteSlotDialog — Already exists and is wired

The `onDeleteSlot` prop already exists on `AcademyDayGrid` and is already wired to `handleDeleteSlot` in `AcademyCalendar.tsx`. The Trash button just needs to be added to the SlotCard UI.

## File summary

| File | Change |
|------|--------|
| `src/components/academy/AcademyDayGrid.tsx` | Add `onEditSlot` prop, add Edit + Delete icon buttons to SlotCard header |
| `src/pages/academy/AcademyCalendar.tsx` | Import EditSlotDialog, add state/handler, render dialog, pass `onEditSlot` to AcademyDayGrid |
| `src/components/trainer/EditSlotDialog.tsx` | Add optional `trainers` and `locations` props, add trainer/location/maxParticipants/markedFull fields to the form and save logic |

