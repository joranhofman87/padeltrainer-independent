

# Fix: Mollie Webhook Can't Fetch Invoice Payments (404)

## Root Cause
The webhook logs show exactly what's happening:

```
WARNING: Falling back to platform API key for payment lookup {"paymentId":"tr_uaPLtEcPU5woBBDN53sNJ"}
ERROR: Failed to fetch payment: 404 Not Found - "No payment exists with token tr_uaPLtEcPU5woBBDN53sNJ"
```

**The payment was created using the academy's connected OAuth token**, so it lives on the academy's Mollie account. The webhook only looks up bookings (line 176) to find a trainer and resolve the correct token. For invoice-only payments there's no booking, so `trainerId` is null, no token is resolved, and it falls back to the **platform API key** — which can't see payments on connected accounts → 404.

The invoice never gets marked as paid because the webhook crashes before it can even read the payment status.

## Fix

### `supabase/functions/mollie-webhook/index.ts`

After the booking lookup fails to find a trainer (line 184), add a fallback that checks the `invoices` table for the same `mollie_payment_id`. From the invoice, get the `academy_profile_id` or `trainer_id` and resolve the access token from their Mollie account.

```text
Current flow:
  1. Look up booking by payment ID → get trainer → resolve token
  2. If no booking found → fall back to platform key → 404

Fixed flow:
  1. Look up booking by payment ID → get trainer → resolve token
  2. If no booking → look up invoice by mollie_payment_id → get academy/trainer
  3. Resolve token from academy_mollie_accounts or trainer_mollie_accounts
  4. Only fall back to platform key if neither found
```

Specifically:
- After line 184, if `trainerId` is null, query `invoices` table for `mollie_payment_id = paymentId`
- If found, check `academy_profile_id` first → look up `academy_mollie_accounts` directly for the access token
- If no academy, check `trainer_id` → resolve via existing `resolveAccessToken`
- This ensures the webhook uses the correct connected-account token to fetch the payment from Mollie

### Files
- `supabase/functions/mollie-webhook/index.ts` — Add invoice-based token resolution before platform key fallback

