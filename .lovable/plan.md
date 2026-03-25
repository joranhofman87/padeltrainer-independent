

# Fix: Draft Invoices Not Updated on Slot Deletion

## Root Cause
`DeleteSlotDialog.checkAffectedInvoices` (line 124) queries invoices with status filter `["sent", "paid", "pending"]` — but **"draft" is missing**. Both Nick's and Joran's invoices (INV-2026-0054 and INV-2026-0055) have status "draft", so the dialog never finds them and never triggers recalculation.

The shared utility `invoiceSync.ts` (line 247) already includes "draft" correctly — the bug is only in the dialog's preview/check query.

## Plan

### 1. Fix status filter in DeleteSlotDialog (1 line)
**File:** `src/components/trainer/DeleteSlotDialog.tsx`, line 124

Change:
```typescript
.in("status", ["sent", "paid", "pending"])
```
To:
```typescript
.in("status", ["draft", "sent", "paid", "pending"])
```

### 2. Manually fix INV-2026-0054 and INV-2026-0055 (data patch)
Remove the deleted booking IDs and recalculate for 16 sessions:

- **INV-0054**: Remove `716961ff-0d06-43c6-89e4-0d1b11933444` from booking_ids
- **INV-0055**: Remove `476c63f2-6d87-4f5c-96dc-0b3994ab1172` from booking_ids
- Update line items to 16 weken, recalculate totals:
  - Sessions: 16 × €46.25 = €740.00 (9% VAT inclusive)
  - Extra costs: 16 × €18.00 = €288.00 (0% VAT)
  - Subtotal: €966.97, VAT: €61.03, Total: €1,028.00

| File | Change |
|------|--------|
| `src/components/trainer/DeleteSlotDialog.tsx` | Add "draft" to invoice status filter |
| Database (insert tool) | Patch both invoices to 16 sessions |

