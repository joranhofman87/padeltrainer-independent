

# Bulk Update VAT Setting on Unpaid Invoices & Slots

## What happens today
When a trainer toggles the VAT setting (inclusive ↔ exclusive), it only affects **new** slots. Existing slots and their invoices keep the old setting. If the trainer made a mistake, they have to manually fix everything.

## Plan

### 1. Add confirmation dialog after VAT toggle
**File: `src/pages/TrainerBookingSettings.tsx`**

After successfully saving the new `prices_include_vat` value, show a confirmation dialog:
- "Do you also want to update all unpaid invoices and future sessions to use this new VAT setting?"
- Two buttons: **Yes, update all** / **No, only new sessions**

### 2. Create edge function to bulk recalculate
**File: `supabase/functions/bulk-update-vat/index.ts`**

Accepts `{ trainerId, pricesIncludeVat }`. Does three things:

1. **Update all future slots** — set `prices_include_vat` on all `availability_slots` where `trainer_id` matches and `start_time > now()`
2. **Recalculate unpaid invoices** — for all invoices with `status` in (`draft`, `sent`) belonging to this trainer:
   - Recalculate `subtotal`, `vat_amount`, `total` based on the new VAT direction (same line item unit prices, different math)
   - Update the invoice record
3. **Regenerate PDFs** — call `generate-invoice` for each updated invoice so the HTML/PDF reflects correct totals

Returns a summary: `{ slotsUpdated, invoicesUpdated }`.

### 3. Wire dialog to edge function
**File: `src/pages/TrainerBookingSettings.tsx`**

When user clicks "Yes, update all":
- Call `bulk-update-vat` edge function
- Show toast with result: "Updated X sessions and Y invoices"
- On error, show error toast

### Files
- `src/pages/TrainerBookingSettings.tsx` — Add confirmation dialog after VAT toggle, call edge function
- `supabase/functions/bulk-update-vat/index.ts` — New edge function for bulk slot + invoice recalculation

