

# When Are Invoices Created? + Fix for Academy Cycle Flow

## Current Situation

Invoices are **only** created in these scenarios:
1. **Player self-books** via BookLesson page (calls `auto-create-invoice` after booking)
2. **Mollie webhook** — after online payment completes
3. **Scheduled `auto-invoice-cycles`** — for cycles with `invoice_after_weeks` payment timing

When you create a cycle from the **academy calendar** (BulkCreateSheet) and pre-assign players, bookings are created but **no invoices are generated**. Additionally, those bookings use `guest_player_id` (not `player_id`), which `auto-create-invoice` doesn't support.

## Proposed Fix

### 1. Trigger invoice creation after BulkCreateSheet bookings

In `src/components/trainer/AddSlotDialog.tsx`, after bookings are successfully inserted (line ~889), call `auto-create-invoice` for each player's bookings — but only when payment is NOT marked as externally paid.

### 2. Update `auto-create-invoice` to handle `guest_player_id`

The edge function currently only looks at `booking.player_id` to find the customer. It needs to also check `guest_player_id` and look up the guest player's name from the `guest_players` table when `player_id` is null.

### 3. Set invoice status to `draft` for academy-created bookings

When invoices are auto-created from BulkCreateSheet (not from a payment), set `status: 'draft'` instead of `'sent'`, so they appear in the academy's Draft tab and can be sent in bulk later.

Add a `draft` flag parameter to `auto-create-invoice` that the BulkCreateSheet passes.

## Files
- `src/components/trainer/AddSlotDialog.tsx` — Call `auto-create-invoice` after creating bookings
- `supabase/functions/auto-create-invoice/index.ts` — Support `guest_player_id`, add `asDraft` parameter
- `supabase/functions/auto-invoice-cycles/index.ts` — Also handle `guest_player_id` bookings in its query

