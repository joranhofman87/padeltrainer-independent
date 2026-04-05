

# Remove Contract Type (Exclusivity) from UI

## Problem
The "exclusive / non-exclusive" contract type selector adds complexity without clear value. It appears in several places but has no business logic depending on it — it's purely a display label.

## Impact Analysis
No dependencies beyond display. The `contract_type` column exists on `academy_locations` but nothing in the backend (RLS, triggers, edge functions) checks it. It's safe to remove from UI while leaving the DB column untouched.

## Places to clean up

| File | What to remove |
|------|----------------|
| `src/components/academy/AddAcademyLocationDialog.tsx` | Remove `contractType` state, the Select dropdown, and the hint text. Stop passing `contractType` to `addAcademyLocation()` (just use default). |
| `src/components/academy/EditAcademyLocationDialog.tsx` | Remove `contractType` state and the Select dropdown from the form. Remove `contract_type` from the update payload. |
| `src/pages/academy/AcademyLocations.tsx` | Remove the "exclusive/non-exclusive" Badge from the location card. |
| `src/pages/AcademyPublicProfile.tsx` | Remove the "Exclusive" badge that shows when `contract_type === 'exclusive'`. |
| `src/components/admin/AcademyEditDialog.tsx` | Remove `contract_type` from the insert payload (line 487). |
| `src/lib/academy.ts` | Remove `contractType` parameter from `addAcademyLocation()` signature, hardcode `'non_exclusive'` as default. Remove `contract_type` from `updateAcademyLocation()` updates type. Keep the DB column as-is. |

No database migration needed — the column stays, we just stop reading/writing it in the UI.

