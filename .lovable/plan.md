

## Show Payment Status on Player Bookings

### What
Add a payment status indicator (badge) next to each booking on the Player Bookings page so players can see whether their booking is paid, pending payment, or waived.

### Changes

**File: `src/pages/PlayerBookings.tsx`**

1. **Update the query** to include `payment_status` in the select:
   ```
   id, status, notes, created_at, payment_status, availability_slots(...)
   ```

2. **Update the `BookingWithDetails` interface** to add `payment_status: string | null`.

3. **Update the raw booking type cast** to include `payment_status`.

4. **Add a payment badge helper** `getPaymentBadge(paymentStatus, bookingStatus)`:
   - `paid` -- green badge "Paid"
   - `waived` -- outline badge "Waived"
   - `refunded` -- outline badge "Refunded"
   - `pending` (and booking is confirmed/pending) -- orange badge "Unpaid"
   - Otherwise: don't show

5. **Render the badge** in both upcoming and past booking cards, next to the booking status badge.

