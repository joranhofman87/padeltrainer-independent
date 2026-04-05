

# Add Sorting & Status Filter to Invoice Table

## Changes

### `src/pages/academy/AcademyInvoices.tsx`

1. **Add `useTableSort` hook** — Import and use it on `filteredInvoices` with sortable keys: `total`, `due_date`, `status`

2. **Add status filter** — New `statusFilter` state (`all`, `draft`, `sent`, `overdue`, `paid`, `cancelled`). Add a `Select` dropdown next to the existing trainer/location/search filters. Apply the filter in the filtering chain before search.

3. **Replace static `TableHead`s with `SortableTableHead`** — For the Amount, Due Date, and Status columns. Keep Number, Player, Date, and Actions as regular `TableHead`.

4. **Derive computed status for sorting** — The `getStatusBadge` logic computes overdue dynamically. Add a `computedStatus` getter so sorting works correctly on the actual displayed status (draft/sent/overdue/paid).

5. **Update the tab structure** — Currently the page splits into "unpaid" and "paid" tabs. The new status filter replaces this split. Change the inner tabs to show all invoices in one view, with the status filter dropdown controlling what's visible. Keep the unpaid/paid tabs but add the status filter as an additional refinement within each tab.

6. **Update `colSpan`** for empty state if needed.

### Implementation detail

```typescript
// Add to imports
import { useTableSort } from "@/hooks/useTableSort";
import { SortableTableHead } from "@/components/admin/SortableTableHead";

// Compute status for each invoice for sorting
const getComputedStatus = (inv: Invoice) => {
  if (inv.status === "paid") return "paid";
  if (inv.status === "cancelled") return "cancelled";
  if (inv.sent_at && new Date(inv.due_date) < new Date()) return "overdue";
  if (inv.sent_at) return "sent";
  return "draft";
};

// Add status filter state
const [statusFilter, setStatusFilter] = useState("all");

// Apply status filter in the chain
const statusFiltered = statusFilter === "all"
  ? tabFiltered
  : tabFiltered.filter(i => getComputedStatus(i) === statusFilter);

// Then apply search on statusFiltered
const searchFiltered = statusFiltered.filter(i => ...);

// Apply sorting
const { sortedData, sortConfig, handleSort } = useTableSort(searchFiltered);

// Use sortedData to render table rows
```

Desktop table headers become:
```
Number | Player | Date | Due ↕ | Amount ↕ | Status ↕ | Actions
```

Status filter dropdown placed alongside the existing trainer/location filters.

## File summary

| File | Change |
|------|--------|
| `src/pages/academy/AcademyInvoices.tsx` | Add `useTableSort`, `SortableTableHead` for amount/due date/status columns; add status filter dropdown |

