

# Admin Invoice Delete + Duplicate Prevention

## Problem
1. INV-0010 is a stale full invoice (€2189.20, status "sent") that was never updated when split invoices INV-0054/0055 were created — it's a duplicate
2. Admins have no way to delete or void invoices
3. The `split-invoice` edge function doesn't check for existing split invoices before creating new ones, risking duplicates

## Plan

### 1. Add RLS policy for admin DELETE on invoices (migration)
```sql
CREATE POLICY "Admins can delete invoices"
ON public.invoices FOR DELETE
TO authenticated
USING (public.is_admin(auth.uid()));
```

### 2. Add "Void" action to InvoiceList for admins
**File:** `src/components/trainer/InvoiceList.tsx`
- Accept an `isAdmin` prop
- For admins, show a delete/void button on ALL invoices (not just drafts)
- Use an AlertDialog confirmation before deleting
- For sent/overdue invoices, set status to "cancelled" instead of hard-deleting (audit trail); for drafts, hard-delete

### 3. Pass `isAdmin` from parent pages
Check where `InvoiceList` is used (`TrainerEarnings.tsx`) and pass `isAdmin` when the current user is an admin (already available from auth context).

### 4. Add duplicate guard to `split-invoice` edge function
**File:** `supabase/functions/split-invoice/index.ts`
- Before creating new invoices for other players, check if an invoice already exists with overlapping `booking_ids` for that player
- Skip creation if a split invoice already exists, preventing duplicates

### 5. Delete duplicate INV-0010 (data patch)
Use the insert tool to delete the stale invoice:
```sql
DELETE FROM invoices WHERE id = 'd240142a-bac9-4aac-bf9a-06f8cb3bec49';
```

| File | Change |
|------|--------|
| Migration SQL | Admin DELETE policy on invoices |
| `src/components/trainer/InvoiceList.tsx` | Add admin void/delete capability for all statuses |
| `src/pages/TrainerEarnings.tsx` | Pass `isAdmin` prop |
| `supabase/functions/split-invoice/index.ts` | Add duplicate booking_ids check before creating |
| Database (data patch) | Remove INV-0010 |

