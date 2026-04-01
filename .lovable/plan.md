

# Revamp Academy Invoices Overview

## Summary
Restructure the invoices page with trainer/location filters, default to unpaid view, and reorganize row actions into a share dropdown and move destructive/management actions into the edit dialog.

## Changes

### 1. `AcademyInvoices.tsx` — Filters and Tabs

**Add filter dropdowns above the table:**
- **Trainer filter**: Fetch trainers from `academy_trainers` joined with `trainer_profiles` for names. Show a Select/Combobox with "All trainers" default. Filter invoices by `trainer_id`.
- **Location filter**: Since invoices don't have a `location_id`, we can derive location from the line items or bookings. However, this is complex. Instead, skip location filter for now unless you confirm invoices should track location.

**Change tabs from** `All | Draft | Sent/Overdue | Paid` **to:**
- `Unpaid` (default) — all invoices where status !== "paid" (draft + sent + overdue)
- `Paid` — status === "paid"

Set `activeTab` default to `"unpaid"`.

### 2. `AcademyInvoices.tsx` — Row Actions Restructure

**Keep on row (desktop):**
- **Share dropdown** (Share2 icon) with a DropdownMenu containing:
  - "Copy link" — copies payment URL
  - "Send via email" — triggers email send (existing logic)
  - "Mark as sent" — updates status to "sent" and sets `sent_at` without sending email

**Move to EditInvoiceDialog:**
- Delete / Cancel invoice
- Download PDF
- Mark as paid

**Remove from row:** Edit pencil (clicking the row or a single edit button opens the dialog), Delete, Download, Mark as paid, individual Send.

### 3. `EditInvoiceDialog.tsx` — Add action buttons

Add a footer section or action bar inside the edit dialog with:
- Download PDF button
- Mark as paid button (if not already paid)
- Delete/Cancel button (destructive, with confirmation)

### 4. Mark as Sent logic

New mutation: update invoice `status` to "sent" and `sent_at` to current timestamp, without invoking `send-invoice-email`. Toast confirmation.

### 5. Mobile cards

Apply same pattern: Share dropdown, tap card to open edit dialog with all actions inside.

## Technical Details

**Trainer filter query:**
```typescript
const { data: trainers } = await supabase
  .from('academy_trainers')
  .select('trainer_profile_id, trainer_profile:trainer_profiles(id, business_name)')
  .eq('academy_profile_id', activeAcademy.id);
```

**Mark as sent mutation:**
```typescript
await supabase.from("invoices")
  .update({ status: "sent", sent_at: new Date().toISOString() })
  .eq("id", invoiceId);
```

**Share dropdown uses** `DropdownMenu` from existing UI components.

## Files Changed

| File | Change |
|------|--------|
| `AcademyInvoices.tsx` | Add trainer filter Select, change tabs to Unpaid/Paid (default Unpaid), replace row actions with Share dropdown, remove inline edit/delete/download/mark-paid buttons, add mark-as-sent mutation |
| `EditInvoiceDialog.tsx` | Add Download PDF, Mark as paid, Delete/Cancel buttons inside the dialog |

