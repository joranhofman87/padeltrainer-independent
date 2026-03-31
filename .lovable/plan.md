

# Add CSV Export for Registration Intake Requests

## Summary
Add a "Download CSV" button next to the "Add registration" button on both the Academy and Trainer intake requests pages. The CSV will contain all fields from the registration form for the currently filtered requests.

## CSV Columns
`Full Name`, `Email`, `Phone`, `Rating`, `Rating System`, `Lesson Type`, `Preferred Days`, `Preferred Time Windows`, `Duration (min)`, `Sessions/Week`, `Preferred Trainers`, `Notes`, `Status`, `Applied Date`

## Changes

| File | Change |
|------|--------|
| `src/lib/cycles.ts` | Add `exportIntakeRequestsToCsv(requests, trainers?)` utility function. Converts `IntakeRequestWithProposal[]` to CSV string, handles arrays (days, lesson types, time windows) by joining with semicolons. Triggers browser download. |
| `src/pages/academy/AcademyIntakeRequests.tsx` | Add `Download` icon button next to "Add registration" button. Calls the export utility with `filteredRequests` and trainer list. |
| `src/pages/TrainerIntakeRequests.tsx` | Same CSV export button added next to the existing action buttons. |

## Export Logic
- Uses `filteredRequests` (respects current cycle + status filter)
- Preferred time windows formatted as `"Mon 09:00-11:00; Wed 14:00-16:00"`
- Preferred trainer IDs resolved to names using the trainers list when available
- Lesson type array joined with semicolons
- UTF-8 BOM prefix for Excel compatibility
- Filename: `registrations-{cycle_name}-{date}.csv` or `registrations-all-{date}.csv`

