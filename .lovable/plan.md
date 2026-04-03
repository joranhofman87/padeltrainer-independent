

# Add delete registration option on Step 1 (Registrations)

## What changes
Add a "Delete" button to the `IntakeRequestDetailSheet` that only appears when the sheet is opened from Step 1. Clicking it shows a confirmation dialog before permanently deleting the registration.

## How it works
- The `deleteIntakeRequest` function already exists in `src/lib/cycles.ts` — no backend changes needed.
- Pass a new `allowDelete` boolean prop to `IntakeRequestDetailSheet`. Only set it to `true` when `activeStep === 'registrations'`.
- In the detail sheet's action bar, add a destructive "Delete" button (with Trash icon) that opens an `AlertDialog` asking "Delete this registration? This action cannot be undone."
- On confirm: call `deleteIntakeRequest(request.id)`, show a success toast, close the sheet, and trigger `onStatusChange` to refresh the list.

## Files

| File | Change |
|------|--------|
| `src/components/cycles/IntakeRequestDetailSheet.tsx` | Add `allowDelete` prop, delete confirmation dialog, and delete handler using existing `deleteIntakeRequest` |
| `src/pages/academy/AcademyCycleDetail.tsx` | Pass `allowDelete={activeStep === 'registrations'}` to the detail sheet |

