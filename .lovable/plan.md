

# Add "Linked Players" Column to CSV Export

## Summary
Add a column to the CSV export showing the names of players each registration is linked to (via admin/trainer connections).

## Change

**File: `src/lib/cycles.ts`**

Update `exportIntakeRequestsToCsv` to accept a `playerLinks` parameter (`PlayerLink[]`):

1. Add `"Linked Players"` header after `"Status"` (before `"Applied Date"`)
2. Group `playerLinks` by `link_group` to find which requests share a group
3. For each request, find linked partners via shared `link_group`, look up their names from `requests`, and join with `; `
4. Empty string if no links exist

**Files: `AcademyIntakeRequests.tsx` + `TrainerIntakeRequests.tsx`**

Pass `playerLinksData` as third argument to `exportIntakeRequestsToCsv`.

Update the function signature:
```ts
export function exportIntakeRequestsToCsv(
  requests: IntakeRequestWithProposal[],
  filename: string,
  trainerMap?: Record<string, string>,
  playerLinks?: PlayerLink[],
)
```

## Files Changed

| File | Change |
|------|--------|
| `src/lib/cycles.ts` | Add `playerLinks` param, add "Linked Players" column with partner names |
| `src/pages/academy/AcademyIntakeRequests.tsx` | Pass `playerLinksData` to export call |
| `src/pages/TrainerIntakeRequests.tsx` | Pass `playerLinksData` to export call |

