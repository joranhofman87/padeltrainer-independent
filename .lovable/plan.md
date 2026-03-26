

# Fix: Session Price Change Not Synced to Invoices

## Problem

When editing a cyclus in Schedule Overview, the session price updates on the `availability_slots` table correctly (line 440), but the invoice sync logic (section 3b, line 690-696) keeps the **old** session line item from the invoice as-is. It only rebuilds extra cost line items. So deleting extra costs is reflected, but the session price change is not.

## Root Cause

Line 694-696:
```typescript
const sessionItems = existingItems.filter(
  (_item: any, idx: number) => idx === 0
);
```

This preserves the first line item (session item) with its **old** `unit_price`. It never applies the new `cycleEditData.pricePerSession` to it.

## Fix

**File**: `src/pages/TrainerScheduleOverview.tsx` (lines 694-696)

After filtering the session item, update its `unit_price` and `amount` if the session price was changed:

```typescript
const sessionItems = existingItems.filter(
  (_item: any, idx: number) => idx === 0
).map((item: any) => {
  // Update session line item price if changed
  if (cycleEditData.pricePerSession !== "") {
    const newPrice = parseFloat(cycleEditData.pricePerSession);
    return {
      ...item,
      unit_price: newPrice,
      amount: item.quantity * newPrice,
    };
  }
  return item;
});
```

This ensures the session line item's price is updated before recalculating totals.

## Data Fix

After deploying, invoke `recalculate-invoices` for INV-2026-0003 to correct its current totals from the stored (now-correct) line items. Or: since the line items still have the old price, we should re-save the cyclus after deploying to trigger the sync again.

| File | Change |
|------|--------|
| `src/pages/TrainerScheduleOverview.tsx` | Lines 694-696: Update session item's `unit_price` with new price from `cycleEditData.pricePerSession` |

