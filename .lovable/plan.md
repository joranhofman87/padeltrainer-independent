

# Add "remove player" button in slot edit popover

## What changes
Add an X/remove button next to each player in the slot edit popover. Clicking it calls `onUnassignPlayer` to move the player back to the unplaced pool.

## How it works
- Each player row in the edit popover gets a small red X button on the right side
- Clicking it calls the existing `onUnassignPlayer(assignmentId)` handler — same logic as drag-to-unplaced
- The popover stays open after removing a player so you can remove multiple players in one go

## Files

| File | Change |
|------|--------|
| `src/components/cycles/ProposalScheduleGrid.tsx` | Add `onUnassignPlayer` prop to `SlotEditPopover`, render a remove button (X icon) next to each player row that calls `onUnassignPlayer(a.id)` |

## Detail
In the `SlotEditPopover` component (~line 255):
- Add `onUnassignPlayer?: (assignmentId: string) => void` to props
- In the player list (lines 449-476), add a small `X` button after the confidence score that calls `onUnassignPlayer(a.id)` with `e.stopPropagation()` to avoid triggering the player detail click
- Where `SlotEditPopover` is rendered in the grid, pass through the existing `onUnassignPlayer` prop

