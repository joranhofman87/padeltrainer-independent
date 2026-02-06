

# Fix Booking Visibility and Enforce Payment Before Confirmation

## Two Issues Found

### Issue 1: Bookings not showing in Player Dashboard
The Player Dashboard (line 161) only shows `confirmed` bookings in the "upcoming" section. When a trainer has Mollie connected (no manual invoicing, no approval required), bookings are created with status `pending` -- but the dashboard filters these out. The PlayerBookings page does show all non-cancelled bookings, but the dashboard summary card doesn't.

**Fix**: Update `PlayerDashboard.tsx` to include `pending` and `pending_approval` bookings in the upcoming count and list, with appropriate status badges so players can see their pending bookings.

Also update `PlayerBookings.tsx` to show `pending` bookings with a "Pending Payment" badge and `pending_approval` bookings with a "Awaiting Approval" badge.

### Issue 2: Cyclus (Training Cycle) booking skips Mollie payment
When a player books an entire training cycle, the code (lines 340-404 in `BookLesson.tsx`) only handles two scenarios:
- `requiresApproval` = true: creates bookings as `pending_approval`
- else: creates bookings and shows "booked" confirmation (treating it like manual invoicing)

It **never** checks for Mollie payment or redirects to checkout. The Mollie payment flow only exists for individual slot bookings (line 494+). Since Trainer Test has Mollie connected and neither approval nor manual invoicing enabled, the cyclus booking silently creates `pending` bookings without ever collecting payment.

**Fix**: Add a third branch in the cyclus booking logic: when the trainer has Mollie connected (not approval, not manual invoicing), check `hasValidPaymentSetup`, create the bookings, then call `create-mollie-payment` with the total cycle amount and redirect to Mollie checkout.

---

## Technical Changes

### 1. `src/pages/BookLesson.tsx` -- Cyclus Mollie payment flow

In the `handleBook` function, restructure the cyclus booking block (lines 340-404):

```text
if (selectedCyclus) {
  if (requiresApproval) {
    // existing: create bookings as pending_approval, send email
  } else if (useManualInvoicing) {
    // existing: create bookings as confirmed, send email
  } else {
    // NEW: Mollie payment path for cyclus
    // 1. Check hasValidPaymentSetup()
    // 2. Create bookings with status 'pending', payment_status 'pending'
    // 3. Call create-mollie-payment with first slot ID and total cyclus price
    // 4. Redirect to Mollie checkout URL
  }
}
```

The `create-mollie-payment` edge function already creates its own booking record, so for cyclus we need a different approach. We will:
- Create the cyclus bookings in BookLesson.tsx first (as we already do)
- Skip the edge function's internal booking creation by passing the existing booking IDs
- Update the edge function to accept an optional `bookingId` parameter and skip creating a new booking when one is provided

### 2. `supabase/functions/create-mollie-payment/index.ts` -- Accept existing bookingId

Add an optional `bookingId` parameter. When provided, skip the booking insert and use the existing booking record instead. This allows the cyclus flow to pre-create multiple bookings and then initiate payment for them as a group.

The metadata will include all booking IDs so the webhook can update all of them on payment success.

### 3. `supabase/functions/mollie-webhook/index.ts` -- Handle multi-booking payments

Update the webhook to check metadata for multiple booking IDs and update all related bookings to `paid`/`confirmed` when payment succeeds.

### 4. `src/pages/PlayerDashboard.tsx` -- Show pending bookings

Update the `fetchPlayerData` function (line 161) to include `pending` and `pending_approval` statuses in the upcoming bookings section, not just `confirmed`. Add visual distinction (badge/color) for each status.

### 5. `src/pages/PlayerBookings.tsx` -- Show payment status

Update the `getStatusBadge` function to also render `pending_approval` as "Awaiting Approval" and add a payment indicator for bookings with `payment_status: pending` so the player knows payment is still needed.

### 6. `src/pages/PlayerDashboard.tsx` -- Fix legacy route

Line 372 and 399 still use `/player/following` and `/player/bookings` without the `/app/` prefix (missed in the previous fix). Update to `/app/player/following` and `/app/player/bookings`.

