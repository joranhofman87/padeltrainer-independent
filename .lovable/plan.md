

# Fix: BookingSuccess Losing Query Parameters on Redirect

## Problem

After a successful Mollie payment, the user is redirected to `/booking-success?booking_id=xxx`. The app has a legacy redirect from `/booking-success` to `/app/booking-success`, but it uses React Router's `<Navigate>` component which **drops the query parameters**. So:

1. Mollie redirects to `/booking-success?booking_id=ef923cdb-...`
2. App redirects to `/app/booking-success` (no query params!)
3. `bookingId` is `null`, so `verifyPayment()` never runs
4. Page stays stuck on "Verifying Payment" spinner forever

The webhook actually works fine (logs confirm booking was updated to "paid"), but the frontend never knows because it can't call verify without the booking ID.

## Fix

### Option A (Recommended): Update the redirect URL in `create-mollie-payment`

Change the redirect URL from `/booking-success` to `/app/booking-success` so it hits the correct route directly, avoiding the redirect entirely.

**File**: `supabase/functions/create-mollie-payment/index.ts` (line 278)

Change:
```
redirectUrl: `${origin}/booking-success?booking_id=${bookingId}`
```
To:
```
redirectUrl: `${origin}/app/booking-success?booking_id=${bookingId}`
```

### Option B (Safety net): Fix the legacy redirect to preserve query params

Update the `<Navigate>` redirect in `DomainRouter.tsx` to preserve search params, so any future redirects also work correctly.

**File**: `src/components/DomainRouter.tsx` (line 222)

Replace the simple `<Navigate to="/app/booking-success" replace />` with a small component that preserves the search string.

## Recommendation

Apply **both** fixes for robustness -- the edge function sends users to the correct URL directly, and the legacy redirect preserves params as a fallback.

## Files to change

1. `supabase/functions/create-mollie-payment/index.ts` -- update redirect URL path
2. `src/components/DomainRouter.tsx` -- preserve query params in legacy redirect

