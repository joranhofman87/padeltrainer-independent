

# Auto-Generate Invoices After Registration Approval

## Problem
When bookings are created via the registration flow ("Approve & Book"), `finalize-proposals` creates booking records but never triggers invoice generation. This means all players booked through registrations have no invoices.

For comparison, the normal booking flow (BookLesson, AddSlotDialog) calls `auto-create-invoice` immediately after creating each booking.

## Root Cause
The `finalize-proposals` edge function (line 104) inserts bookings but stops there. No call to `auto-create-invoice` follows.

## Fix: `supabase/functions/finalize-proposals/index.ts`

After creating all bookings (the loop ending at line 124), add invoice generation logic:

1. **Fetch the cycle's payment timing** from `cycles.settings` to determine behavior:
   - `upfront` (default) or missing → generate invoices immediately
   - `invoice_after_weeks` → skip (handled by `auto-invoice-cycles` cron)
   - `manual` → skip (trainer invoices manually)

2. **For upfront cycles**, after the booking loop completes:
   - Re-query all newly created bookings for this cycle (status: confirmed, payment_status: pending)
   - Group by player (player_id or guest_player_id) — same pattern used in `auto-invoice-cycles`
   - For each player group, call `auto-create-invoice` with their booking IDs
   - If the cycle has `split_payment` enabled, pass `splitAmongPlayers` count
   - Log results but treat invoice failures as non-fatal (bookings are already created)

3. **Return invoice stats** in the response: add `invoices_created` count alongside existing `booked` and `bookings_created`

## No other files need changes
The `auto-create-invoice` function already handles everything (deduplication, PDF generation, forwarding). We just need to call it.

## File summary

| File | Change |
|------|--------|
| `supabase/functions/finalize-proposals/index.ts` | After booking loop, fetch cycle payment timing, generate invoices for upfront cycles by calling `auto-create-invoice` per player |

