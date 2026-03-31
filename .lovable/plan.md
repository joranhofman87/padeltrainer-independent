

# Add Missing Fields to CSV Export

## Summary
The CSV export is missing several fields that players fill out during registration. These fields exist in the database and are already fetched — they just need to be added to the CSV output.

## Missing Fields

| Field | In DB | In CSV | Action |
|-------|-------|--------|--------|
| Birth Date | ✅ `birth_date` | ❌ | Add column |
| Location | ✅ `location_id` | ❌ | Add column (resolve name from cycles/locations) |
| Selected Package | ✅ `metadata.selected_cyclus_option` | ❌ | Add column (label + price) |
| Preferred Weeks | ✅ `metadata.preferred_number_of_weeks` | ❌ | Add column |

All other form fields (name, email, phone, rating, rating system, lesson type, duration, sessions/week, preferred trainer, notes, availability days) are already in the CSV.

## Changes

**File: `src/lib/cycles.ts`** — `exportIntakeRequestsToCsv`

Add 4 new columns to the headers and row mapping:
- **"Birth Date"** — formatted from `r.birth_date`
- **"Location"** — resolved from `location_id` (pass location map as parameter, or extract from metadata)
- **"Package"** — from `r.metadata?.selected_cyclus_option?.label`
- **"Preferred Weeks"** — from `r.metadata?.preferred_number_of_weeks`

**Files: `AcademyIntakeRequests.tsx` + `TrainerIntakeRequests.tsx`**

Pass a location name map (built from the cycles' location data already loaded) to the export function.

**File: `src/lib/cycles.ts`** — `IntakeRequest` interface

Add `birth_date: string | null` to the interface so TypeScript is aware of it (it's already returned at runtime).

## Files Changed

| File | Change |
|------|--------|
| `src/lib/cycles.ts` | Add `birth_date` to interface; add 4 new CSV columns; accept optional `locationMap` param |
| `AcademyIntakeRequests.tsx` | Pass location map to export |
| `TrainerIntakeRequests.tsx` | Pass location map to export |

