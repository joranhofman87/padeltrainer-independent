

# Custom Invoice Creation for Academy Owners

## Problem
Academy owners sometimes make special arrangements (company invoices, clinics, custom agreements) that don't originate from bookings. They need to create standalone invoices with full control over receiver details, line items, and VAT.

## Database Changes

**Migration: Make `trainer_id` nullable on `invoices`**
- `ALTER TABLE invoices ALTER COLUMN trainer_id DROP NOT NULL;`
- Add RLS INSERT policy for academy managers: allow insert when `academy_profile_id` is set and user is a manager of that academy.

## New Component: `CreateCustomInvoiceDialog`

A dialog accessible from the Academy Invoices page with:
1. **Receiver details**: name (required), business name, address, BTW number, email
2. **Line items**: description, quantity, unit price, VAT rate per line — reuses the same layout as `EditInvoiceDialog`
3. **Invoice settings**: due date, notes, prices include VAT toggle
4. **Extra cost preset picker** — reuse existing `ExtraCostPresetPicker`
5. **Totals**: auto-calculated subtotal, VAT breakdown, total — same logic as `EditInvoiceDialog`

On save:
- Fetch academy's `invoice_prefix` and `invoice_next_number` to generate the invoice number
- Insert into `invoices` with `trainer_id: null`, `academy_profile_id` set, `booking_ids: null`
- Increment academy's `invoice_next_number`
- Optionally create a `guest_player` record if email is provided (for sending)

## Edge Function Updates

**`generate-invoice/index.ts`**: When `trainer_id` is null, skip trainer profile fetch. Use academy profile directly as `businessSource`. Already partially handles this via the `academyProfile || trainerProfile` fallback — just need to make the trainer fetch conditional.

**`send-invoice-email/index.ts`**: Similar — make trainer profile fetch conditional when `trainer_id` is null.

## UI Integration

Add a "Create Invoice" button next to "Generate missing invoices" on `AcademyInvoices.tsx`. Opens the new dialog. After creation, the invoice appears in the list and can be edited (existing `EditInvoiceDialog`), sent, shared, downloaded like any other invoice.

## Changes

| File | Change |
|------|--------|
| **Database migration** | Make `trainer_id` nullable; add INSERT RLS policy for academy managers |
| `src/components/invoices/CreateCustomInvoiceDialog.tsx` | New dialog: receiver fields, line items editor, VAT calc, save to DB |
| `src/pages/academy/AcademyInvoices.tsx` | Add "Create Invoice" button, wire up the new dialog |
| `supabase/functions/generate-invoice/index.ts` | Make trainer profile fetch conditional (`if (invoice.trainer_id)`) |
| `supabase/functions/send-invoice-email/index.ts` | Make trainer profile fetch conditional |
| `supabase/functions/get-public-invoice/index.ts` | Ensure it works when `trainer_id` is null |

