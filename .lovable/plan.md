

# Fix Line Item Display on Public Invoice Page

## Problem
The line item amount shows €0,00 because the code uses `item.total` which may not be stored per line item. The actual price is in `item.unit_price`. Additionally, the unit price column is missing — the HTML invoice template shows 4 columns (Description, Qty, Price, Amount) but the public page only shows 3.

## Changes

### File: `src/pages/PublicInvoicePay.tsx`

1. **Add unit price column** to the line items table — match the HTML invoice layout with Description, Qty, Price, Amount
2. **Fix amount calculation** — use `item.total ?? (item.quantity * item.unit_price)` as fallback since `total` may not be stored per line item
3. Show unit price per item: `€{formatEuro(item.unit_price)}`
4. Show computed total: `€{formatEuro(item.total ?? item.quantity * item.unit_price)}`

The table header becomes:
```
Description | Qty | Price | Amount
```

Single file change, ~10 lines modified in the table section (lines 303-321).

