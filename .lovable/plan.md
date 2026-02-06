

# Fix Payment Verification and Webhook for Connected Account Payments

## Problem

Payments are now correctly created on the **trainer's connected Mollie account** using their OAuth access token. However, both the **verify-mollie-payment** and **mollie-webhook** functions still try to fetch payment details using the **platform API key**, which can't see payments on connected accounts (especially in test mode). This causes:

- `verify-mollie-payment`: fails to fetch the payment status, so BookingSuccess stays stuck on "Verifying Payment"
- `mollie-webhook`: fails to fetch payment details, so bookings never get updated to "paid/confirmed"

## Root Cause

When a payment is created with an OAuth access token on a connected account, only that access token (or the platform key with `testmode` and `include` params in some cases) can retrieve it. The current code uses just the platform API key with no `testmode` flag.

## Solution

Both functions need to look up the trainer's access token from the database (via the booking's linked trainer) and use it to fetch payment details from Mollie, with `testmode=true` when applicable.

### 1. `supabase/functions/verify-mollie-payment/index.ts`

- After fetching the booking, look up the trainer via `availability_slots.trainer_id`
- Check `trainer_mollie_accounts` (and `academy_mollie_accounts` via `academy_trainers`) for an access token
- Refresh the token if expired (reuse the same `refreshTokenIfNeeded` logic)
- Use the trainer/academy access token to call Mollie API instead of platform key
- Add `?testmode=true` query param when platform key starts with `test_`

### 2. `supabase/functions/mollie-webhook/index.ts`

- After receiving the payment ID, look up the booking from `bookings` table using `mollie_payment_id`
- From the booking, resolve the trainer and their Mollie access token
- Use the access token to fetch payment details, with `testmode=true` when in test mode
- Fall back to platform API key for payments not on connected accounts

### 3. `supabase/functions/create-mollie-payment/index.ts`

- Store the `trainer_id` (from `availability_slots`) on the booking record when creating it, so the webhook and verify functions can easily look up the connected account
- This avoids complex joins at verification time

## Technical Details

### Token Resolution Flow (shared by both verify and webhook)

```text
booking -> slot_id -> availability_slots.trainer_id
  -> trainer_mollie_accounts (check access_token)
  -> OR academy_trainers -> academy_mollie_accounts (check access_token)
  -> refresh if expired
  -> use token + testmode flag
```

### Key code pattern for fetching payment with connected account token

```typescript
// Build URL with testmode if needed
const isTestMode = mollieApiKey.startsWith("test_");
let fetchUrl = `https://api.mollie.com/v2/payments/${molliePaymentId}`;
if (isTestMode && recipientAccessToken) {
  fetchUrl += "?testmode=true";
}

const authToken = recipientAccessToken || mollieApiKey;
const response = await fetch(fetchUrl, {
  headers: { "Authorization": `Bearer ${authToken}` },
});
```

## Files to Change

1. **`supabase/functions/verify-mollie-payment/index.ts`** -- resolve trainer access token from booking, use it to call Mollie API with testmode
2. **`supabase/functions/mollie-webhook/index.ts`** -- resolve trainer access token from payment metadata/booking, use it to call Mollie API with testmode
3. **`supabase/functions/create-mollie-payment/index.ts`** -- minor: include token refresh helper reuse consideration (already has it)

