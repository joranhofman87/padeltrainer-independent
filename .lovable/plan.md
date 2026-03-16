

## Show Rating Decimals (e.g. 4.2 instead of 4)

### Problem
When a player's KNLTB rating is a whole number (e.g. `4.0`), JavaScript renders it as `4` — hiding the decimal that matters. Ratings like 4.1 vs 4.9 have very different skill implications. All rating displays should consistently show at least one decimal place.

### Changes

**`src/components/cycles/ProposalScheduleGrid.tsx`**

Add a helper function to format ratings with 1 decimal:
```ts
function formatRating(r: number): string {
  return r.toFixed(1);
}
```

Apply it everywhere ratings are rendered (approximately 8 locations):
- Player chips: `{assignment.player_rating}` → `{formatRating(assignment.player_rating)}`
- Popover player list ratings
- Tooltip out-of-range messages (rating, min, max values)
- Slot rating range indicator: `{slot.min_rating}–{slot.max_rating}`
- Unplaced player badges and drag overlay
- DraggablePlayerChipOverlay rating display

**`src/lib/ratingSystems.ts`**
- Update `formatRatingWithSystem` — currently uses 4 decimals for KNLTB, change to 1 decimal for all systems (consistent display)

**No changes to matching logic** — the edge function already compares exact numeric values without rounding, which is correct.

### Files to modify
- `src/components/cycles/ProposalScheduleGrid.tsx`
- `src/lib/ratingSystems.ts`

