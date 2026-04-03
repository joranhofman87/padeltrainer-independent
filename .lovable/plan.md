

# Always Show Unplaced Sidebar as Drop Target

## Problem
The unplaced sidebar only renders when `unplacedPlayers.length > 0` (line 1606). When all players are placed, the sidebar disappears entirely — meaning there's no drop target to drag players back to. The drag-to-unplace logic already exists in `handleDragEnd` (lines 1403-1412), it just needs a visible drop zone.

## Change

### `src/components/cycles/ProposalScheduleGrid.tsx`

**Line 1606** — Remove the `unplacedPlayers.length > 0` condition so the sidebar always renders. The "All players are placed" empty state message (line 1658) already handles the case when the list is empty, so this just needs the outer condition relaxed.

Change:
```tsx
// Before
{unplacedPlayers && unplacedPlayers.length > 0 && (
// After
{unplacedPlayers && (
```

This ensures the `DroppableUnplacedPool` is always mounted as a valid drop target, so dragging a player chip from a slot onto the sidebar will trigger the existing unassign logic.

## Files

| File | Change |
|------|--------|
| `src/components/cycles/ProposalScheduleGrid.tsx` | Line 1606: remove `.length > 0` so sidebar always shows |

