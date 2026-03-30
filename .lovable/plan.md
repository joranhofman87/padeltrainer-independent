

# Add Invoice Delete with Confirmation Dialog (Trainer & Academy Only)

## Summary
Add a delete button (Trash2 icon) to invoices in **Trainer InvoiceList** and **Academy AcademyInvoices** only. Players cannot delete invoices. All deletions show an AlertDialog confirmation before proceeding. Deletion only removes the invoice record — no side effects on slots or cycles.

## Deletion Logic
- **Draft invoices**: Hard-delete from database
- **Non-draft invoices** (sent/overdue/paid): Soft-delete by setting `status = 'cancelled'`
- No updates to `bookings`, `availability_slots`, or cycles

## Changes

| File | Change |
|------|--------|
| `src/components/trainer/InvoiceList.tsx` | Replace the existing `confirm()` call in `handleDelete` with an AlertDialog pattern (add `deleteConfirm` state like the existing `voidConfirm`). Draft → hard delete, others → set status to `cancelled`. |
| `src/pages/academy/AcademyInvoices.tsx` | Add Trash2 delete button per invoice row. Add AlertDialog confirmation + `deleteMutation`. Draft → hard delete, others → cancel. |

## Confirmation Dialog Text
- **Draft**: Title "Factuur verwijderen", body "Weet je zeker dat je factuur {number} wilt verwijderen? Dit kan niet ongedaan worden gemaakt."
- **Non-draft**: Title "Factuur annuleren", body "Weet je zeker dat je factuur {number} wilt annuleren? De factuur wordt gemarkeerd als geannuleerd."
- Buttons: "Annuleren" / "Verwijderen" (destructive)

## Not Changed
- `PlayerInvoicesTab.tsx` — players cannot delete or cancel invoices

