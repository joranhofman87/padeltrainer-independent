

# Track Bookkeeper Forwarding Status on Invoices

## Summary
Add a `forwarded_at` timestamp column to the `invoices` table. Set it when the `forward-invoice` function successfully sends emails. Display this status in the UI so trainers/academies can see which invoices have been forwarded to the bookkeeper.

## Changes

### 1. Database Migration
Add `forwarded_at TIMESTAMPTZ NULL` column to `invoices` table.

### 2. `supabase/functions/forward-invoice/index.ts`
After successful email send (line ~185), update the invoice:
```sql
UPDATE invoices SET forwarded_at = now() WHERE id = invoice.id
```

### 3. `src/pages/academy/AcademyInvoices.tsx`
Show a small indicator (e.g., mail icon or badge) on invoices where `forwarded_at` is set. Tooltip showing the forwarded date. This gives the academy manager instant visibility into which invoices the bookkeeper has received.

### 4. `src/components/trainer/InvoiceList.tsx`
Same indicator for the trainer view — show forwarded status on each invoice row.

## Files Changed

| File | Change |
|------|--------|
| Migration | Add `forwarded_at` column to `invoices` |
| `forward-invoice/index.ts` | Set `forwarded_at` after successful send |
| `AcademyInvoices.tsx` | Show forwarded indicator on invoice rows |
| `InvoiceList.tsx` | Show forwarded indicator on invoice rows |

