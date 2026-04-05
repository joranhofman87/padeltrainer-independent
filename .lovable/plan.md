

# Remove "All Slots" Tab + Add Bulk Actions to Cycles Tab

## What changes

### 1. `src/pages/academy/AcademyCalendar.tsx`
- Remove `"open-spots"` from the `TabValue` type
- Remove the lazy import of `AcademyOpenSlotsContent` (line 52)
- Remove the `<TabsTrigger value="open-spots">` (lines 650-653)
- Remove the `<TabsContent value="open-spots">` block (lines 716-721)
- Remove the `Eye` icon import (no longer needed for tabs — check if used elsewhere first)

### 2. `src/pages/academy/AcademyDashboard.tsx`
- Change `navigate('/app/academy/calendar?tab=open-spots')` → `navigate('/app/academy/calendar?tab=cycles')` (line 472)

### 3. `src/components/DomainRouter.tsx`
- Change the redirect on line 304 from `?tab=open-spots` to `?tab=cycles`

### 4. `src/pages/academy/AcademyOpenSlots.tsx`
- **Delete this file** — no longer referenced

### 5. `src/pages/academy/AcademyCyclusOverview.tsx` — Add bulk actions
Port the useful bulk features from the deleted All Slots page:
- **Checkbox column** — Add `selectedIds` state and a checkbox on each row + "select all" in header
- **Bulk action bar** — When items are selected, show a floating/sticky bar with:
  - **Bulk visibility toggle** — Update `is_public` on all `availability_slots` belonging to selected cycles
  - **Bulk price update** — Open a dialog to set `price_per_session` on all slots of selected cycles (+ sync invoices via `syncInvoicesAfterPriceChange`)
- Import `Checkbox`, `Switch`, `Dialog`, `useToast`, and `syncInvoicesAfterPriceChange` from existing locations
- Add `setBulkPrice` dialog state, `bulkUpdating` loading state
- The bulk update function: fetch all slot IDs for selected `cyclus_id`s, then batch-update them

## File summary

| File | Change |
|------|--------|
| `src/pages/academy/AcademyCalendar.tsx` | Remove open-spots tab, trigger, content, and lazy import |
| `src/pages/academy/AcademyDashboard.tsx` | Update "View all" link to `?tab=cycles` |
| `src/components/DomainRouter.tsx` | Update redirect from `open-spots` to `cycles` |
| `src/pages/academy/AcademyOpenSlots.tsx` | Delete file |
| `src/pages/academy/AcademyCyclusOverview.tsx` | Add bulk select, bulk visibility toggle, bulk price update |

