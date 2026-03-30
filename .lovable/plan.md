

# Fix: Invoice Deletion Failing Silently for Academy Managers

## Root Cause

The invoices table has **no DELETE RLS policy for academy managers**. The existing policies are:
- **Trainers**: Can DELETE only `draft` invoices they own
- **Admins**: Can DELETE any invoice
- **Academy managers**: Have SELECT and UPDATE policies, but **no DELETE policy**

When an academy manager tries to delete a draft invoice, the `supabase.from('invoices').delete()` call silently affects 0 rows (RLS blocks it without returning an error). For non-draft invoices, the `.update({ status: 'cancelled' })` should work via the existing UPDATE policy — but only if the invoice has `academy_profile_id` set.

Additionally, the trainer DELETE policy only allows deleting `draft` invoices, so non-draft trainer invoices also can't be hard-deleted by trainers (which is fine — they get soft-cancelled via UPDATE).

## Fix

**One migration** to add a DELETE policy for academy managers:

```sql
CREATE POLICY "Academy managers can delete their draft invoices"
ON public.invoices FOR DELETE
TO authenticated
USING (
  academy_profile_id IS NOT NULL
  AND public.is_academy_manager(auth.uid(), academy_profile_id)
  AND status = 'draft'
);
```

This mirrors the trainer pattern: hard-delete for drafts only. Non-draft invoices are already handled by the UPDATE policy (setting status to `cancelled`).

## Additional Safety

Add a check in both `InvoiceList.tsx` and `AcademyInvoices.tsx` to detect when 0 rows were affected — Supabase returns `data` with count info when using `.select()` after mutations. However, the simpler fix is just adding the missing RLS policy, since the UPDATE path for non-draft invoices should already work.

## Files Changed

| File | Change |
|------|--------|
| New migration | Add DELETE RLS policy for academy managers on draft invoices |

No application code changes needed — the RLS policy is the only blocker.

