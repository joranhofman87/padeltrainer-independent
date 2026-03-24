

# Edit Invoice: Line Items, VAT & Notes with Optional Booking Sync

## Overview
Add an edit dialog to invoices (both Academy and Trainer dashboards) that allows editing line items (description, qty, unit price), VAT rate, notes, and due date. Optionally sync price changes back to linked bookings.

## Changes

### 1. New component: `src/components/invoices/EditInvoiceDialog.tsx`

A reusable dialog with:
- **Line items table**: editable description, quantity, unit_price per row. Each row shows calculated `amount = qty × unit_price`. No add/remove rows (per user request).
- **VAT rate**: editable number input
- **Due date**: date picker
- **Notes**: textarea
- **Sync checkbox**: "Ook prijswijzigingen doorvoeren naar boekingen" — only shown when prices changed and `booking_ids` exist
- Auto-recalculates subtotal, vat_amount, total on every change (respecting prices_include_vat logic)
- On save: updates the invoice record (`line_items`, `vat_rate`, `due_date`, `notes`, `subtotal`, `vat_amount`, `total`, clears `pdf_url` to force regeneration)
- If sync checked: calls a new edge function to update booking payment_amounts

### 2. Edge function: `supabase/functions/sync-invoice-to-bookings/index.ts`

- Accepts `invoiceId` 
- Reads the invoice's `booking_ids` and `line_items`
- For the main session line item, calculates new per-booking price = `unit_price`
- Updates each booking's `payment_amount` in the `bookings` table
- Also updates the corresponding `availability_slots.price_per_session` if the cycle's session price changed
- Auth: validates the caller is the trainer or academy manager

### 3. `src/pages/academy/AcademyInvoices.tsx` — Add edit button

- Add a Pencil icon button in the actions column for unpaid invoices
- Opens `EditInvoiceDialog` with invoice data
- On save success: invalidate query cache

### 4. `src/components/trainer/InvoiceList.tsx` — Add edit button

- Same Pencil icon button for unpaid invoices
- Opens `EditInvoiceDialog`
- On save success: re-fetch invoices

## Files
- `src/components/invoices/EditInvoiceDialog.tsx` — New shared component
- `supabase/functions/sync-invoice-to-bookings/index.ts` — New edge function
- `src/pages/academy/AcademyInvoices.tsx` — Add edit action
- `src/components/trainer/InvoiceList.tsx` — Add edit action

