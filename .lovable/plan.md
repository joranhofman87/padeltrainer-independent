

# Fix: Cancelled/Failed Payments on Mollie

## Problem

When a payment is cancelled or fails on Mollie, the user either stays on the Mollie screen with no clear way back, or gets redirected to the "BookingSuccess" page which confusingly tries to verify a payment that was never completed.

## Solution

Two changes:

### 1. Add `cancelUrl` to the Mollie payment creation

Mollie supports a dedicated `cancelUrl` parameter. When a user clicks "Cancel" or "Back to website" on Mollie's checkout page, they'll be redirected to this URL instead of the `redirectUrl`.

We'll point the `cancelUrl` to a new route: `/app/booking-cancelled?booking_id=...`

**File: `supabase/functions/create-mollie-payment/index.ts`**
- Add `cancelUrl` to the payment request pointing to `/app/booking-cancelled?booking_id=...`

### 2. Create a simple "Payment Cancelled" page

A lightweight page that shows a clear message: "Payment was not completed" with two actions:
- **Try Again** -- links back to the trainer's booking page (`/:lang/book/:slug`)
- **View My Bookings** -- links to `/app/player/bookings`

The page will fetch the booking's trainer slug so the "Try Again" button works correctly.

**New file: `src/pages/BookingCancelled.tsx`**
- Simple card UI matching the BookingSuccess design
- Fetches trainer slug from the booking to enable "Try Again"
- Shows clear messaging that the payment was not completed

**File: `src/App.tsx` (or wherever routes are defined)**
- Add route for `/app/booking-cancelled`

### 3. Improve BookingSuccess for edge cases

The existing `BookingSuccess` page should also handle non-paid statuses gracefully in case a webhook updates the booking to `failed`/`expired` during polling.

**File: `src/pages/BookingSuccess.tsx`**
- During polling, if `payment_status` is `failed`, `canceled`, or `expired`, stop polling immediately and show the error state with a "Try Again" link to the trainer's booking page

## Files to Change

1. `supabase/functions/create-mollie-payment/index.ts` -- add `cancelUrl` parameter
2. `src/pages/BookingCancelled.tsx` -- new page for cancelled payments
3. `src/pages/BookingSuccess.tsx` -- handle failed/expired statuses during polling
4. Route configuration file -- add `/app/booking-cancelled` route

