

# Bulletproof Payment Flows: Security Audit + Logging + E2E Tests

## Critical Security Issue Found

**`create-mollie-payment` (booking payments) falls back to the platform API key when no connected Mollie account is found** (line 365):
```
const authToken = recipientAccessToken || mollieApiKey;
```

This means if a trainer/academy hasn't connected Mollie, the payment silently goes to **your platform account** instead of failing. This directly contradicts the isolation principle already enforced in `create-invoice-payment` (which correctly returns an error).

`mollie-webhook` and `verify-mollie-payment` also fall back to the platform key for *reading* payment status — less dangerous but can cause lookup failures for connected-account payments.

## Plan

### 1. Remove platform fallback from `create-mollie-payment`
**File: `supabase/functions/create-mollie-payment/index.ts`**

Replace the fallback on line 365 with the same pattern used in `create-invoice-payment`: if no `recipientAccessToken`, return a `400` error with `"no_mollie_account"`. Never create a payment on the platform key for booking flows.

Also add structured logging: log the `mollie_organization_id` and `recipientType` in the final payment creation step, and send a Slack notification on every successful payment (not just errors) so you have an audit trail.

### 2. Add Slack audit logging to `create-invoice-payment`
**File: `supabase/functions/create-invoice-payment/index.ts`**

Add the same `notifySlackError` helper (already in other functions) and:
- Send Slack notification on payment creation success (invoice number, amount, recipient type)
- Send Slack notification on errors

### 3. Add payment audit table
**Database migration**

Create a `payment_audit_log` table to record every payment attempt with: function name, invoice/booking ID, recipient type (academy/trainer), mollie org ID, amount, status (success/error), error message, timestamp. This gives you a queryable history beyond ephemeral edge function logs.

Both `create-mollie-payment` and `create-invoice-payment` will write to this table on every attempt.

### 4. Add E2E payment flow tests
**File: `e2e/payments.spec.ts`**

Playwright tests covering:
- Public invoice page loads with Pay button when Mollie is connected
- Public invoice page shows bank details when Mollie is NOT connected
- Pay button click triggers loading state and handles errors gracefully (mock/intercept the edge function)
- Booking payment page shows correct trainer/academy info
- Success/cancelled redirect pages render correctly
- Error states (no Mollie account, expired token) show user-friendly messages

### 5. Fix webhook/verify fallback for read operations
**Files: `supabase/functions/mollie-webhook/index.ts`, `supabase/functions/verify-mollie-payment/index.ts`**

For the webhook, the fallback is needed because invoice-only payments (no booking/trainer) might use the platform key. Keep the fallback but add a log warning when it's used, so you can audit unexpected fallbacks.

For `verify-mollie-payment`, same approach: log a warning when falling back to platform key.

## Files
- `supabase/functions/create-mollie-payment/index.ts` — Remove platform fallback, add audit logging
- `supabase/functions/create-invoice-payment/index.ts` — Add Slack notifications and audit logging
- `supabase/functions/mollie-webhook/index.ts` — Add warning log on platform key fallback
- `supabase/functions/verify-mollie-payment/index.ts` — Add warning log on platform key fallback
- Database migration — Create `payment_audit_log` table
- `e2e/payments.spec.ts` — New E2E test file for payment flows

