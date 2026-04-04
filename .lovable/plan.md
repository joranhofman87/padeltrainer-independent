

# Redesign Open Spots Tab: Table View with Filters + Bulk Edit

## Summary
Replace the current collapsible card layout on the Open Spots tab with a sortable table of all slots. Add filter dropdowns at the top (trainer, location, cyclus, visibility). Add checkbox-based bulk selection with a bulk edit toolbar for updating price, visibility, and other fields across multiple slots at once.

## Changes

### 1. `src/pages/academy/AcademyOpenSlots.tsx` — Full rewrite

**Data fetching**: Keep the existing query but flatten all slots into a single array (no cyclus grouping). Add trainer info to each row by joining `trainer_id` to the academy trainers list.

**Table columns**:
| Date/Time | Cyclus | Trainer | Location | Spots | Price | Public | Actions |
|-----------|--------|---------|----------|-------|-------|--------|---------|

- Date/Time: formatted start-end
- Cyclus: cyclus_name or "—"
- Trainer: name
- Location: name
- Spots: available/max
- Price: price_per_session (€)
- Public: switch toggle (inline, same as current)
- Actions: click row → navigate to slot detail

**Filters** (above table):
- Trainer dropdown (from academy trainers)
- Location dropdown (from academy locations)
- Cyclus dropdown (unique cyclus names from fetched data)
- Visibility: All / Public / Hidden

**Sortable headers** using existing `useTableSort` + `SortableTableHead`.

**Bulk selection**:
- Checkbox column on left
- "Select all" checkbox in header
- When ≥1 selected, show a sticky toolbar with:
  - Count label: "X slots selected"
  - "Set price" — opens a small popover/dialog to set `price_per_session` for all selected
  - "Set visibility" — toggle public/hidden for all selected
  - "Deselect all" button

### 2. Bulk price update logic

When "Set price" is confirmed:
1. Update `availability_slots` set `price_per_session = X` where `id in (selectedIds)`
2. Call `syncInvoicesAfterPriceChange(selectedIds)` to update unpaid invoices
3. Refresh the table
4. Show toast with count of updated slots

### 3. Wire into `AcademyCalendar.tsx`

No changes needed — already lazy-loads `AcademyOpenSlotsContent` with `embedded={true}`.

## Technical details

- Reuse `useTableSort` hook for column sorting
- Reuse `SortableTableHead` component for sort indicators
- Fetch `price_per_session`, `trainer_id` + trainer name, and `is_public` in the query
- Bulk update uses a single `.update().in('id', ids)` call
- Invoice sync after bulk price change uses existing `syncInvoicesAfterPriceChange`

## File summary

| File | Change |
|------|--------|
| `src/pages/academy/AcademyOpenSlots.tsx` | Rewrite: table layout, filters, sortable columns, bulk selection + bulk edit toolbar |

