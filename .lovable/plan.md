

# Auto-Generate Invoices on Every Booking + VAT Rate per Trainer

## Summary

Every confirmed booking (whether via Mollie payment, manual invoicing, or approval flow) will automatically generate an invoice. Trainers will be able to set their default VAT rate in their profile settings, since prices are **inclusive** of VAT and rates differ by country (21% NL, 6% UAE, 0% for KOR-registered trainers, etc.).

## Current State

- Invoices are only created manually by trainers via the "Factuur aanmaken" dialog on the Earnings page
- The `invoices` table exists with all needed columns (line_items, vat_rate, subtotal, etc.)
- The `CreateInvoiceDialog` hardcodes Dutch VAT rates (21%, 9%, 0%) and treats prices as **exclusive** of VAT (adds VAT on top)
- `trainer_profiles` has no `default_vat_rate` or `country` column
- There are 3 booking entry points in `BookLesson.tsx`: (1) Mollie payment, (2) manual invoicing, (3) approval-required
- The Mollie webhook (`mollie-webhook/index.ts`) confirms bookings after payment but creates no invoice

## What Changes

### 1. Database: Add `default_vat_rate` to `trainer_profiles`

Add a `default_vat_rate` column (numeric, default 21) to `trainer_profiles`. This stores the trainer's chosen VAT rate for all auto-generated invoices. Prices are VAT-inclusive, so a rate of 21% on a EUR 50 lesson means EUR 41.32 ex-VAT + EUR 8.68 VAT = EUR 50.00.

### 2. New Edge Function: `auto-create-invoice`

A backend function that:
- Accepts `bookingId` (single) or `bookingIds` (array)
- Fetches booking details (player, lesson, slot, price)
- Fetches the trainer's business info and `default_vat_rate`
- Calculates VAT **backwards** from the inclusive price: `subtotal = total / (1 + vatRate/100)`, `vatAmount = total - subtotal`
- Generates an invoice number (same `INV-YYYY-NNNN` pattern)
- Inserts the invoice record with status `sent`
- Links the booking via `booking_ids`
- Skips invoice creation if trainer has no business info (business_name, kvk_number, iban) -- the booking still works, invoice can be created manually later

### 3. Call `auto-create-invoice` from 3 places

| Trigger | Where | When |
|---------|-------|------|
| Mollie payment succeeds | `mollie-webhook/index.ts` | After bookings are updated to `paid`/`confirmed` |
| Manual booking confirmed | `BookLesson.tsx` (manual invoicing path) | After booking insert succeeds |
| Approval-based booking confirmed | `BookLesson.tsx` or `confirmBookingAfterApproval` | After trainer approves and booking becomes `confirmed` |

For the Mollie webhook, it will call `auto-create-invoice` server-side (supabase function invoke). For frontend paths, the client will invoke the edge function after the booking is created.

### 4. Trainer Settings: VAT Rate Picker

Add a "Default VAT rate" selector to the Invoice Settings card (`InvoiceSettingsCard.tsx`). Options:
- 21% -- Standard (NL, BE, etc.)
- 9% -- Reduced rate
- 0% -- Exempt / KOR
- Custom entry for other countries (e.g., 5% for UAE)

This saves to `trainer_profiles.default_vat_rate`.

### 5. Update `CreateInvoiceDialog` (manual invoice creation)

- Pre-fill the VAT rate from `trainer_profiles.default_vat_rate` instead of hardcoding 21%
- Change the price label from "Prijs (excl. BTW)" to "Prijs (incl. BTW)" and reverse-calculate subtotal from inclusive price
- Keep the ability to override VAT rate per invoice

### 6. Update `PlayerInvoicesTab`

No major changes needed -- it already shows invoices linked to the player. Auto-generated invoices will appear automatically since they use the same `player_id` field.

## Technical Details

### Database Migration

```sql
ALTER TABLE trainer_profiles 
ADD COLUMN default_vat_rate numeric DEFAULT 21;
```

### Edge Function: `supabase/functions/auto-create-invoice/index.ts`

Key logic:
```text
Input: { bookingIds: string[] }
For each booking:
  1. Fetch booking + slot + lesson + player profile
  2. Fetch trainer_profiles (business info, default_vat_rate)
  3. If business info incomplete -> skip (log warning)
  4. Calculate: total = lesson.price (inclusive)
     vatRate = trainer.default_vat_rate
     subtotal = total / (1 + vatRate/100)
     vatAmount = total - subtotal
  5. Generate invoice_number (INV-YYYY-NNNN, sequential per trainer)
  6. Insert into invoices table
  7. Update booking payment_status to 'invoiced' (for manual bookings)
```

### Mollie Webhook Changes

After the "Bookings updated successfully" step, add:
```text
if (payment.status === "paid") {
  // Auto-create invoice
  await supabase.functions.invoke("auto-create-invoice", {
    body: { bookingIds }
  });
}
```

### BookLesson.tsx Changes

After the manual booking insert (line ~519) and after cyclus booking (line ~355), invoke:
```text
await supabase.functions.invoke('auto-create-invoice', {
  body: { bookingIds: [bookingData.id] }
});
```

### InvoiceSettingsCard Changes

Add a VAT rate selector field that reads/writes `default_vat_rate` from `trainer_profiles`.

### CreateInvoiceDialog Changes

- Default `vatRate` from trainer's `default_vat_rate` prop instead of hardcoded "21"
- Reverse the VAT calculation: prices entered are inclusive, subtotal is derived
- Update the label from "excl. BTW" to "incl. BTW"

