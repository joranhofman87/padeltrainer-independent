
# Fix Booking Success Page Stuck Loading

## Problem

Two issues discovered:

1. **BookingSuccess page never verifies**: The page requires both `session_id` AND `booking_id` URL params to trigger verification (line 34). But the Mollie redirect URL only includes `booking_id`. The `session_id` check is a leftover from a Stripe-based flow and doesn't apply to Mollie. So `verifyPayment()` never fires and the spinner runs forever.

2. **Mollie profile fetch 403** (secondary): The `GET /v2/profiles/me` endpoint returns 403 with OAuth tokens -- Mollie says it's "only available with an API key." The payment still works because the fallback uses the platform key, but this means application fees aren't being charged to the connected account. This is a separate issue to address later.

## Fix

### `src/pages/BookingSuccess.tsx`

- Change the useEffect condition from `if (sessionId && bookingId && user)` to `if (bookingId && user)` -- remove the `sessionId` requirement
- Remove the unused `sessionId` variable since it's no longer needed

This single change will unblock the verification flow. The webhook logs confirm the payment is already marked as "paid", so once verification runs it will show the success state.

## Files changed

- `src/pages/BookingSuccess.tsx` -- remove `sessionId` requirement from verification trigger
