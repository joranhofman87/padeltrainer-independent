

# Simplify Agenda: Remove Single Slot, Default to Cyclus

## Summary
Remove the intermediate "choose slot type" dialog. When adding to the agenda (button click or calendar cell click), go directly to the cyclus/bulk-create drawer. Remove single-slot creation entirely from trainer and academy calendars. Club calendar keeps its own separate flow unchanged.

## Changes

### 1. TrainerCalendar.tsx
- Remove `slotTypeChoiceOpen` state and `handleChooseSingleSlot` / `handleChooseCyclus` functions
- Remove `addSlotOpen` state (single slot dialog)
- Change `handleCellClick` and "Add Slot" button to directly open `setBulkCreateOpen(true)` (with date/time defaults)
- Remove `<SlotTypeChoiceDialog>` and `<AddSlotDialog>` from JSX
- Keep `<BulkCreateSheet>` — this is the cyclus drawer
- Remove import of `SlotTypeChoiceDialog` and `AddSlotDialog`

### 2. AcademyCalendar.tsx
- Same pattern: remove `slotTypeChoiceOpen`, `addSlotOpen` states
- Change "Add Slot" button and cell click to open `setBulkCreateOpen(true)` directly
- Remove `<SlotTypeChoiceDialog>` and `<AddSlotDialog>` from JSX
- Remove imports

### 3. Delete SlotTypeChoiceDialog.tsx
- `src/components/trainer/SlotTypeChoiceDialog.tsx` — no longer needed

### 4. Clean up AddSlotDialog (optional)
- If `AddSlotDialog` is only used for single-slot creation and no other page imports it, remove it from `src/components/trainer/AddSlotDialog.tsx` (keep `BulkCreateSheet` export)

| File | Change |
|------|--------|
| `src/pages/TrainerCalendar.tsx` | Skip choice dialog, open cyclus drawer directly |
| `src/pages/academy/AcademyCalendar.tsx` | Same |
| `src/components/trainer/SlotTypeChoiceDialog.tsx` | Delete file |
| `src/components/trainer/AddSlotDialog.tsx` | Remove single-slot `AddSlotDialog` export if unused elsewhere |

