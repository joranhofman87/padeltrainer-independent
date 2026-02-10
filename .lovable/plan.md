

## Add "Mark as Paid" Option to Training Cycle Form

### What this does

When creating or editing a training cycle (cyclus), trainers and academy managers will see a new "Mark as paid" toggle. When enabled, this flag is saved on the cycle so that any bookings created for this cycle (via the calendar slot creation flow or duplication) are automatically marked as paid externally.

### Changes

#### 1. `src/lib/cycles.ts` - Add `mark_as_paid` to CycleSettings type

Add `mark_as_paid?: boolean` to the `CycleSettings` interface so it's stored in the cycle's settings JSON.

#### 2. `src/components/cycles/CycleForm.tsx` - Add the toggle UI + persist it

- Add a `markAsPaid` state variable (similar to `allowSingleBooking`), initialized from `cycle?.settings?.mark_as_paid`
- Reset it when the form opens (in the existing `useEffect`)
- Include `mark_as_paid: markAsPaid` in the `settings` object in `onSubmit`
- Add a toggle UI (checkbox with Euro icon) in the pricing section, after the "Allow single booking" toggle, only for `cyclus` type (not `registration`). Use the same visual pattern as `AddSlotDialog` and `DuplicateCyclusDialog`:

```text
[checkbox] [Euro icon] Mark as paid
            Payment was handled outside the platform (e.g. cash, bank transfer)
```

#### 3. `src/components/trainer/AddSlotDialog.tsx` - Read cycle's mark_as_paid setting

When creating a cyclus via `AddSlotDialog`, if the cycle has `mark_as_paid` in settings, pre-fill the `markAsPaid` field on the slot config so bookings inherit the paid status automatically. (This is already handled per-slot; the cycle setting just provides a default.)

#### 4. Translation files (already have the keys)

The existing keys `calendar.markAsPaid` and `calendar.markAsPaidHint` in both `en/trainer.json` and `nl/trainer.json` will be reused.

### Files to modify

- `src/lib/cycles.ts` (add 1 field to CycleSettings interface)
- `src/components/cycles/CycleForm.tsx` (add state, toggle UI, persist in settings)
- `src/components/trainer/AddSlotDialog.tsx` (read cycle's mark_as_paid as default for slot bookings)

