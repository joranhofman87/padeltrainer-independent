

# Add Player Name Search to Intake Requests Table

## Change

Add a search input above the table (next to the existing "Columns" button) that filters rows by player name in real time.

## Implementation

### `src/components/cycles/IntakeRequestsTable.tsx`

1. Add a `searchQuery` state (`useState('')`)
2. Add a `Search` icon import from lucide-react and use the existing `Input` component
3. Filter `requests` by `full_name` (case-insensitive includes) before rendering the table rows
4. Place the search input in the toolbar row (line ~494), to the left of the Columns button, using a flex layout with the input taking available space

The search filters only the displayed rows — it does not affect suggestion computation or the empty state check (which stays based on unfiltered `requests.length`).

### Files

| File | Change |
|------|--------|
| `src/components/cycles/IntakeRequestsTable.tsx` | Add search state, input field in toolbar, filter rows by name |

