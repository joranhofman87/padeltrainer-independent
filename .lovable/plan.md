

# Fix: Sort Proposal Overview by Day Chronologically

## Problem
Trainer groups are sorted alphabetically by name (line 146). Within each trainer, days are stored in a `Map` that preserves insertion order rather than chronological order. The overview should show days sorted chronologically (Monday first, then Tuesday, etc.).

## Changes

### `src/pages/ProposalOverviewPage.tsx`

**Within each trainer group**, sort the days chronologically when rendering. The `days` Map keys are date strings (YYYY-MM-DD), so sorting by key gives chronological order.

On line 146, also sort trainer groups by their **earliest slot date** instead of alphabetically — so the trainer with the earliest session on Monday appears first, then the one starting on Tuesday, etc.

Concrete changes:
1. **Sort trainer groups by earliest date** (line 146): Replace `a.trainerName.localeCompare(b.trainerName)` with a comparison of each group's earliest date key
2. **Sort days within each trainer**: When iterating `group.days` for rendering, sort entries by date key (already lexicographic = chronological for YYYY-MM-DD format)

## Files

| File | Change |
|------|--------|
| `src/pages/ProposalOverviewPage.tsx` | Sort trainer groups by earliest date; sort day entries chronologically when rendering |

