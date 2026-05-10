## Goal

Clean up the agenda Day view's top toolbar by:

1. **Removing** the top "Search player…" input and the standalone "Players" toggle button (lines 585-613 in `src/components/academy/AcademyDayGrid.tsx`).
2. **Moving the collapse toggle into the All Players panel** on the right (its header), so it visually belongs to that panel.
3. Keeping a small **"open" affordance** when the panel is collapsed, so users can reopen it.

## Plan

In `src/components/academy/AcademyDayGrid.tsx`:

1. Delete the entire top toolbar block (`{/* Search bar */}` div, lines 585-613). Remove the now-unused `searchQuery`, `setSearchQuery` state and the `searchQuery` prop drilling into `SlotCard` (`SlotCard` already treats it as optional, no functional impact since it only powered highlight matching from the now-removed input).

2. In the All Players sidebar header (lines 717-735), add a `PanelRightClose` icon button on the right of the header row that calls `setSidebarOpen(false)`. The header row becomes: title + count Badge on the left, collapse icon button on the right. The existing search input inside the panel stays (that's the per-panel search).

3. When `sidebarOpen` is `false`, render a thin vertical "open" tab anchored to the right edge of the agenda area (a small button with `PanelRightOpen` icon and the "Players" label vertically or as tooltip). Use `md:flex hidden` to match the panel's responsive behavior. Click → `setSidebarOpen(true)`.

4. Remove now-unused imports if any (`Search` icon stays — still used inside the sidebar; `PanelRightClose`/`PanelRightOpen` stay).

## Out of scope

- Mobile view of the sidebar (it remains hidden on `<md`, same as today).
- Restyling the All Players panel beyond the header row.
- Any logic change to drag/drop or filtering.

## Files to edit

- `src/components/academy/AcademyDayGrid.tsx`
