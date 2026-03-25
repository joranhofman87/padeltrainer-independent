

# Fix: Adding Sessions Doesn't Book Existing Players + Invoice Not Updated

## Root Cause

In `TrainerScheduleOverview.tsx` lines 512-547, when the repeat count increases, new slots are created but **no bookings are created for existing players** on those new slots. The code copies slot properties but never queries who's already booked on the existing slots to replicate those bookings.

After the new slots are inserted, the invoice sync (line 580-693) only looks at *existing* bookings — since no bookings were created for the new slots, the invoice stays at the old session count.

## Code Fix

### `src/pages/TrainerScheduleOverview.tsx` — After inserting new slots, create bookings for existing players

After line 547 (`await supabase.from("availability_slots").insert(newSlots);`), add logic to:

1. Query all existing bookings on the cycle's slots (grouped by `player_id` / `guest_player_id`) to find which players are enrolled
2. Fetch the newly inserted slot IDs (query by `cyclus_id` + the new start times)
3. For each player/guest, insert a booking for each new slot (same status, payment_amount, etc.)
4. After creating bookings, update associated unpaid invoices:
   - Add the new booking IDs to `booking_ids`
   - Update the session line item quantity to match the new total
   - Recalculate totals

This is ~40 lines of code after line 547.

## Data Fix (via insert tool)

1. **Rename invoice**: `INV-2026-0058` → `INV-2026-0003`
2. **Create 2 bookings** for Maarten (guest `22985231-a70c-46ae-b248-d7d938376de7`) on the 2 empty slots (`43ba9298...` and `f1d16140...`)
3. **Update invoice** `c8c9f2a5...`: add the 2 new booking IDs, update line items to 18 sessions, recalculate totals:
   - Sessions: 18 × €92.50 = €1,665.00 (9% VAT inclusive)
   - Extra costs: 18 × €38.00 = €684.00 (0% VAT)
   - Subtotal: €2,215.60, VAT: €133.40 (9% on sessions only), Total: €2,349.00
4. **Update `trainer_profiles.invoice_next_number`** to 4 (since 0003 is now used)

| File | Change |
|------|--------|
| `src/pages/TrainerScheduleOverview.tsx` | After inserting new cycle slots, auto-create bookings for existing players and update invoices |
| Database (data patch) | Rename invoice, create 2 bookings, update invoice totals, bump next number |

