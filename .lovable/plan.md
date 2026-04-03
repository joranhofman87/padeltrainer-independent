

# Add Sorting to Intake Requests Table

## Change

Add sortable column headers for Name, Level (rating), Linked (yes/no), and Registration time (created_at) to the `IntakeRequestsTable`. Clicking a header cycles through ascending → descending → unsorted.

## Implementation

### `src/components/cycles/IntakeRequestsTable.tsx`

1. Import `useTableSort` hook and `SortableTableHead` component (both already exist in the codebase)
2. Instead of rendering `displayedRequests` directly, pass it through `useTableSort` to get `sortedData`
3. For the sort to work with "linked" as a virtual column, add a computed property: map each request to include a `_isLinked` boolean (derived from `playerLinks`) before sorting
4. Replace the four relevant `<TableHead>` elements with `<SortableTableHead>`:
   - **Player** (sort key: `full_name`) — keep sticky styling
   - **Rating** (sort key: `rating`)
   - **Linked** (sort key: `_isLinked`)
   - **Applied / Registration time** (sort key: `created_at`)
5. Apply sorting after search filtering but before rendering

### Sort key mapping

| Column | Sort key | Type |
|--------|----------|------|
| Player | `full_name` | string |
| Rating | `rating` | number |
| Linked | `_isLinked` | boolean |
| Applied | `created_at` | date string |

### Technical notes
- The `_isLinked` field will be computed in a `useMemo` that enriches `displayedRequests` with this boolean based on whether the request ID appears in `playerLinks`
- `useTableSort` already handles strings, numbers, booleans, and date strings
- `SortableTableHead` needs a small wrapper for the sticky Player column to preserve `className="sticky left-0 z-10 bg-background"`
- Other column headers remain plain `<TableHead>` (no sorting)

## Files

| File | Change |
|------|--------|
| `src/components/cycles/IntakeRequestsTable.tsx` | Add `useTableSort`, enrich rows with `_isLinked`, replace 4 headers with `SortableTableHead` |

