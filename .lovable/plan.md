

# Fix: Invoice Payment Not Updating Booking Payment Status on Dashboard

## Problem
When an invoice is paid via the Mollie payment link, the webhook (`mollie-webhook/index.ts` lines 272-284) updates the `invoices` table but **returns early** before reaching the booking update logic (line 314). The associated bookings' `payment_status` stays "pending" forever.

The invoices page shows "Betaald" (paid) because it reads from the `invoices` table, but the dashboard shows "pending" because it reads from `bookings.payment_status`.

## Fix

### `supabase/functions/mollie-webhook/index.ts`

In the invoice-only payment handler (line 272-284), after marking the invoice as paid, also update the linked bookings:

1. After updating the invoice status to "paid", read the invoice's `booking_ids` array
2. If `booking_ids` is not empty, update those bookings: set `payment_status = 'paid'`, `status = 'confirmed'`, `paid_at = now()`
3. Then return (keep the early return — no need to fall through to the booking-based logic below)

This is ~10 lines of additional code inside the existing `if (payment.status === "paid")` block.

### Files
- `supabase/functions/mollie-webhook/index.ts` — Add booking status update in invoice-only payment path

