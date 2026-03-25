

# Fix: Extra Costs Missing from Invoices After Cycle Edit

## Problem
When editing a cycle in Schedule Overview (adding extra costs like "Baanhuur PAZ avond €36" and enabling split payment), the existing invoice only gets its session line items split. The newly added extra costs are never added to the invoice because:

1. `handleSaveCycleEdit` saves extra costs to `availability_slots` and cycle settings ✓
2. But it never updates the **line items** of existing unpaid invoices to include those costs
3. `split-invoice` only splits whatever line items already exist on the invoice

## Solution
Add a step in `handleSaveCycleEdit` that **recalculates existing unpaid invoices** when extra costs change, adding missing extra cost line items before any split happens.

## Changes

### `src/pages/TrainerScheduleOverview.tsx` — `handleSaveCycleEdit`

Insert new logic **after slot updates (step 3) but before split payment (step 4)** (~line 575):

- Query unpaid invoices linked to this cycle's bookings (same query pattern already used in step 4)
- For each invoice, compare its line items against the current `cycleEditData.extraCosts`
- Remove old extra cost line items (non-session items) and re-add from current cycle settings
- Recalculate subtotal/vat/total
- Update the invoice (with `pdf_url: null` to force PDF regeneration)

This ensures that by the time `split-invoice` runs (if enabled), the invoice already contains the correct extra cost line items.

### Key logic
```text
For each unpaid invoice on this cycle:
  1. Keep session line items (first item, the one with qty = booking count)
  2. Remove any existing extra cost line items  
  3. Re-add extra costs from cycleEditData.extraCosts
  4. Recalculate totals respecting prices_include_vat
  5. Update invoice in DB
```

| File | Change |
|------|--------|
| `src/pages/TrainerScheduleOverview.tsx` | Add invoice extra-cost sync step in `handleSaveCycleEdit` between step 3 and step 4 |

