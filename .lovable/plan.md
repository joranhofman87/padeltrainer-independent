

# Auto-Open Edit Mode on Slot Detail Page

## Problem
When clicking a slot, the detail page opens in read-only mode. The user must click "Edit" to start editing — an unnecessary extra step.

## Change

### `src/pages/academy/AcademySlotDetail.tsx`

**Auto-trigger edit mode once slot data loads.** The page already has `startEditing()` which populates all edit fields from `detail`. Simply call it automatically after data loads instead of waiting for a button click.

1. **Add auto-edit trigger** — In the existing `useEffect` or after `detail` is set, call `startEditing()` automatically on first load:
   ```typescript
   // Add a ref to track if we've auto-started editing
   const autoEditTriggered = useRef(false);
   
   useEffect(() => {
     if (detail && !autoEditTriggered.current) {
       autoEditTriggered.current = true;
       startEditing();
     }
   }, [detail]);
   ```

2. **Keep the Edit/Delete buttons visible** — The current UI hides them when `isEditing` is true. Keep the Delete button always visible (move it to the header or keep it in the action bar). The Edit button can be hidden since we're already in edit mode.

3. **No other files change** — The navigation from `AcademyCalendar.tsx` and `AcademyOpenSlots.tsx` stays the same.

## File summary

| File | Change |
|------|--------|
| `src/pages/academy/AcademySlotDetail.tsx` | Auto-call `startEditing()` on load, keep Delete button visible during edit mode |

