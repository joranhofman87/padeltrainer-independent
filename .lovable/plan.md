

# Invoice Behavior When Adding/Removing Players from Split Slots

## Current Behavior Analysis

### Adding a 4th player to a slot with 3 players

**The existing invoices for the 3 players will NOT automatically update.** Here's what happens:

1. When a new player books via the registration form (`BookLesson.tsx`), the code calculates the split at booking time (lines 348-358) — it counts existing players and divides the `totalPrice` by the total count. So the **new player's invoice** would be correctly split by 4.
2. However, **the existing 3 players' invoices still say `(1/3)`** — there is no mechanism that goes back and recalculates them when a new booking is added. The split count is baked into the line item descriptions and amounts at invoice creation time.
3. The `split-invoice` edge function only runs when explicitly called (e.g. from the UI's "Split" button), not automatically when players are added.

**Result**: Player 4 pays 1/4, but Players 1-3 still pay 1/3 each. The trainer effectively collects more than 100% of the session price.

### Removing a player from a cycle

**The invoice sync DOES work for removal**, but only partially:

1. `syncInvoicesAfterBookingRemoval()` is called when a player is removed (from `TrainerScheduleOverview` and `AcademySlotDetail`).
2. It rebuilds the **removed player's** invoice — cancelling it if all bookings are gone, or reducing the session count.
3. However, **it does NOT recalculate the split count for the remaining players**. The `detectSplitCount()` function reads the existing `(1/N)` from descriptions and **preserves that same N**. So if you remove 1 player from a 4-player split, the remaining 3 still pay 1/4 each — the trainer now only collects 75%.

## Proposed Fix

### Trigger: Recalculate all sibling invoices when a player is added or removed

When a booking is added or cancelled on a split-payment slot, find **all invoices** for that slot's cycle and update the split count (N) on each one.

### Changes

**1. `src/lib/invoiceSync.ts` — New function `syncSplitCountForCycle`**
- Given a `cyclus_id`, count the current number of unique players with active bookings
- Find all unpaid invoices linked to those slots
- Update each invoice's line items to reflect the new `(1/N)` split and recalculate totals
- This reuses the existing `recalculateInvoiceAfterRemoval` pattern but updates the split denominator

**2. `src/pages/academy/AcademySlotDetail.tsx` — Call after player removal**
- After `syncInvoicesAfterBookingRemoval`, also call `syncSplitCountForCycle` for the affected cycle

**3. `src/pages/TrainerScheduleOverview.tsx` — Call after player removal**
- Same: after removing a player from a cycle, trigger `syncSplitCountForCycle`

**4. `src/pages/BookLesson.tsx` — Call after new booking**
- After a successful cycle booking on a split-payment cycle, trigger `syncSplitCountForCycle` so existing players' invoices update to the new N

**5. `supabase/functions/auto-invoice-cycles/index.ts`** — ensure it uses current player count

### Logic for `syncSplitCountForCycle`

```text
Input: cyclus_id
1. Fetch all active bookings for slots in this cycle
2. Count unique players (player_id or guest_player_id)
3. If count <= 1, no split needed
4. Fetch all unpaid invoices overlapping with these booking IDs
5. For each invoice:
   a. Rebuild line items with unit_price = original_price / new_player_count
   b. Update description to (1/new_count)
   c. Recalculate subtotal, VAT, total
   d. Clear pdf_url
```

## File summary

| File | Change |
|------|--------|
| `src/lib/invoiceSync.ts` | Add `syncSplitCountForCycle()` function |
| `src/pages/academy/AcademySlotDetail.tsx` | Call sync after player removal on split-payment cycles |
| `src/pages/TrainerScheduleOverview.tsx` | Call sync after player removal on split-payment cycles |
| `src/pages/BookLesson.tsx` | Call sync after new cycle booking on split-payment cycles |

